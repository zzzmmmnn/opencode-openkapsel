import { createTools } from '../lib/tools.js';
import { tool as legacyTool } from '@opencode-ai/plugin';
import { AGENT, READONLY_AGENT, MUTATION_PERMISSION, PROMPT } from '../lib/bridge.js';

// OpenCode v2 registers tools and hooks from setup(ctx), unlike the v1 default
// function export. Preserve the established v1 bridge and its session isolation.
const agents = new Map([
  ['openkapsel', AGENT],
  ['openkapsel-readonly', READONLY_AGENT],
  [AGENT, AGENT],
  [READONLY_AGENT, READONLY_AGENT],
]);

export default {
  id: 'opencode-openkapsel',
  async setup(ctx) {
    const tools = createTools();
    const allowed = new Set([...Object.keys(tools), 'question']);
    const definitions = Object.entries(tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      input: legacyTool.schema.toJSONSchema(legacyTool.schema.object(tool.args)),
      async execute(input, context) {
        const agent = agents.get(context.agent);
        if (!agent) throw new Error('Select the OpenKapsel agent before using remote tools');
        const old = {
          agent,
          sessionID: context.sessionID,
          abort: context.signal,
          ask: async request => ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: 'tool', messageID: context.messageID, id: context.id },
            action: request.permission ?? MUTATION_PERMISSION,
            resources: request.patterns ?? ['*'],
            save: request.always ?? ['*'],
          }),
        };
        const result = await tool.execute(input, old);
        return { content: result };
      },
    }));

    await ctx.tool.transform(editor => {
      for (const definition of definitions) editor.add(definition);
    });

    // Tools are remote-only; do not silently allow local operations even if
    // an agent's permission policy was edited by another configuration layer.
    await ctx.tool.hook('execute.before', event => {
      if (agents.has(event.agent) && !allowed.has(event.tool)) {
        throw new Error(`OpenKapsel remote-only mode blocked tool: ${event.tool}`);
      }
    });
    await ctx.session.hook('context', event => {
      if (!agents.has(event.agent)) return;
      event.system.push({ type: 'text', text: PROMPT });
      for (const name of Object.keys(event.tools)) {
        if (!allowed.has(name)) delete event.tools[name];
      }
    });
    await ctx.session.hook('compaction', event => {
      if (!agents.has(event.agent)) return;
      event.system.push({
        type: 'text',
        text: 'OpenKapsel remote-only session. Credentials remain in private session state. Call kapsel_status after compaction, and retain Plan/task IDs.',
      });
    });
  },
};
