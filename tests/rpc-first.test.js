import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { tool } from '@opencode-ai/plugin';
import { createTools } from '../lib/tools.js';
import { AGENT, READONLY_AGENT, PROMPT } from '../lib/bridge.js';

async function fixture(t, { deny = false, failure, response, contextResponse, discoveryResponse } = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'opencode-rpc-first-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const calls = [];
  let approvals = 0, activeFailure = failure;
  const tools = createTools({ stateRoot, transport: async payload => {
    calls.push(payload);
    if (activeFailure) throw new Error(activeFailure);
    if (payload.endpoint === 'conversation') return payload.method === 'GET' ? { next_conversation_id: 0 } : { conversation_id: 0, writer_nonce: '@Ab12@' };
    if (payload.endpoint === 'context') return contextResponse ?? { id: 7 };
    if (payload.endpoint === '/' && discoveryResponse) return discoveryResponse;
    return response ?? { task_id: 'task_test', location: 'server' };
  } });
  const ctx = { sessionID: 'rpc-first-test', agent: deny ? READONLY_AGENT : AGENT,
    abort: new AbortController().signal, ask: async () => { approvals++; if (deny) throw new Error('approval denied'); } };
  return { tools, calls, ctx, approvals: () => approvals, fail: value => { activeFailure = value; } };
}

test('typed Shell schema and request preserve optional mapping dependencies and defaults', async t => {
  const f = await fixture(t);
  const shell = f.tools.kapsel_shell_exec;
  const schema = tool.schema.object(shell.args);
  const input = { command: 'python laptop/main.py', cwd: '.', target: 'server', mount_mappings: ['laptop', 'abcdefghijklmnopqrstuvwx'],
    timeout_seconds: 9, interactive: true, plan_id: 7, taskname: 'build', message: 'Use server runtime' };
  assert.deepEqual(schema.parse(input).mount_mappings, input.mount_mappings);
  await shell.execute(schema.parse(input), f.ctx);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].json, { command: input.command, cwd: '.', target: 'server', mount_mappings: input.mount_mappings, timeout_seconds: 9, interactive: true });
  assert.equal(f.calls[0].plan_id, 7);
  assert.equal(f.calls[0].taskname, 'build');
  assert.equal(f.calls[0].message, 'Use server runtime');
  await shell.execute({ command: 'echo auto', plan_id: 7 }, f.ctx);
  assert.equal(f.calls.at(-1).json.target, 'auto');
  assert.ok(!Object.hasOwn(f.calls.at(-1).json, 'mount_mappings'));
  await shell.execute({ command: 'echo auto', cwd: '.', mount_mappings: ['laptop'], plan_id: 7 }, f.ctx);
  assert.equal(f.calls.at(-1).json.target, 'auto');
  assert.deepEqual(f.calls.at(-1).json.mount_mappings, ['laptop']);
  await shell.execute({ command: 'echo client', cwd: 'laptop', target: 'client', mount_mappings: [], plan_id: 7 }, f.ctx);
  assert.deepEqual(f.calls.at(-1).json.mount_mappings, []);
  assert.equal(f.approvals(), 4);
});

test('invalid dependency arrays and explicit client dependencies fail before remote work', async t => {
  const f = await fixture(t);
  const schema = tool.schema.object(f.tools.kapsel_shell_exec.args);
  for (const mount_mappings of [null, 'laptop', {}, [1], [''], Array(257).fill('laptop')]) {
    assert.equal(schema.safeParse({ command: 'echo test', mount_mappings }).success, false);
    await assert.rejects(f.tools.kapsel_shell_exec.execute({ command: 'echo test', mount_mappings }, f.ctx));
  }
  await assert.rejects(f.tools.kapsel_shell_exec.execute({ command: 'echo test', mount_mappings: ['bad\0name'] }, f.ctx));
  await assert.rejects(f.tools.kapsel_shell_exec.execute({ command: 'echo test', target: 'client', mount_mappings: ['laptop'] }, f.ctx), /server execution/);
  assert.equal(f.approvals(), 0);
  assert.equal(f.calls.length, 0);
});

