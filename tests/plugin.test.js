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
  assert.match(await hooks.tool.kapsel_docs.execute({ topic: 'mappings' }, context()), /Client-backed directories/);
});

test('endpoint traversal, scheme and control character checks', () => {
  for (const value of ['../admin', '%2e%2e/admin', '%252e%252e/admin', 'fs/%00', '//evil.test/x', 'file:///etc/passwd', '--output', 'fs\\..\\admin']) {
    assert.throws(() => validateEndpoint(value));
  }
  assert.equal(validateEndpoint('fs/list'), 'fs/list');
});

test('Python helper transport explicitly uses UTF-8 on every platform', async () => {
  const source = await readFile(new URL('../lib/transport.js', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../lib/runner.py', import.meta.url), 'utf8');
  assert.match(source, /'-X', 'utf8'/);
  assert.match(runner, /sys\.stdin\.reconfigure\(encoding='utf-8', errors='strict'\)/);
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

test('read RPCs bypass mutation approval, not write authorization', async (t) => {
  const calls = [];
  const mappingId = 'abcdefghijklmnopqrstuvwx';
  const tools = createTools({ stateRoot: await temp(t), transport: async payload => {
    calls.push(payload);
    if (payload.endpoint === 'mappings') return { mappings: [{
      id: mappingId, name: 'laptop', writable: true,
      capabilities: { rpc: { vendor: {
        state: 'available', version: 1,
        operations: ['inspect'],
        operation_specs: { inspect: {
          description: 'Inspect one integer.',
          input_schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
          write: false,
        } },
      } } },
    }] };
    return { ok: true };
  } });
  const ctx = { ...context('rpc-readonly', async () => { throw new Error('approval denied'); }), agent: READONLY_AGENT };
  for (const [name, args] of [
    ['kapsel_git', { action: 'status' }], ['kapsel_fs_read_many', { paths: ['a'] }],
    ['kapsel_fs_manifest', { recursive: true }],
    ['kapsel_fs_search', { query: 'text', include: ['*.py', '*.js'] }],
    ['kapsel_http', { method: 'POST', endpoint: 'fs/read_many', json: { paths: ['a'] } }],
    ['kapsel_http', { method: 'POST', endpoint: 'fs/manifest', json: { items: [{ path: 'a' }] } }],
    ['kapsel_archive', { action: 'list', path: 'laptop/sample.zip' }],
    ['kapsel_rpc', { mapping_id: mappingId, family: 'vendor', operation: 'inspect', args: { value: 7 } }],
    ['kapsel_http', { method: 'POST', endpoint: `mappings/${mappingId}/rpc/vendor/inspect`, json: { args: { value: 8 } } }],
  ]) await tools[name].execute(args, ctx);
  assert.equal(calls.length, 11);
  assert.ok(calls.every(c => !c.plan_id && c.endpoint !== 'context'));
  assert.deepEqual(calls[3].query.include, ['*.py', '*.js']);
  await assert.rejects(tools.kapsel_http.execute({ method: 'POST', endpoint: 'fs/read_many/../write', json: {} }, ctx));
  assert.equal(calls.length, 11);
});

test('client mapping tools route reads, mutations, and task controls through the approved bridge', async (t) => {
  const calls = [];
  let approvals = 0;
  const transport = async (payload) => {
    calls.push(payload);
    if (payload.endpoint === 'context') return { id: 7 };
    if (payload.endpoint === 'mappings') return { mappings: [{
      id: 'abcdefghijklmnopqrstuvwx',
      name: 'laptop',
      writable: true,
      capabilities: { rpc: { vendor: {
        state: 'available', version: 1, read_only: false,
        description: 'Inspect or update vendor metadata.',
        operations: ['inspect', 'update'],
        operation_specs: {
          inspect: {
            description: 'Inspect one integer.',
            input_schema: {
              type: 'object', properties: { value: { type: 'integer' } },
              required: ['value'], additionalProperties: false,
            },
            write: false,
          },
          update: {
            description: 'Update one integer.',
            input_schema: {
              type: 'object', properties: { value: { type: 'integer' } },
              required: ['value'], additionalProperties: false,
            },
            write: true,
          },
        },
      } } },
    }] };
    return { ok: true, id: 'transfer-id' };
  };
  const tools = createTools({ stateRoot: await temp(t), transport });
  const ctx = context('mapping-session', async () => { approvals++; });
  const mappingId = 'abcdefghijklmnopqrstuvwx';
  const taskId = 'client-task-1234';
  const mutation = { taskname: 'mapping', message: 'test mapped storage' };

  const mappings = JSON.parse(await tools.kapsel_mappings.execute({}, ctx));
  assert.equal(calls.at(-1).endpoint, 'mappings');
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(mappings.mappings[0].capabilities.rpc.vendor.description, 'Inspect or update vendor metadata.');
  assert.equal(
    mappings.mappings[0].capabilities.rpc.vendor.operation_specs.inspect.input_schema.properties.value.type,
    'integer',
  );
  assert.equal(mappings.mappings[0].capabilities.rpc.vendor.operation_specs.inspect.write, false);
  assert.equal(mappings.mappings[0].capabilities.rpc.vendor.operation_specs.update.write, true);

  await tools.kapsel_rpc.execute({
    mapping_id: mappingId, family: 'vendor', operation: 'inspect', args: { value: 1 },
  }, ctx);
  assert.equal(calls.at(-1).endpoint, `mappings/${mappingId}/rpc/vendor/inspect`);
  const approvalsBeforeRpcWrite = approvals;
  await tools.kapsel_rpc.execute({
    mapping_id: mappingId, family: 'vendor', operation: 'update', args: { value: 2 },
    taskname: 'mapping', message: 'update vendor metadata',
  }, ctx);
  assert.equal(calls.at(-1).endpoint, `mappings/${mappingId}/rpc/vendor/update`);
  assert.equal(calls.at(-1).plan_id, 7);
  assert.equal(calls.at(-1).taskname, 'mapping');
  assert.equal(calls.at(-1).message, 'update vendor metadata');
  assert.equal(approvals, approvalsBeforeRpcWrite + 1);

  await tools.kapsel_fs_copy.execute({ source: 'file.txt', destination: 'laptop/file.txt', ...mutation }, ctx);
  assert.deepEqual(calls.at(-1).json, { source: 'file.txt', destination: 'laptop/file.txt' });
  assert.equal(calls.at(-1).endpoint, 'fs/copy');
  assert.equal(calls.at(-1).plan_id, 7);
  assert.equal(calls.at(-1).taskname, 'mapping');
  assert.equal(calls.at(-1).message, 'test mapped storage');
  await tools.kapsel_fs_move.execute({ source: 'laptop/file.txt', destination: 'file.txt' }, ctx);
  assert.equal(calls.at(-1).endpoint, 'fs/move');
  assert.equal(calls.at(-1).plan_id, 7);

  await tools.kapsel_transfer.execute({ transfer_id: 'transfer-id', action: 'status' }, ctx);
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).endpoint, 'fs/transfers/transfer-id');
  for (const action of ['cancel', 'resume']) {
    await tools.kapsel_transfer.execute({ transfer_id: 'transfer-id', action }, ctx);
    assert.equal(calls.at(-1).method, 'POST');
    assert.equal(calls.at(-1).endpoint, `fs/transfers/transfer-id/${action}`);
  }
  await tools.kapsel_recycle.execute({ action: 'list', root: 'laptop', offset: 2, limit: 10 }, ctx);
  assert.deepEqual(calls.at(-1).query, { root: 'laptop', offset: 2, limit: 10 });
  await tools.kapsel_recycle.execute({ action: 'restore', root: 'laptop', recycle_id: 'recycle-1' }, ctx);
  assert.equal(calls.at(-1).endpoint, 'recycle/restore');
  assert.equal(calls.at(-1).json.root, 'laptop');
  const beforeUnconfirmedPurge = calls.length;
  await assert.rejects(tools.kapsel_recycle.execute({ action: 'purge', recycle_id: 'recycle-1' }, ctx), /confirm=true/);
  assert.equal(calls.length, beforeUnconfirmedPurge);
  await tools.kapsel_recycle.execute({ action: 'purge', root: 'laptop', recycle_id: 'recycle-1', confirm: true }, ctx);
  assert.equal(calls.at(-1).endpoint, 'recycle/purge');
  assert.equal(calls.at(-1).json.confirm, true);

  await tools.kapsel_client_task.execute({ mapping_id: mappingId, action: 'list' }, ctx);
  assert.equal(calls.at(-1).endpoint, `mappings/${mappingId}/tasks`);
  assert.equal(calls.at(-1).method, 'GET');
  await tools.kapsel_client_task.execute({ mapping_id: mappingId, action: 'start', argv: ['python3', '-V'], cwd: '.' }, ctx);
  assert.deepEqual(calls.at(-1).json, { argv: ['python3', '-V'], cwd: '.' });
  assert.equal(calls.at(-1).method, 'POST');
  await tools.kapsel_client_task.execute({ mapping_id: mappingId, action: 'status', task_id: taskId, offset: 4 }, ctx);
  assert.equal(calls.at(-1).endpoint, `mappings/${mappingId}/tasks/${taskId}`);
  assert.deepEqual(calls.at(-1).query, { offset: 4 });
  await tools.kapsel_client_task.execute({ mapping_id: mappingId, action: 'stdin', task_id: taskId, stdin_text: 'héllo' }, ctx);
  assert.equal(calls.at(-1).json.data, Buffer.from('héllo').toString('base64'));
  await tools.kapsel_client_task.execute({ mapping_id: mappingId, action: 'stdin', task_id: taskId, eof: true }, ctx);
  assert.equal(calls.at(-1).json.eof, true);
  for (const action of ['interrupt', 'kill']) {
    await tools.kapsel_client_task.execute({ mapping_id: mappingId, action, task_id: taskId }, ctx);
    assert.equal(calls.at(-1).endpoint, `mappings/${mappingId}/tasks/${taskId}/${action}`);
  }
  assert.equal(calls.filter(call => call.endpoint === 'context').length, 1);
  const approvalEligible = calls.filter(call =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(call.method)
    && call.endpoint !== 'context'
    && call.endpoint !== `mappings/${mappingId}/rpc/vendor/inspect`
  ).length;
  assert.equal(approvals, approvalEligible);
});

test('read-only agent denies client mapping mutations before Plan creation or HTTP', async (t) => {
  const calls = [];
  const mappingId = 'abcdefghijklmnopqrstuvwx';
  const tools = createTools({ stateRoot: await temp(t), transport: async payload => {
    calls.push(payload);
    if (payload.endpoint === 'mappings') return { mappings: [{
      id: mappingId, name: 'laptop', writable: true,
      capabilities: { rpc: { vendor: {
        state: 'available', operations: ['update'],
        operation_specs: { update: {
          description: 'Update one integer.',
          input_schema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
          write: true,
        } },
      } } },
    }] };
    return { ok: true };
  } });
  const denied = { ...context('mapping-readonly', async () => { throw new Error('approval denied'); }), agent: READONLY_AGENT };
  for (const [name, args] of [
    ['kapsel_fs_copy', { source: 'a', destination: 'laptop/a' }],
    ['kapsel_fs_move', { source: 'a', destination: 'laptop/a' }],
    ['kapsel_transfer', { transfer_id: 'transfer-id', action: 'cancel' }],
    ['kapsel_recycle', { action: 'purge', recycle_id: 'x', confirm: true }],
    ['kapsel_client_task', { mapping_id: 'abcdefghijklmnopqrstuvwx', action: 'start', argv: ['python3'] }],
  ]) await assert.rejects(tools[name].execute(args, denied), /approval denied/);
  assert.equal(calls.length, 0);
  await assert.rejects(
    tools.kapsel_rpc.execute({
      mapping_id: mappingId, family: 'vendor', operation: 'update', args: { value: 9 },
      taskname: 'test', message: 'deny rpc write',
    }, denied),
    /approval denied/,
  );
  assert.deepEqual(calls.map(call => [call.method, call.endpoint]), [['GET', 'mappings']]);
  assert.equal(calls.some(call => call.endpoint === 'context'), false);
  assert.equal(calls.some(call => call.endpoint.endsWith('/rpc/vendor/update')), false);

  await tools.kapsel_mappings.execute({}, denied);
  await tools.kapsel_recycle.execute({ action: 'list' }, denied);
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'GET']);
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
  await tools.kapsel_shell_exec.execute({ command: 'echo client', cwd: 'laptop/project', target: 'client' }, context());
  assert.equal(calls.at(-1).payload.json.target, 'client');
  assert.equal(calls.at(-1).payload.json.cwd, 'laptop/project');
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
  await tools.kapsel_fs_search.execute({ query: 'x', include: ['*.py', '*.js'] }, context());
  const search = calls.find(c => c.url.includes('/fs/search'));
  assert.deepEqual(new URL(search.url, url).searchParams.getAll('include'), ['*.py', '*.js']);
  assert.ok(calls.some(c => c.url.includes('path=.')));
  const command = "printf '你好'\n$(touch SHOULD_NEVER_RUN) `echo bad` \\ $HOME \u0000";
  await tools.kapsel_shell_exec.execute({ command }, context());
  assert.equal(calls.at(-1).body.command, command);
  assert.equal(calls.at(-1).body.target, 'auto');
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
