import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from '../v2/index.js';

async function makeContext() {
  const tools = [];
  const hooks = new Map();
  const approvals = [];
  const ctx = {
    tool: {
      async transform(fn) { fn({ add(def) { tools.push(def); } }); },
      async hook(type, fn) { hooks.set('tool:'+type, fn); },
    },
    session: { async hook(type, fn) { hooks.set('session:'+type, fn); } },
    permission: { async assert(input) { approvals.push(input); } },
  };
  await plugin.setup(ctx);
  return { tools, hooks, approvals };
}
test('v2 plugin exports a setup definition and all original tools with schemas', async () => {
  assert.equal(plugin.id,'opencode-openkapsel');
  const { tools, hooks } = await makeContext();
  assert.equal(tools.length,24);
  for (const t of tools) {
    assert.equal(t.input.type,'object',t.name);
    assert.equal(t.input.additionalProperties,false,t.name);
    assert.equal(typeof t.execute,'function',t.name);
  }
  assert(hooks.has('tool:execute.before'));
  assert(hooks.has('session:context'));
  assert(hooks.has('session:compaction'));
});
test('remote agent gets only kapsel tools, while local agents cannot call them', async () => {
  const {tools,hooks}=await makeContext();
  const doc=tools.find(x=>x.name==='kapsel_docs');
  const signal=new AbortController().signal;
  const result=await doc.execute({topic:'overview'},{sessionID:'x',agent:'openkapsel',signal});
  assert.match(result.content,/OpenKapsel/);
  await assert.rejects(doc.execute({topic:'overview'},{sessionID:'x',agent:'build',signal}),/Select the OpenKapsel agent/);
  assert.throws(()=>hooks.get('tool:execute.before')({agent:'openkapsel',tool:'shell'}),/remote-only mode blocked/);
  const context={agent:'openkapsel',system:[],tools:{shell:{},kapsel_config:{},kapsel_docs:{}}};
  hooks.get('session:context')(context);
  assert(!context.tools.shell);
  assert(context.tools.kapsel_config);
  assert(context.system.length>0);
});