test('native dependency requests still require approval before Plan creation', async t => {
  const f = await fixture(t, { deny: true });
  const input = { command: 'echo denied', target: 'server', mount_mappings: ['laptop'] };
  await assert.rejects(f.tools.kapsel_shell_exec.execute(input, f.ctx), /approval denied/);
  await assert.rejects(f.tools.kapsel_http.execute({ method: 'POST', endpoint: 'shell/exec', json: input }, f.ctx), /approval denied/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.approvals(), 2);
});

test('generic HTTP preserves dependencies and neither path replays failed starts', async t => {
  const f = await fixture(t, { failure: 'request timed out' });
  const input = { command: 'echo once', target: 'server', mount_mappings: ['laptop'] };
  await assert.rejects(f.tools.kapsel_http.execute({ method: 'POST', endpoint: 'shell/exec', json: input, plan_id: 7 }, f.ctx), /timed out/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].json, input);
  await assert.rejects(f.tools.kapsel_shell_exec.execute({ ...input, plan_id: 7 }, f.ctx), /timed out/);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].json.mount_mappings, ['laptop']);
});

test('unmounted online mappings and partial query results pass through read-only', async t => {
  const response = { mappings: [{ id: 'abcdefghijklmnopqrstuvwx', online: true, mounted: false, mount_references: 0, native_mounts_enabled: false }],
    truncated: true, unavailable_mappings: [{ mapping_id: 'other', code: 'mapping_offline' }] };
  const f = await fixture(t, { deny: true, response });
  assert.deepEqual(JSON.parse(await f.tools.kapsel_mapping_list.execute({}, f.ctx)), response);
  assert.deepEqual(JSON.parse(await f.tools.kapsel_fs_grep.execute({ query: 'needle', path: '.' }, f.ctx)), response);
  assert.equal(f.approvals(), 0);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['mapping', 'fs/query/grep']);
});

test('kapsel_rpc targets server when mapping_id is omitted and preserves read/write policy', async t => {
  const discoveryResponse = {
    capabilities: { mappings: { rpc: { families: {
      git: { server_rpc: true, sync_reads: ['status'], task_writes: ['commit', 'fetch'] },
      archive: { server_rpc: true, sync_reads: ['list', 'read'], task_writes: ['create', 'extract'] },
    } } } },
  };

  const readonly = await fixture(t, { deny: true, discoveryResponse, response: { ok: true } });
  const schema = tool.schema.object(readonly.tools.kapsel_rpc.args);
  assert.equal(schema.safeParse({ family: 'git', operation: 'status' }).success, true);
  await readonly.tools.kapsel_rpc.execute({ family: 'git', operation: 'status', args: { path: '.' } }, readonly.ctx);
  assert.deepEqual(readonly.calls.map(c => [c.method, c.endpoint]), [
    ['GET', '/'],
    ['POST', 'rpc/git/status'],
  ]);
  assert.equal(readonly.approvals(), 0);

  await readonly.tools.kapsel_http.execute({
    method: 'POST', endpoint: 'rpc/archive/list', json: { args: { path: 'sample.zip' } },
  }, readonly.ctx);
  assert.deepEqual(readonly.calls.slice(-2).map(c => [c.method, c.endpoint]), [
    ['GET', '/'],
    ['POST', 'rpc/archive/list'],
  ]);
  assert.equal(readonly.approvals(), 0);

  const writable = await fixture(t, {
    discoveryResponse,
    response: { task_id: 'task_server_rpc', location: 'server', execution: 'task' },
  });
  await writable.tools.kapsel_rpc.execute({
    family: 'git', operation: 'commit', args: { message: 'test' }, timeout_seconds: 30,
    plan_id: 7, taskname: 'git', message: 'Commit server repository',
  }, writable.ctx);
  assert.equal(writable.calls[0].endpoint, '/');
  assert.equal(writable.calls[1].endpoint, 'rpc/git/commit');
  assert.deepEqual(writable.calls[1].json, { args: { message: 'test' }, timeout_seconds: 30 });
  assert.equal(writable.calls[1].plan_id, 7);
  assert.equal(writable.calls[1].taskname, 'git');
  assert.equal(writable.calls[1].message, 'Commit server repository');
  assert.equal(writable.approvals(), 1);

  await assert.rejects(
    writable.tools.kapsel_rpc.execute({ family: 'git', operation: 'unknown' }, writable.ctx),
    /not advertised/,
  );
});

