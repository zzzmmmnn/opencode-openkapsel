// Optional real OpenCode integration: mock inference and workspace HTTP only.
// No model credentials, external server, or paid model requests are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, access, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('real OpenCode loads agents and executes remote tools with mock inference', { skip: !process.env.OPENKAPSEL_RUNTIME_TEST, timeout: 360_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-kapsel-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const work = join(dir, 'work');
  await mkdir(work);
  const configDir = join(dir, 'config', 'opencode');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.18.21' } }));
  await cp(new URL('../package-lock.json', import.meta.url), join(configDir, 'package-lock.json'));
  await cp(new URL('../node_modules/', import.meta.url), join(configDir, 'node_modules'), { recursive: true });
  let base;
  let turn = 0;
  const remote = [];
  const catalog = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (!req.url.includes('/chat/completions')) {
      remote.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url.endsWith('/context') ? { id: 7 } : req.url.endsWith('/shell/exec') ? { task_id: 'remote-task' } : {
        name: 'Runtime test', capabilities: { shell: true },
        authentication: { control_token_expires_at: new Date(Date.now() + 3 * 86400000).toISOString() },
      }));
      return;
    }
    let call;
    if (body.tools?.length) {
      catalog.push(body.tools.map(t => t.function.name));
      if (turn === 0) call = { name: 'kapsel_config', arguments: JSON.stringify({ workspace_url: base + '/w/read_test', control_token: 'control_test' }) };
      if (turn === 1) call = { name: 'kapsel_shell_exec', arguments: JSON.stringify({ command: 'echo remote-only', message: 'Verify remote shell' }) };
      if (turn === 2) call = { name: 'bash', arguments: JSON.stringify({ command: 'touch LOCAL_ESCAPE', description: 'Adversarial test' }) };
      turn++;
    }
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + turn, type: 'function', function: call }] } : { role: 'assistant', content: 'Runtime test complete.' };
    const finish = call ? 'tool_calls' : 'stop';
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      for (const [d, reason] of [[delta, null], [{}, finish]]) {
        res.write('data: ' + JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: d, finish_reason: reason }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'chatcmpl_test', model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: 'Test' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const config = {
    plugin: [new URL('../index.js', import.meta.url).href],
    provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Test', options: { baseURL: base + '/v1', apiKey: 'test' }, models: { test: { name: 'Test', limit: { context: 128000, output: 8192 }, tool_call: true } } } },
    model: 'fixture/test', small_model: 'fixture/test',
  };
  const env = { ...process.env,
    HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'), XDG_STATE_HOME: join(dir, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  const child = spawn(process.env.OPENKAPSEL_OPENCODE_BIN || 'opencode', ['run', '--print-logs', '--log-level', 'DEBUG', '--model', 'fixture/test', '--agent', 'OpenKapsel', '--format', 'json', 'Exercise the remote workspace.'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 320_000);
  t.after(() => { clearTimeout(timer); child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr + stdout);
  assert.ok(catalog.length >= 3, stderr + stdout);
  assert.ok(catalog.every(names => !names.includes('bash') && !names.includes('read') && !names.includes('task')), JSON.stringify(catalog));
  assert.ok(remote.some(r => r.url.endsWith('/shell/exec') && r.body.command === 'echo remote-only' && r.body.plan_id === 7), stdout);
  await assert.rejects(access(join(work, 'LOCAL_ESCAPE')));
});
