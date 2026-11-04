import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { getGlobalDispatcher } from "undici";
import { loadNetworkConfig, networkDocument, networkSnapshot, parseNetworkSettings, redactNetwork, restoreNetworkTemplate } from "../../src/config/network.js";
import { NetworkRuntime } from "../../src/adapters/network/runtime.js";
import { mirrorImageReference } from "../../src/adapters/containers/registry-image.js";

afterEach(() => vi.unstubAllEnvs());

test("explicit YAML ignores inherited source/proxy settings and expands only requested variables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "network-config-"));
  try {
    const path = join(directory, "network.yaml");
    await writeFile(path, 'version: 1\nproxy:\n  https: ${NODE_PROXY}\nsources:\n  huggingface: https://hub.test\n');
    const document = await loadNetworkConfig(path, { NODE_PROXY: "http://proxy.test:8080", HTTP_PROXY: "http://ignored.test", HF_ENDPOINT: "https://ignored.test" });
    expect(document.settings.proxy.host).toEqual({ http: null, https: "http://proxy.test:8080", noProxy: [] });
    expect(document.settings.sources.huggingface).toBe("https://hub.test");
    expect(document.settings.sources.npm.registry).toBe("https://registry.npmjs.org");
    await expect(loadNetworkConfig(path, {})).rejects.toThrow("NODE_PROXY");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("proxy overrides preserve explicit null and have independent noProxy arrays", () => {
  const settings = parseNetworkSettings({ version: 1, proxy: { http: "http://host.test:1", https: "http://host.test:2", noProxy: ["localhost"],
    overrides: { build: { https: "http://build.test:3" }, runtime: null } } });
  expect(settings.proxy.build).toEqual({ http: "http://host.test:1", https: "http://build.test:3", noProxy: ["localhost"] });
  expect(settings.proxy.runtime).toEqual({ http: null, https: null, noProxy: [] });
  expect(settings.proxy.build.noProxy).not.toBe(settings.proxy.host.noProxy);
});

test("registry mirrors preserve image identity and match only the original registry", () => {
  const mirrors = { "docker.io": "https://docker.1panel.live/" };
  expect(mirrorImageReference("ubuntu:24.04", mirrors)).toBe("docker.1panel.live/library/ubuntu:24.04");
  const digest = `sha256:${"a".repeat(64)}`;
  expect(mirrorImageReference(`node@${digest}`, mirrors)).toBe(`docker.1panel.live/library/node@${digest}`);
  expect(mirrorImageReference("ghcr.io/team/image:1", mirrors)).toBe("ghcr.io/team/image:1");
});

test("archive requires a download root and rejects the removed catalog format", () => {
  const document = networkDocument({ version: 1, docker: { pull: { method: "registry-client", backend: "skopeo" },
    benchmarks: { terminalbench: { method: "archive", provider: "modelscope", baseUrl: "https://modelscope.cn/datasets/team/images/resolve/master/terminalbench4.0/" } } } }, {});
  expect(document.settings.docker.pull).toEqual({ method: "registry-client", backend: "skopeo", skopeoExecutable: "skopeo" });
  expect(document.settings.docker.benchmarks.terminalbench).toEqual({ method: "archive", provider: "modelscope",
    baseUrl: "https://modelscope.cn/datasets/team/images/resolve/master/terminalbench4.0" });
  for (const config of [{ catalogs: { modelscope: "https://example.test/catalog.json" } }, { baseUrl: "" }, {}])
    expect(() => parseNetworkSettings({ version: 1, docker: { benchmarks: {
      terminalbench: { method: "archive", provider: "modelscope", ...config },
    } } })).toThrow();
  for (const docker of [{ pull: { method: "archive" } }, { pull: { method: "registry-client", backend: "unknown" } },
    { pull: { method: "docker", backend: "nodejs" } }, { registryMirrors: [] }])
    expect(() => parseNetworkSettings({ version: 1, docker })).toThrow();
});

test("credentials are redacted and Ray expands proxy references on the receiving node", () => {
  const runtime = new NetworkRuntime(networkDocument({ version: 1, proxy: { https: "${NODE_PROXY}" } }, { NODE_PROXY: "http://user:host-secret@127.0.0.1:1" }));
  expect(JSON.stringify(redactNetwork(runtime.settings))).not.toContain("host-secret");
  const snapshot = networkSnapshot(runtime, "terminalbench");
  expect(JSON.stringify(snapshot)).not.toContain("host-secret");
  expect(restoreNetworkTemplate(snapshot.template, { NODE_PROXY: "http://node-proxy:2" }).settings.proxy.host.https).toBe("http://node-proxy:2");
  const literal = new NetworkRuntime(networkDocument({ version: 1, proxy: { https: "http://user:secret@proxy.test:1" } }, {}));
  expect(() => networkSnapshot(literal, "terminalbench")).toThrow("node-local");
});

test("installer environments remove inherited network values and use container config paths", () => {
  const runtime = new NetworkRuntime(networkDocument({ version: 1 }, {}));
  const env = runtime.environment("runtime", { PATH: "/bin", PIP_INDEX_URL: "https://ignored.test", HTTPS_PROXY: "http://ignored.test", UV_PYTHON_INSTALL_MIRROR: "https://ignored.test" }, "container");
  expect(env.PATH).toBe("/bin");
  expect(env.HTTPS_PROXY).toBe("");
  expect(env.PIP_INDEX_URL).toBe("https://pypi.org/simple");
  expect(env.PIP_CONFIG_FILE).toBe("/dev/null");
  expect(env.UV_PYTHON_INSTALL_MIRROR).toBeUndefined();
});

test("concurrent HTTP instances keep endpoints and dispatchers separate, including redirects", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { location: "/final" }).end();
    else response.end(request.url);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const global = getGlobalDispatcher();
  vi.stubEnv("HTTP_PROXY", "http://unreachable.invalid:1");
  const first = new NetworkRuntime(networkDocument({ version: 1, sources: { github: { raw: origin + "/one" } } }, {}));
  const second = new NetworkRuntime(networkDocument({ version: 1, sources: { github: { raw: origin + "/two" } } }, {}));
  try {
    const values = await Promise.all([first, second].map(async runtime => (await runtime.fetch(runtime.sourceUrl("https://raw.githubusercontent.com/test"))).text()));
    expect(values).toEqual(["/one/test", "/two/test"]);
    const response = await first.fetch(origin + "/redirect");
    expect(response.redirected).toBe(true); expect(await response.text()).toBe("/final");
    expect(getGlobalDispatcher()).toBe(global);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
