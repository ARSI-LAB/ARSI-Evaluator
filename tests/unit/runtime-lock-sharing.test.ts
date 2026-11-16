import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { acquireRuntimeLock } from "../../src/infrastructure/runtime-installation/lock.js";

async function withSharingLock(check: (path: string, release: () => Promise<void>, ready: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "evaluator-sharing-lock-"));
  const path = join(root, "inventory.lock"), ready = join(root, "ready"), finish = join(root, "finish");
  const release = await acquireRuntimeLock(path, AbortSignal.timeout(5000));
  const script = join(root, "hold.ps1");
  await writeFile(script, `param($LockPath, $ReadyPath, $FinishPath)
$stream = [IO.File]::Open($LockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  [IO.File]::WriteAllText($ReadyPath, 'ready')
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not [IO.File]::Exists($FinishPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 10 }
} finally { $stream.Dispose() }
`);
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", script, path, ready, finish], { windowsHide: true, stdio: "ignore" });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  try {
    const until = Date.now() + 4000;
    while (Date.now() < until) { try { await access(ready); break; } catch { await delay(10); } }
    await access(ready);
    await check(path, async () => { await writeFile(finish, "finish"); expect(await exited).toBe(0); await release(); }, ready);
  } finally {
    await writeFile(finish, "finish");
    await exited;
    await release();
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "win32")("a real Windows sharing lock does not invalidate a live owner's competing acquisition", async () => {
  await withSharingLock(async (path, release) => {
    let settled = false;
    const waiting = acquireRuntimeLock(path, AbortSignal.timeout(4000)).then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    await delay(200);
    const early = settled;
    await release();
    const result = await waiting;
    expect(early).toBe(false);
    expect("error" in result ? result.error : null).toBeNull();
    if ("value" in result) await result.value();
  });
});

test.skipIf(process.platform !== "win32")("cancellation interrupts a sharing-violation retry without reclaiming the live lock", async () => {
  await withSharingLock(async (path, release) => {
    const controller = new AbortController(), reason = new Error("cancel waiting for inventory");
    const waiting = acquireRuntimeLock(path, controller.signal).catch(error => error);
    await delay(100);
    controller.abort(reason);
    const result = await waiting;
    await release();
    expect(result).toBe(reason);
  });
});

test.skipIf(process.platform !== "win32")("a persistent sharing denial remains bounded and preserves its filesystem error", async () => {
  await withSharingLock(async (path, release) => {
    const started = Date.now();
    const result = await acquireRuntimeLock(path, AbortSignal.timeout(4000)).catch(error => error);
    const duration = Date.now() - started;
    await release();
    expect(result).toMatchObject({ code: expect.stringMatching(/^(EPERM|EACCES|EBUSY)$/) });
    expect(duration).toBeGreaterThanOrEqual(900);
    expect(duration).toBeLessThan(3000);
  });
});
