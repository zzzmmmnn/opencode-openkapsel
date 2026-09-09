import { createTools } from './lib/tools.js';
import { AGENT, READONLY_AGENT, MUTATION_PERMISSION, PROMPT } from './lib/bridge.js';

// One export: OpenCode initializes every exported plugin function.
export default async function OpenKapselPlugin() {
  const tools = createTools();
  const allowed = new Set([...Object.keys(tools), 'question', 'todowrite', 'todoread']);
  const remoteAgents = new Set([AGENT, READONLY_AGENT]);
  const sessionAgents = new Map();
  const rememberAgent = ({ sessionID, agent }) => {
    if (sessionID && agent) sessionAgents.set(sessionID, agent);
  };
  const isRemoteSession = sessionID => remoteAgents.has(sessionAgents.get(sessionID));
  return {
    tool: tools,
    async config(config) {
      const basePermission = typeof config.permission === 'string'
        ? { '*': config.permission }
        : { ...(config.permission || {}) };
      config.permission = {
        ...basePermission,
        ...Object.fromEntries(Object.keys(tools).map(name => [name, 'deny'])),
      };
      const permissions = { '*': 'deny', ...Object.fromEntries([...allowed].map(name => [name, 'allow'])) };
      config.agent ??= {};
      for (const [name, approval] of [[AGENT, 'allow'], [READONLY_AGENT, 'ask']]) {
        config.agent[name] = {
          ...config.agent[name], mode: 'primary',
          description: name === AGENT ? 'Operate a remote OpenKapsel workspace' : 'Read a remote OpenKapsel workspace; ask before changes',
          prompt: PROMPT, permission: { ...permissions, [MUTATION_PERMISSION]: approval },
        };
      }
    },
    async 'chat.message'(input) {
      rememberAgent(input);
    },
    async 'chat.params'(input) {
      rememberAgent(input);
    },
    async 'tool.execute.before'({ tool, sessionID }) {
      if (isRemoteSession(sessionID) && !allowed.has(tool)) {
        throw new Error(`OpenKapsel remote-only mode blocked tool: ${tool}`);
      }
    },
    async 'experimental.chat.system.transform'({ sessionID }, output) {
      if (isRemoteSession(sessionID)) output.system.push(PROMPT);
    },
    async 'experimental.session.compacting'({ sessionID }, output) {
      if (isRemoteSession(sessionID)) {
        output.context.push('This is an OpenKapsel remote-only session. Credentials persist privately for the same session ID. Call kapsel_status after compaction; keep task/Plan IDs, never copy tokens into summaries.');
      }
    },
  };
}
