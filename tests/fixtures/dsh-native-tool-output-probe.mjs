import { createServer } from 'node:http';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const cli = '/opt/evaluator-agent/node_modules/@deepseek-ai/dsh/lib/bin.js';
let request = 0;
const server = createServer(async (req, res) => {
  for await (const ignored of req) { void ignored; }
  request++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, reason) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
    model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: reason }] });
  const command = `node -e "process.stdout.write('controlled output fixture\\n'.repeat(20000))"`;
  const delta = request % 2 === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Controlled generic output fixture' }) } }] }
    : { role: 'assistant', content: 'fixture complete' };
  res.end('data: ' + JSON.stringify(chunk(delta, null)) + '\n\ndata: ' +
    JSON.stringify(chunk({}, request % 2 === 1 ? 'tool_calls' : 'stop')) + '\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
function launch(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes);
    child.stderr.on('data', bytes => stderr += bytes);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const rows = [];
try {
  for (const mode of ['linux', 'windows', 'blocked-export']) {
    try {
    const home = '/tmp/dsh-large-output-' + mode;
    const output = mode === 'windows' ? '/logs/agent' : home + '/output';
    await mkdir(home);
    if (mode === 'blocked-export') await writeFile(output, 'controlled blocked export directory');
    else await mkdir(output, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1', EMBER_EVALUATOR_API_KEY: 'fixture-key', EVALUATOR_DSH_OUTPUT_DIR: output };
    const setup = await launch([cli, '--profile', 'evaluator', '--from-default-profile', 'headless', '--dump-config'], env);
    if (setup.code !== 0) throw Error('Fixture setup failed');
    const patch = [{ id: 'agent-default-model', config: { provider: 'fixture', model: 'fixture-model' } },
      { id: 'llm-pi-ai', config: { providers: { fixture: { apiKeyEnv: 'EMBER_EVALUATOR_API_KEY',
        baseURL: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions',
        models: [{ id: 'fixture-model', maxTokens: 1024 }] } } } },
      { id: 'session-title-llm', disabled: true }, { id: 'approval', config: { policy: 'never' } }];
    await writeFile(home + '/model.yaml', JSON.stringify(patch));
    const result = await launch(['--import', '/diagnosis/output-hook.mjs', cli, '--profile', 'evaluator', '--patch',
      home + '/model.yaml', '--json'], env, 'Use bash to print the controlled fixture output.');
    const records = result.stdout.trim().split('\n').map(JSON.parse);
    rows.push({ mode, exitCode: result.code, recordTypes: records.map(r => r.type === 'status' ? r.phase : r.type),
      toolResults: records.filter(r => r.type === 'tool_result').map(r => ({ status: r.status, truncated: r.truncated,
        storedBytes: r.storedBytes, hasResultRef: typeof r.resultRef === 'string' })),
      outputFiles: mode === 'blocked-export' ? [] : await readdir(output), stderr: result.stderr.slice(-1800),
      exportErrors: records.filter(r => r.type === 'error').map(r => ({ code: r.code, message: r.message })) });
    } catch (error) { rows.push({ mode, errorCode: error.code, errorMessage: error.message }); }
  }
  console.log(JSON.stringify({ rows, requests: request, realProviderCalled: false, scoringPerformed: false }));
} finally { await new Promise(resolve => server.close(resolve)); }