test('mapping RPC prefers the short mapping name and remains read-only', async t => {
  const mapping = {
    id: 'abcdefghijklmnopqrstuvwx', name: 'laptop', writable: true,
    capabilities: { rpc: { git: { state: 'available', operation_specs: {
      status: { write: false, execution: 'sync' },
    } } } },
  };
  const f = await fixture(t, { deny: true, response: { mappings: [mapping] } });
  await f.tools.kapsel_rpc.execute({
    mapping_id: mapping.name, family: 'git', operation: 'status', args: { cwd: '.' },
  }, f.ctx);
  assert.deepEqual(f.calls.map(c => [c.method, c.endpoint]), [
    ['GET', 'mapping'],
    ['POST', 'mapping/laptop/rpc/git/status'],
  ]);
  assert.equal(f.approvals(), 0);
});

test('bundled references and agent prompt describe RPC-first dependencies and errors', async () => {
  const tools = createTools();
  const texts = await Promise.all(['overview', 'mappings', 'shell', 'files', 'web-and-apps', 'endpoint-index', 'ssh-rpc'].map(topic => tools.kapsel_docs.execute({ topic }, {})));
  const text = texts.join('\n');
  for (const term of ['mount_mappings', 'api/mappings.json', 'file_stream', 'unavailable_mappings', 'rpc.file has been removed', 'POST /rpc/<family>/<operation>', 'SSH RPC']) assert.ok(text.includes(term), term);
  assert.doesNotMatch(text, /It may fall back to FUSE|`rpc\.file`, `rpc\.git`/);
  assert.match(PROMPT, /without mapping_id targets the server workspace/);
  assert.match(PROMPT, /mounted=false/);
  assert.match(PROMPT, /mount_mappings/);
  assert.match(PROMPT, /never automatically replay/i);
});


test('atomic Plan requests and child receipts pass through without an automatic extra Plan', async t => {
  const receipt = { id: 20, request_id: 'feature-01', replayed: false, subplans: [
    { index: 0, ref: 'code', id: 21, plan_id: 20 }, { index: 1, ref: 'tests', id: 22, plan_id: 20 },
  ] };
  const f = await fixture(t, { contextResponse: receipt });
  const json = { type: 'plan', taskname: 'feature', content: 'Implement', request_id: 'feature-01',
    subplans: [{ ref: 'code', content: 'Code' }, { ref: 'tests', content: 'Verify' }], conversation_id: 0, writer_nonce: '@Ab12@', conversation_entries: [{ role: 'ai', content: 'Start feature.' }] };
  const result = JSON.parse(await f.tools.kapsel_http.execute({ method: 'POST', endpoint: 'context', json }, f.ctx));
  assert.deepEqual(result, receipt);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].json, json);
  assert.equal(f.calls[0].endpoint, 'context');
  assert.equal(f.calls[0].plan_id, undefined);
  assert.equal(f.approvals(), 1);
  assert.match(await f.tools.kapsel_docs.execute({ topic: 'context' }, f.ctx), /Create a plan and direct subplans in one call/);
  assert.match(PROMPT, /subplans.*request_id/);
});

test('atomic Plan requests keep approvals and never replay an uncertain creation', async t => {
  const args = { method: 'POST', endpoint: 'context', json: { type: 'plan', taskname: 'feature', content: 'Once',
    request_id: 'feature-02', subplans: [{ ref: 'child', content: 'Child' }], conversation_id: 0, writer_nonce: '@Ab12@', conversation_entries: [{ role: 'ai', content: 'Start feature.' }] } };
  const denied = await fixture(t, { deny: true });
  await assert.rejects(denied.tools.kapsel_http.execute(args, denied.ctx), /approval denied/);
  assert.equal(denied.calls.length, 0);
  const failed = await fixture(t, { failure: 'response lost' });
  await assert.rejects(failed.tools.kapsel_http.execute(args, failed.ctx), /response lost/);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.calls[0].json.request_id, 'feature-02');
});

