import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const inject = ["evaluator"];
// Empty submission intentionally exercises infrastructure, not model quality.
export function apply(ctx) {
  ctx.evaluator.register("solver", "office-smoke", value => value, (config, runtime) => ({
    requirements: () => [],
    async solve(_task, session, context) {
      const process = await session.start({ executable: "sh", args: ["-c", "test ! -e /tests"], cwd: session.workdir, env: {}, input: null }, context.signal);
      const drain = async stream => { for await (const _chunk of stream) { /* drain */ } };
      const [exit] = await Promise.all([process.done, drain(process.stdout), drain(process.stderr)]);
      if (exit.code !== 0) throw new Error("Hidden tests visible to solver");
      const event = (seq, type) => JSON.stringify({ schemaVersion: 1, key: context.key, seq, at: new Date().toISOString(), type, data: null }) + "\n";
      await writeFile(join(context.paths.agent, "trajectory.jsonl"), event(1, "start") + event(2, "end"));
      await writeFile(join(context.paths.agent, "session.jsonl"), '{"fixture":true}\n');
      if (config.waitOnce) {
        let wait = false;
        try { await writeFile(join(runtime.configDirectory, "office-wait-once.marker"), context.key.attemptId, { flag: "wx" }); wait = true; }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        if (wait) await new Promise((resolve, reject) => {
          if (context.signal.aborted) reject(context.signal.reason);
          else context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      }
      return { finalText: "Empty infrastructure smoke submission", usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
    },
  }));
}
