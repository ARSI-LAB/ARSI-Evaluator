import { expect, test } from "vitest";
import { startLocalProcess } from "../../src/infrastructure/process/local.js";

async function text(output: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of output) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("real child keeps stdin, both output streams and its exit status", async () => {
  const handle = await startLocalProcess({ executable: process.execPath,
    args: ["--input-type=module", "-e", "let text=''; for await (const x of process.stdin) text+=x; process.stdout.write(text); process.stderr.write('diagnostic'); process.exitCode=7;"],
    cwd: process.cwd(), env: {}, inheritEnv: false, input: Buffer.from("中文 input") }, AbortSignal.timeout(15_000));
  const [out, err, exit] = await Promise.all([text(handle.stdout), text(handle.stderr), handle.done]);
  expect(out).toBe("中文 input");
  expect(err).toBe("diagnostic");
  expect(exit.code).toBe(7);
}, 20_000);

test("stopping our live child still settles the process handle", async () => {
  const handle = await startLocalProcess({ executable: process.execPath,
    args: ["-e", "console.log('ready'); setInterval(()=>{},1000)"],
    cwd: process.cwd(), env: {}, inheritEnv: false, input: null }, AbortSignal.timeout(15_000));
  const ready = await handle.stdout[Symbol.asyncIterator]().next();
  expect(Buffer.from(ready.value ?? []).toString()).toContain("ready");
  await handle.stop(100);
  const exit = await handle.done;
  expect(exit.code === 0 && exit.signal === null).toBe(false);
}, 20_000);
