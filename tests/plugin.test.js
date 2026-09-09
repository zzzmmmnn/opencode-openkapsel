import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tool } from '@opencode-ai/plugin';
import plugin from '../index.js';
import { createTools } from '../lib/tools.js';
import { AGENT, READONLY_AGENT, validateEndpoint } from '../lib/bridge.js';
import { runHelper } from '../lib/transport.js';

function context(sessionID = 'session-1', ask = async () => {}) {
  return { sessionID, agent: AGENT, abort: new AbortController().signal, ask };
}
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-kapsel-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('remote-only guard follows the selected agent without restricting Build or Plan', async () => {
  const hooks = await plugin();
  const config = {};
  await hooks.config(config);
  assert.equal(config.default_agent, undefined);
  assert.equal(config.agent[AGENT].permission['*'], 'deny');
  assert.equal(config.agent[READONLY_AGENT].permission.kapsel_write, 'ask');
  assert.equal(config.permission.kapsel_config, 'deny');
  await hooks['chat.params']({ sessionID: 'local', agent: 'build' });
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'local' });
  await hooks['chat.params']({ sessionID: 'remote', agent: AGENT });
  for (const name of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'task', 'skill', 'run_code', 'execute', 'foreign_mcp', 'kapsel_escape']) {
    await assert.rejects(hooks['tool.execute.before']({ tool: name, sessionID: 'remote' }), /blocked/);
  }
  for (const name of [...Object.keys(hooks.tool), 'question', 'todowrite']) {
    await hooks['tool.execute.before']({ tool: name, sessionID: 'remote' });
  }
});

test('schemas reject string JSON and docs path traversal', async () => {
  const hooks = await plugin();
  assert.equal(tool.schema.object(hooks.tool.kapsel_http.args).safeParse({ method: 'PATCH', endpoint: 'context/plans/1', json: '' }).success, false);
  await assert.rejects(hooks.tool.kapsel_docs.execute({ topic: '../../etc/passwd' }, context()), /Unknown/);
  assert.match(await hooks.tool.kapsel_docs.execute({ topic: 'files' }, context()), /fs/);
});

test('endpoint traversal, scheme and control character checks', () => {
  for (const value of ['../admin', '%2e%2e/admin', '%252e%252e/admin', 'fs/%00', '//evil.test/x', 'file:///etc/passwd', '--output', 'fs\\..\\admin']) {
    assert.throws(() => validateEndpoint(value));
  }
  assert.equal(validateEndpoint('fs/list'), 'fs/list');
});

test('denied writes do not create Plans or invoke remote requests', async (t) => {
  let calls = 0;
  const tools = createTools({ stateRoot: await temp(t), transport: async () => { calls++; } });
  const ctx = { ...context('readonly', async () => { throw new Error('approval denied'); }), agent: READONLY_AGENT };
  for (const [name, args] of [
    ['kapsel_shell_exec', { command: 'touch x' }], ['kapsel_fs_write', { path: 'x', content: 'x' }],
    ['kapsel_http', { method: 'POST', endpoint: 'context', json: { type: 'plan' } }],
  ]) await assert.rejects(tools[name].execute(args, ctx), /approval denied/);
  assert.equal(calls, 0);
});

test('session Plans persist, remain isolated, and concurrent writes create only one Plan', async (t) => {
  const stateRoot = await temp(t);
  const calls = [];
  let nextPlan = 1;
  const transport = async (payload, options) => {
    calls.push({ payload, cwd: options.cwd });
    if (payload.endpoint === 'context') return { id: nextPlan++ };
    return { ok: true };
  };
  const tools = createTools({ stateRoot, transport });
  await Promise.all([1, 2].map(() => tools.kapsel_shell_exec.execute({ command: 'ls', message: 'Inspect' }, context())));
  assert.equal(calls.filter(c => c.payload.endpoint === 'context').length, 1);
  const resumed = createTools({ stateRoot, transport });
  await resumed.kapsel_fs_write.execute({ path: 'x', content: 'abc' }, context());
  assert.equal(calls.at(-1).payload.plan_id, 1);
  assert.equal(calls.at(-1).payload.taskname, 'opencode');
  await tools.kapsel_shell_exec.execute({ command: 'ls' }, context('session-2'));
  assert.equal(calls.at(-1).payload.plan_id, 2);
  assert.notEqual(calls[0].cwd, calls.at(-1).cwd);
  await tools.kapsel_plan_update.execute({ plan_id: 1, status: 'completed', debrief: { summary: 'Done', outcome: 'succeeded', memory_actions: [] } }, context());
  await tools.kapsel_shell_exec.execute({ command: 'ls' }, context());
  assert.equal(calls.at(-1).payload.plan_id, 3);
});

