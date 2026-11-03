import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { create as createTar } from "tar";

export const contentDigest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A registry reachable only through this HTTP forward proxy, including a real gzip layer. */
export async function registryProxyFixture(root: string, wrongDiffId = false) {
  const layerRoot = join(root, "fixture-layer");
  await mkdir(layerRoot);
  await writeFile(join(layerRoot, "hello.txt"), "verified image\n");
  const layerTar = join(root, "fixture-layer.tar");
  await createTar({ cwd: layerRoot, file: layerTar, portable: true }, ["hello.txt"]);
  const unpacked = await readFile(layerTar);
  const layer = gzipSync(unpacked);
  const origin = "http://127.0.0.1:9";
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: {},
    rootfs: { type: "layers", diff_ids: [wrongDiffId ? `sha256:${"f".repeat(64)}` : contentDigest(unpacked)] } }));
  const configDigest = contentDigest(config);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: contentDigest(layer), size: layer.length }] }));
  const manifestDigest = contentDigest(manifest);
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: manifestDigest, size: manifest.length, platform: { os: "linux", architecture: "amd64" } },
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${"a".repeat(64)}`, size: 20, platform: { os: "linux", architecture: "arm64", variant: "v8" } },
  ] }));
  const requests: { path: string; host: string | undefined; authorization: string | undefined; proxyAuthorization: string | undefined; method: string | undefined }[] = [];
  const controls = { corruptLayer: false, useIndex: true, auth: false, basicAuth: false,
    failToken: false, delayLayer: false, redirectLayer: "", requireProxyAuth: false,
    transientPath: "", transientFailures: 0, disconnectLayerOnce: false };
  const proxy = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? ""); } catch { response.writeHead(400).end(); return; }
    const path = url.pathname;
    requests.push({ path, host: request.headers.host, authorization: request.headers.authorization, proxyAuthorization: request.headers["proxy-authorization"] as string | undefined, method: request.method });
    if (path === controls.transientPath && controls.transientFailures > 0) {
      controls.transientFailures--; response.writeHead(503).end(); return;
    }
    if (controls.requireProxyAuth && request.headers["proxy-authorization"] !== `Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`) {
      response.writeHead(407).end(); return;
    }
    if (path === "/token") {
      response.writeHead(controls.failToken ? 403 : 200, { "content-type": "application/json" }).end(JSON.stringify({ token: "registry-token" }));
      return;
    }
    if (path === "/external") { response.writeHead(200, { "content-length": layer.length }).end(layer); return; }
    if (controls.auth && request.headers.authorization !== "Bearer registry-token" || controls.basicAuth && request.headers.authorization !== `Basic ${Buffer.from("user:password").toString("base64")}`) {
      response.writeHead(401, { "www-authenticate": controls.basicAuth ? 'Basic realm="registry"' : `Bearer realm="${origin}/token",service="fixture"` }).end();
      return;
    }
    let data: Buffer;
    if (path.includes("/manifests/")) {
      data = path.endsWith(manifestDigest) || !controls.useIndex ? manifest : index;
      response.setHeader("docker-content-digest", contentDigest(data));
    } else if (path.endsWith(configDigest)) data = config;
    else if (path.endsWith(contentDigest(layer))) {
      if (controls.redirectLayer) { response.writeHead(307, { location: controls.redirectLayer }).end(); return; }
      data = controls.corruptLayer ? Buffer.alloc(layer.length, 1) : layer;
      if (controls.disconnectLayerOnce) {
        controls.disconnectLayerOnce = false;
        response.writeHead(200, { "content-length": data.length }); response.write(data.subarray(0, 1));
        setImmediate(() => response.destroy()); return;
      }
      if (controls.delayLayer) {
        response.writeHead(200, { "content-length": data.length });
        response.write(data.subarray(0, 1));
        return;
      }
    } else { response.writeHead(404).end(); return; }
    response.setHeader("content-length", data.length);
    response.end(data);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind");
  return { proxy: `http://127.0.0.1:${address.port}`, reference: `127.0.0.1:9/example/image@${contentDigest(index)}`,
    indexDigest: contentDigest(index), configDigest, manifestDigest, config, manifest, index, layer, unpacked, controls, requests,
    async close() {
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    } };
}
