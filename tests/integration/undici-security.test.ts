import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const exec = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function serverOrigin(): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/excessive-encodings") {
      response.writeHead(200, {
        "content-encoding": "gzip, gzip, gzip, gzip, gzip, gzip",
        "content-length": "100",
        connection: "close",
      });
      response.end();
    } else {
      response.end("expected body");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function runClient(origin: string, implementation: string, code: string): Promise<void> {
  // A vulnerable fetch can terminate the process after its rejection was caught.
  // Keep the client in a subprocess so that this is asserted as a test failure.
  const result = await exec(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    const origin = process.argv[1];
    const fetch = ${implementation};
    ${code}
    console.log("verified");
  `, origin], {
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NODE_USE_ENV_PROXY: "0" },
  });
  expect(result.stdout.trim()).toBe("verified");
  expect(result.stderr).toBe("");
}

const implementations = [
  { name: "npm undici", expression: '(await import("undici")).fetch' },
  { name: "Node.js built-in fetch", expression: "globalThis.fetch" },
];

test.each(implementations)("$name rejects mismatched SRI with uppercase and mixed-case algorithms", async ({ expression }) => {
  await runClient(await serverOrigin(), expression, `
    const { createHash } = await import("node:crypto");
    for (const algorithm of ["sha256", "SHA256", "Sha256", "sha384", "SHA384", "Sha384", "sha512", "SHA512", "Sha512"]) {
      const digest = body => createHash(algorithm.toLowerCase()).update(body).digest("base64");
      const valid = await fetch(origin, { integrity: algorithm + "-" + digest("expected body") });
      assert.equal(await valid.text(), "expected body");
      await assert.rejects(fetch(origin, { integrity: algorithm + "-" + digest("different body") }),
        error => error.cause?.message === "integrity mismatch");
    }
  `);
});

test.each(implementations)("$name survives excessive content encodings and a truncated response", async ({ expression }) => {
  await runClient(await serverOrigin(), expression, `
    await assert.rejects(fetch(origin + "/excessive-encodings"),
      error => /content-encoding/i.test(error.cause?.message ?? ""));
    await new Promise(resolve => setTimeout(resolve, 100));
    const response = await fetch(origin);
    assert.equal(await response.text(), "expected body");
  `);
});