test('Python transport exercises real HTTP, dot paths, attribution, unicode and errors', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('fail')) { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'bad request' } })); return; }
    if (req.url.endsWith('/context')) { res.end(JSON.stringify({ id: 42 })); return; }
    if (req.url.includes('/text')) { res.setHeader('Content-Type', 'text/plain'); res.end('Hello 中文'); return; }
    if (req.url.includes('/redirect')) { res.statusCode = 302; res.setHeader('Location', '/escaped'); res.end(); return; }
    res.end(JSON.stringify({ name: 'Test', entries: ['a.txt'], capabilities: { shell: true }, authentication: { control_token_expires_at: new Date(Date.now() + 3 * 86400000).toISOString() } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const stateRoot = await temp(t);
  const tools = createTools({ stateRoot });
  const url = `http://127.0.0.1:${server.address().port}/kapsel/w/test_read`;
  const configured = await tools.kapsel_config.execute({ workspace_url: url, control_token: 'test_control' }, context());
  assert.doesNotMatch(configured, /test_read|test_control/);
  await tools.kapsel_fs_list.execute({ path: '.' }, context());
  assert.ok(calls.some(c => c.url.includes('path=.')));
  const command = "printf '你好'\n$(touch SHOULD_NEVER_RUN) `echo bad` \\ $HOME \u0000";
  await tools.kapsel_shell_exec.execute({ command }, context());
  assert.equal(calls.at(-1).body.command, command);
  assert.equal(calls.at(-1).body.plan_id, 42);
  assert.equal(calls.at(-1).body.taskname, 'opencode');
  assert.equal(calls.at(-1).auth, 'Bearer test_control');
  assert.equal(await tools.kapsel_http.execute({ method: 'GET', endpoint: 'text' }, context()), 'Hello 中文');
  await assert.rejects(tools.kapsel_http.execute({ method: 'GET', endpoint: 'fail' }, context()), /HTTP 400/);
  await assert.rejects(tools.kapsel_http.execute({ method: 'GET', endpoint: 'redirect' }, context()), /302/);
  assert.ok(!calls.some(c => c.url === '/escaped'));
  const before = calls.length;
  await assert.rejects(tools.kapsel_http.execute({ method: 'GET', endpoint: 'http://127.0.0.1:1/transfer/id' }, context()), /configured OpenKapsel origin/);
  assert.equal(calls.length, before);
  const directory = join(stateRoot, (await readdir(stateRoot))[0]);
  assert.match(await readFile(join(directory, '.openkapsel.env'), 'utf8'), /test_control/);
  await assert.rejects(tools.kapsel_status.execute({}, context('other-session')), /credential file/);
});

test('transport cancellation and response limit terminate the helper', async (t) => {
  const cwd = await temp(t);
  const signal = AbortSignal.abort();
  await assert.rejects(runHelper({ action: 'init' }, { cwd, signal }), /cancelled/);
  await assert.rejects(runHelper({ action: 'init', workspace_url: 'http://localhost/w/a', control_token: 'b' }, { cwd, maxBytes: 1 }), /output limit/);
});

test('automatic renewal persists new tokens, serializes calls, and redacts Discovery', async (t) => {
  let renewals = 0;
  let base;
  const auths = [];
  const server = createServer((req, res) => {
    auths.push(req.headers.authorization);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/credentials/renew')) {
      renewals++;
      res.end(JSON.stringify({ workspace_url: base + '/w/new_read', control_token: 'new_control', credentials_expires_at: new Date(Date.now() + 3 * 86400000).toISOString() }));
    } else res.end(JSON.stringify({
      name: 'Renewal test', control_token: renewals ? 'new_control' : 'old_control',
      workspace_url: base + '/w/' + (renewals ? 'new_read' : 'old_read'),
      authentication: { control_token_expires_at: new Date(Date.now() + 86400000).toISOString() },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}/kapsel`;
  const stateRoot = await temp(t);
  const tools = createTools({ stateRoot });
  await tools.kapsel_config.execute({ workspace_url: base + '/w/old_read', control_token: 'old_control' }, context());
  const results = await Promise.all([1, 2].map(() => tools.kapsel_http.execute({ method: 'GET', endpoint: '/' }, context())));
  assert.equal(renewals, 1);
  assert.equal(auths.at(-1), 'Bearer new_control');
  assert.doesNotMatch(results.join(''), /new_control|old_control|new_read|old_read/);
  assert.match(JSON.parse(results[0]).authentication.control_token_expires_at, /^\d{4}-\d{2}-\d{2}T/);
  const dir = join(stateRoot, (await readdir(stateRoot))[0]);
  assert.match(await readFile(join(dir, '.openkapsel.env'), 'utf8'), /new_control/);
});