test('automatic Plan creation opens Conversation and includes writer nonce and subplans', async t => {
  const f = await fixture(t);
  const receipt = JSON.parse(await f.tools.kapsel_http.execute({
    method: 'POST', endpoint: 'context', json: { type: 'plan', taskname: 'bootstrap', content: 'Start job' },
  }, f.ctx));
  assert.equal(receipt.id, 7);
  assert.deepEqual(f.calls.map(c => [c.method, c.endpoint]), [
    ['GET', 'conversation'], ['POST', 'conversation'], ['POST', 'context'],
  ]);
  assert.equal(f.calls[1].json.conversation_id, 0);
  assert.match(f.calls[1].json.request_id, /^opencode-[a-f0-9]{20}-0$/);
  assert.equal(f.calls[2].json.conversation_id, 0);
  assert.equal(f.calls[2].json.writer_nonce, '@Ab12@');
  assert.deepEqual(f.calls[2].json.subplans, []);
});

test('Plan update rejects parent changes and requires expected revision and Conversation', async t => {
  const f = await fixture(t);
  const plan = f.tools.kapsel_plan_update;
  const schema = tool.schema.object(plan.args);
  assert.ok(schema.safeParse({ plan_id: 7, content: 'New' }).success === false);
  assert.ok(!Object.hasOwn(plan.args, 'parent_plan_id'));
  assert.ok(!Object.hasOwn(plan.args, 'move_to_root'));
  await assert.rejects(plan.execute({ plan_id: 7, content: 'New' }, f.ctx), /expected_revision/);
  assert.equal(f.calls.length, 0);
  await plan.execute({ plan_id: 7, expected_revision: 2, content: 'New' }, f.ctx);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['conversation', 'conversation', 'context/plans/7']);
  const body = f.calls.at(-1).json;
  assert.equal(body.expected_revision, 2);
  assert.equal(body.conversation_id, 0);
  assert.equal(body.writer_nonce, '@Ab12@');
  assert.equal(body.conversation_entries[0].role, 'ai');
  assert.equal(body.plan_id, undefined);
  assert.match(await f.tools.kapsel_docs.execute({ topic: 'request-transport' }, f.ctx), /response_mode=envelope/);
});

test('indexed fs_find accepts native sort/glob options and works in read-only mode', async t => {
  const f = await fixture(t, { deny: true });
  const schema = tool.schema.object(f.tools.kapsel_fs_find.args);
  assert.equal(schema.safeParse({ path: '.', max_results: 1001 }).success, false);
  await f.tools.kapsel_fs_find.execute({ path: 'laptop', mode: 'glob', query: '*.py',
    sort_by: 'modified', sort_order: 'desc', max_results: 25 }, f.ctx);
  await f.tools.kapsel_fs_find.execute({ path: '.', max_results: 5 }, f.ctx);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['fs/query/find', 'fs/query/find']);
  assert.deepEqual(f.calls[0].query, { path: 'laptop', mode: 'glob', query: '*.py',
    sort_by: 'modified', sort_order: 'desc', max_results: 25 });
  assert.equal(f.approvals(), 0);
});

