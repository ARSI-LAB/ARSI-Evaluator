import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { buildFileManifest, fingerprintConfig } from 'ember-evaluator';
export const inject = ['evaluator'];
const source = { source: 'ray-fixture', revision: 'v1', files: [], metadata: {} };
export function apply(ctx) {
  ctx.evaluator.register('benchmark', 'ray-fixture', value => value, (config, runtime) => ({
    async planRun(refs, _source, signal) {
      const tasks = [];
      for (const ref of refs) { signal.throwIfAborted(); tasks.push(await this.prepare(ref)); }
      return { tasks, preparation: { defaultTimeoutSeconds: config.preparationTimeoutSeconds ?? 120 }, policy: { version: 'batch-v1', source: 'ray-fixture' } };
    },
    async resolveSource() { return source; },
    async *enumerate() { for (let i = 0; i < 6; i++) yield { id: `task-${i}`, recordKey: i }; },
    async prepare(ref) {
      if (config.failNodePreparation && process.env.EVALUATOR_NODE_CONFIG && ref.id === 'task-1') throw new Error('Injected node preparation failure');
      if (config.imagePreparation) {
        const context = runtime.resolvePath(`contexts/${ref.id}`);
        await mkdir(context, { recursive: true });
        await writeFile(join(context, 'Dockerfile'), `FROM node:24.22.1-bookworm-slim\nWORKDIR /workspace\nRUN echo ${ref.id} > /task-marker\n`);
        const manifest = await buildFileManifest(context, []);
        return { input: { id: ref.id, prompt: 'Write durable evidence' }, verification: {},
          solveEnv: { workdir: '/workspace', image: null, initialFiles: [], runtime: [],
            build: { context, dockerfile: 'Dockerfile', sourceHash: fingerprintConfig(manifest.files) } }, verifyEnv: null, transfer: null };
      }
      return { input: { id: ref.id, prompt: 'Write durable evidence' }, verification: {}, solveEnv: { workdir: '.', image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null }; },
    async verify() { return { score: 1, passed: true, details: {} }; },
  }));
  ctx.evaluator.register('solver', 'ray-fixture', value => value, (config, runtime) => ({
    requirements: () => [],
    ...(config.installRuntime ? { async runtimeInstallation() { return { id: 'ray-warmup-fixture', files: [],
      commands: [{ executable: 'node', args: ['-e', "require('node:fs').writeFileSync('installed', 'ready')"] }],
      probes: [{ executable: 'node', args: ['-e', "if(require('node:fs').readFileSync('installed','utf8')!=='ready') throw Error('missing installation')"] }] }; } } : {}),
    ...(config.candidate === undefined ? {} : { async provenance() { return { bundle: config.candidate }; } }),
    async solve(input, _session, context) {
      if (Object.values(process.env).includes(runtime.services[runtime.solverService].auth.value)) throw new Error('Model credential inherited through worker environment');
      if (config.countSolves) {
        const path = join(runtime.configDirectory, 'solve-count.txt');
        const count = Number(await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? '0' : Promise.reject(error)));
        await writeFile(path, String(count + 1));
      }
      const event = (seq, type) => JSON.stringify({ schemaVersion: 1, key: context.key, seq, at: new Date().toISOString(), type, data: null }) + '\n';
      await writeFile(join(context.paths.agent, 'trajectory.jsonl'), event(1, 'start'));
      await writeFile(join(context.paths.artifacts, 'worker.json'), JSON.stringify({ hostname: hostname(), pid: process.pid, taskId: input.id }));
      if (config.crashOnce) {
        let crash = false;
        try { await writeFile(join(runtime.configDirectory, 'crash-once.marker'), input.id, { flag: 'wx' }); crash = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (crash) process.exit(17);
      }
      let wait = Boolean(config.waitAlways);
      if (config.waitOnce) {
        try { await writeFile(join(runtime.configDirectory, 'wait-once.marker'), 'started', { flag: 'wx' }); wait = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (wait) await new Promise((resolve, reject) => {
        if (context.signal.aborted) reject(context.signal.reason);
        else context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true });
      });
      await writeFile(join(context.paths.agent, 'trajectory.jsonl'), event(1, 'start') + event(2, 'end'));
      await writeFile(join(context.paths.agent, 'session.jsonl'), '{"fixture":true}\n');
      return { finalText: 'done', usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
    },
  }));
}
