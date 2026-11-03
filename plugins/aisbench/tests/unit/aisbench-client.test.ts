import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseAisbenchSshConfig, parseWorkload } from "../../config.js";
import { AisbenchRemoteClient, aisbenchBaseUrl, parseCsv, sshArguments, shellQuote } from "../../ssh/client.js";

const config = { remote: { ssh: { host: "server", user: "bench" }, pythonExecutable: "/env/bin/python", aisbenchWorkPath: "/opt/benchmark", workRoot: "/data/jobs", aisbenchVersion: "1.0.0" }, tokenizerPath: "/weights/tokenizer" };

test("remote config rejects injection, unknown fields and relative server paths", () => {
  expect(parseAisbenchSshConfig(config).remote.ssh.port).toBe(22);
  for (const host of ["-oProxyCommand=evil", "server;evil", "a b"]) {
    expect(() => parseAisbenchSshConfig({ ...config, remote: { ...config.remote, ssh: { host, user: "bench" } } })).toThrow();
  }
  expect(() => parseAisbenchSshConfig({ ...config, tokenizerPath: "relative" })).toThrow();
  expect(() => parseAisbenchSshConfig({ ...config, password: "secret" })).toThrow();
});

test("cache workloads validate ratios and warmup prerequisites", () => {
  expect(parseWorkload({}).dataCount).toBe(160);
  expect(parseWorkload({ prefixCache: { enabled: true, prefixRatio: 0.5, warmup: true } }).prefixCache.warmup).toBe(true);
  for (const prefixCache of [{ prefixRatio: 1.1 }, { enabled: false, warmup: true }, { enabled: true, prefixRatio: 0 }, { seed: 1.5 }]) {
    expect(() => parseWorkload({ prefixCache })).toThrow();
  }
  expect(() => parseWorkload({ requestRate: -1 })).toThrow();
  expect(() => parseWorkload({ dataCount: 0 })).toThrow();
});

test("OpenSSH uses strict host checking and shell quotes remote arguments", () => {
  expect(sshArguments(parseAisbenchSshConfig(config).remote.ssh)).toEqual(expect.arrayContaining(["BatchMode=yes", "StrictHostKeyChecking=yes", "bench@server"]));
  expect(shellQuote("a'b")).toBe("'a'\"'\"'b'");
});

test("service endpoint is normalized before AISBench appends v1/chat/completions", () => {
  expect(aisbenchBaseUrl("http://server:8000/v1")).toBe("http://server:8000/");
  expect(aisbenchBaseUrl("https://server/proxy/v1/chat/completions")).toBe("https://server/proxy/");
  expect(() => aisbenchBaseUrl("http://user:secret@server/v1")).toThrow();
});

test("CSV preserves quoted cells and rejects incomplete measurements", () => {
  expect(parseCsv('name,value\n"test,a","1"\n')).toEqual([{ name: "test,a", value: "1" }]);
  expect(() => parseCsv("name,value\n")).toThrow();
  expect(() => parseCsv("a,a\n1,2\n")).toThrow();
  expect(() => parseCsv('a,b\n"unterminated')).toThrow();
});

test("downloads verify content hashes before publishing and reject traversal", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/aisbench-download-"));
  const content = Buffer.from("name,value\ntest,123\n");
  const hash = createHash("sha256").update(content).digest("hex");
  let path = "aisbench_result.csv", sha256 = hash;
  const client = new AisbenchRemoteClient(parseAisbenchSshConfig(config), "a".repeat(64), async (_command, request) => {
    const r = request as Record<string, unknown>;
    return r.action === "manifest" ? { schemaVersion: 1, files: [{ path, sha256, size: content.length }] } : { schemaVersion: 1, data: content.toString("base64"), nextOffset: content.length };
  });
  try {
    await client.download("/remote/job", "fingerprint", root, new AbortController().signal);
    expect(await readFile(join(root, path), "utf8")).toBe(content.toString());
    sha256 = "0".repeat(64);
    await expect(client.download("/remote/job", "fingerprint", root, new AbortController().signal)).rejects.toThrow(/digest/);
    expect(await readFile(join(root, path), "utf8")).toBe(content.toString());
    path = "../escape";
    await expect(client.download("/remote/job", "fingerprint", root, new AbortController().signal)).rejects.toThrow(/Unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reconnect retries the same start identity after a lost SSH response", async () => {
  const requests: unknown[] = [];
  const client = new AisbenchRemoteClient(parseAisbenchSshConfig(config), "a".repeat(64), async (_command, request) => {
    requests.push(request);
    if (requests.length === 1) throw new Error("response lost after dispatch");
    return { schemaVersion: 1, state: "running" };
  });
  const result = await client.call("start", "/remote/job", "fingerprint", { restartToken: "attempt-1" }, new AbortController().signal);
  expect(result.state).toBe("running");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
});

test("aborted calls never dispatch remote work", async () => {
  let dispatched = false;
  const client = new AisbenchRemoteClient(parseAisbenchSshConfig(config), "a".repeat(64), async () => { dispatched = true; return {}; });
  const controller = new AbortController(); controller.abort();
  await expect(client.call("start", "/remote/job", "fingerprint", {}, controller.signal)).rejects.toThrow();
  expect(dispatched).toBe(false);
});