test('Shell/File approval tools request URLs separately and approved operations bind nonce', async t => {
  const f = await fixture(t);
  await f.tools.kapsel_shell_request_approval.execute({ target: 'server', reason: 'Run tests', plan_id: 7 }, f.ctx);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['conversation', 'conversation', 'shell/approval/request']);
  assert.deepEqual(f.calls[2].json, { target: 'server', reason: 'Run tests', writer_nonce: '@Ab12@' });
  assert.equal(f.calls[2].plan_id, 7);
  await f.tools.kapsel_shell_exec.execute({ command: 'true', target: 'server', approved: true, plan_id: 7 }, f.ctx);
  assert.equal(f.calls.at(-1).json.approved, true);
  assert.equal(f.calls.at(-1).json.writer_nonce, '@Ab12@');
  await f.tools.kapsel_files_request_approval.execute({
    access: 'read', target: 'laptop', reason: 'Read external tree', path: '/Users',
    scope_is_directory: true, plan_id: 7,
  }, f.ctx);
  assert.equal(f.calls.at(-1).endpoint, 'files/approval/request');
  assert.equal(f.calls.at(-1).json.writer_nonce, '@Ab12@');
  assert.equal(f.calls.at(-1).json.path, '/Users');
  await f.tools.kapsel_http.execute({ method: 'POST', endpoint: 'files/approval/request',
    json: { access: 'write', target: 'server', reason: 'Edit temporary file' }, plan_id: 7 }, f.ctx);
  assert.equal(f.calls.at(-1).json.writer_nonce, '@Ab12@');
  await f.tools.kapsel_http.execute({ method: 'POST', endpoint: 'fs/read/files',
    json: { paths: ['/Users/test.txt'], target: 'laptop', approved: true }, plan_id: 7 }, f.ctx);
  assert.equal(f.calls.at(-1).json.writer_nonce, '@Ab12@');
  assert.equal(f.calls.at(-1).plan_id, 7);
});


test('function-owned approval binds private nonce on typed and arbitrary REST paths', async t => {
  const f = await fixture(t);
  const fn = f.tools.kapsel_function_request_approval;
  const schema = tool.schema.object(fn.args);
  assert.equal(schema.safeParse({ function: 'bad', target: 'server', reason: 'Why' }).success, false);
  await assert.rejects(fn.execute({ function: 'files.write', target: 'auto', reason: 'Why', plan_id: 7 }, f.ctx), /never auto/);
  assert.equal(f.calls.length, 0);
  await fn.execute({ function: 'files.write', target: 'laptop',
    args: { path: '/Users', access: 'write' }, reason: 'Plugin work', plan_id: 7 }, f.ctx);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['conversation', 'conversation', 'function/approval/request']);
  assert.deepEqual(f.calls[2].json, { function: 'files.write', target: 'laptop',
    args: { path: '/Users', access: 'write' }, reason: 'Plugin work', writer_nonce: '@Ab12@' });
  assert.equal(f.calls[2].plan_id, 7);
  await f.tools.kapsel_http.execute({
    method: 'POST', endpoint: '/function/approval/request', plan_id: 7,
    json: { function: 'shell.exec', target: 'server', reason: 'Test', args: {}, writer_nonce: '@Wrong@' },
  }, f.ctx);
  assert.equal(f.calls.at(-1).json.writer_nonce, '@Ab12@');
  assert.equal(f.calls.at(-1).plan_id, 7);
  assert.match(PROMPT, /kapsel_function_request_approval/);
  assert.match(await f.tools.kapsel_docs.execute({ topic: 'context' }, f.ctx), /completed Plan is immutable/i);
});

test('closed cached Plan is invalidated without replay after terminal server rejection', async t => {
  const f = await fixture(t);
  await f.tools.kapsel_fs_write.execute({ path: 'a.txt', content: 'one' }, f.ctx);
  const created = f.calls.filter(c => c.endpoint === 'context' && c.method === 'POST');
  assert.equal(created.length, 1);
  f.fail('completed plan cannot be modified');
  const count = f.calls.length;
  await assert.rejects(f.tools.kapsel_fs_write.execute({ path: 'b.txt', content: 'once' }, f.ctx), /completed plan cannot be modified/);
  assert.equal(f.calls.length, count + 1);
  f.fail(null);
  const status = JSON.parse(await f.tools.kapsel_status.execute({}, f.ctx));
  assert.equal(status.plan_id, null);
  await f.tools.kapsel_fs_write.execute({ path: 'c.txt', content: 'new plan' }, f.ctx);
  assert.equal(f.calls.filter(c => c.endpoint === 'context' && c.method === 'POST').length, 2);
});
