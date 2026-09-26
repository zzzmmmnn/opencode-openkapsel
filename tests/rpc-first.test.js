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
  let approvals = 0;
  const tools = createTools({ stateRoot, transport: async payload => {
    calls.push(payload);
    if (failure) throw new Error(failure);
    if (payload.endpoint === 'context') return contextResponse ?? { id: 7 };
    if (payload.endpoint === '/' && discoveryResponse) return discoveryResponse;
    return response ?? { task_id: 'task_test', location: 'server' };
  } });
  const ctx = { sessionID: 'rpc-first-test', agent: deny ? READONLY_AGENT : AGENT,
    abort: new AbortController().signal, ask: async () => { approvals++; if (deny) throw new Error('approval denied'); } };
  return { tools, calls, ctx, approvals: () => approvals };
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
  assert.deepEqual(JSON.parse(await f.tools.kapsel_mappings.execute({}, f.ctx)), response);
  assert.deepEqual(JSON.parse(await f.tools.kapsel_fs_search.execute({ query: 'needle', path: '.' }, f.ctx)), response);
  assert.equal(f.approvals(), 0);
  assert.deepEqual(f.calls.map(c => c.endpoint), ['mappings', 'fs/search']);
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
    subplans: [{ ref: 'code', content: 'Code' }, { ref: 'tests', content: 'Verify' }] };
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
    request_id: 'feature-02', subplans: [{ ref: 'child', content: 'Child' }] } };
  const denied = await fixture(t, { deny: true });
  await assert.rejects(denied.tools.kapsel_http.execute(args, denied.ctx), /approval denied/);
  assert.equal(denied.calls.length, 0);
  const failed = await fixture(t, { failure: 'response lost' });
  await assert.rejects(failed.tools.kapsel_http.execute(args, failed.ctx), /response lost/);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.calls[0].json.request_id, 'feature-02');
});
