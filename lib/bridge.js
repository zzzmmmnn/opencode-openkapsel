import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runHelper } from './transport.js';

export const AGENT = 'OpenKapsel';
export const READONLY_AGENT = 'OpenKapsel Read-only';
export const MUTATION_PERMISSION = 'kapsel_write';
export const PROMPT = `You operate a REMOTE OpenKapsel workspace. All file paths and shell commands refer to that workspace or its connected client mappings.
Use kapsel_config with the user-provided workspace URL and control token before other operations.
Load kapsel_docs first, then its relevant topic for endpoint contracts. Use kapsel_http for interfaces without typed tools.
Use kapsel_plan_update to finish Plans with a structured debrief. Every recorded mutation uses plan_id, taskname (max 32), and message (max 200).
When omitted, a session-specific Plan is created after write authorization. Use explicit plans for distinct tasks. When runtime Discovery advertises atomic_subplans, create a parent and direct children in one kapsel_http POST context call with subplans and a stable request_id inside json; use returned child IDs on later operations.
Use kapsel_shell_exec for remote execution and kapsel_task_output to poll results. target=auto routes a mapped cwd to its client and other cwd to the server; target=server or client selects explicitly. Local tools and delegation are unavailable.
For RPC, kapsel_rpc without mapping_id targets the server workspace; provide mapping_id to target a client mapping. Server-capable families come from Discovery; mapping operation schemas come from kapsel_mapping_list. For a client-backed directory, inspect kapsel_mapping_list first. On RPC-first servers, online=true with mounted=false is normal: file/RPC tools need no native mount. Keep target=auto unless server execution is intended. Use mount_mappings for extra server native dependencies, and api/mappings.json for FastAPI dependencies. The client has its own platform and sandbox policy; client execution uses kapsel_shell_exec and the unified /task/* lifecycle.
Never automatically replay a Shell/RPC write after a timeout, cancellation, or lost response; inspect existing tasks and affected paths first. Check unavailable_mappings and truncated query results before claiming a search is complete.
Never echo credentials. The configured token determines remote permissions; read-only mode requires approval for mutations.
The Python scripts mentioned in the reference docs are run internally by this plugin; do not execute them yourself.`;

function short(value, fallback, limit) {
  const text = value?.trim() || fallback;
  return [...text].slice(0, limit).join('');
}

function serverRpcOperation(discovery, family, operation) {
  const capability = discovery?.capabilities?.mappings?.rpc?.families?.[family];
  if (!capability || capability.server_rpc !== true) {
    throw new Error(`server RPC family is not available: ${family}`);
  }
  for (const [field, write, execution] of [
    ['sync_reads', false, 'sync'],
    ['task_reads', false, 'task'],
    ['sync_writes', true, 'sync'],
    ['task_writes', true, 'task'],
  ]) {
    if (Array.isArray(capability[field]) && capability[field].includes(operation)) {
      return { capability, spec: { write, execution } };
    }
  }
  throw new Error(`server RPC operation is not advertised: ${family}.${operation}`);
}

export function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint || endpoint.startsWith('-') || /[\s\\\x00-\x1f]/.test(endpoint)) {
    throw new Error('Use a workspace-relative endpoint or a same-origin transfer ticket URL');
  }
  let decoded = endpoint;
  for (let i = 0; i < 8; i++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (/[\\\x00-\x1f]/.test(decoded) || decoded.split(/[/?#]/).some(s => s === '.' || s === '..')) {
    throw new Error('Endpoint traversal and control characters are not allowed');
  }
  if (endpoint.startsWith('//') || /^(?!https?:)[a-z][\w+.-]*:/i.test(endpoint)) {
    throw new Error('Unsupported endpoint URL');
  }
  return endpoint;
}

export function createBridge({ stateRoot, transport = runHelper } = {}) {
  stateRoot ??= join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'opencode-openkapsel');
  if (!isAbsolute(stateRoot)) throw new Error('OpenKapsel state root must be absolute');
  const queues = new Map();

  async function withSession(context, operation) {
    if (!context?.sessionID || ![AGENT, READONLY_AGENT].includes(context.agent)) {
      throw new Error('Select the OpenKapsel agent before using remote tools');
    }
    const id = createHash('sha256').update(context.sessionID).digest('hex');
    const previous = queues.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      context.abort?.throwIfAborted();
      const directory = join(stateRoot, id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') {
        await chmod(stateRoot, 0o700);
        await chmod(directory, 0o700);
      }
      const metadataFile = join(directory, 'session.json');
      let state = { taskname: 'opencode', planId: null };
      try { state = JSON.parse(await readFile(metadataFile, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw new Error('Invalid OpenKapsel session state'); }
      const save = async () => {
        const temp = metadataFile + '.' + randomUUID();
        await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        await rename(temp, metadataFile);
      };
      const call = (payload) => transport(payload, { cwd: directory, signal: context.abort });
      const http = (method, endpoint, extra = {}) => call({ action: 'http', method, endpoint: validateEndpoint(endpoint), ...extra });
      const ensureConversation = async () => {
        if (Number.isInteger(state.conversationId) && state.writerNonce) {
          return { conversation_id: state.conversationId, writer_nonce: state.writerNonce };
        }
        // Persist the pending request before the network call: if its response
        // is lost, reusing request_id recovers the original writer_nonce.
        if (!state.pendingConversation) {
          const history = await http('GET', 'conversation');
          const conversationId = history?.next_conversation_id;
          if (!Number.isInteger(conversationId) || conversationId < 0) {
            throw new Error('OpenKapsel did not publish next_conversation_id');
          }
          state.pendingConversation = {
            conversation_id: conversationId,
            request_id: `opencode-${id.slice(0, 20)}-${conversationId}`,
            entries: [
              { role: 'user', content: 'User selected a remote OpenKapsel workspace in OpenCode.' },
              { role: 'ai', content: 'OpenCode remote session context initialized.' },
            ],
          };
          await save();
        }
        const receipt = await http('POST', 'conversation', { json: state.pendingConversation });
        if (receipt?.conversation_id !== state.pendingConversation.conversation_id
            || !/^@[A-Za-z0-9]{4}@$/.test(receipt?.writer_nonce ?? '')) {
          throw new Error('OpenKapsel did not return a valid Conversation writer nonce');
        }
        state.conversationId = receipt.conversation_id;
        state.writerNonce = receipt.writer_nonce;
        state.pendingConversation = null;
        await save();
        return { conversation_id: state.conversationId, writer_nonce: state.writerNonce };
      };
      const planConversationFields = async (activity) => ({
        ...await ensureConversation(),
        conversation_entries: [{ role: 'ai', content: activity.slice(0, 1000) }],
      });
      const authorize = async () => {
        if (typeof context.ask !== 'function') throw new Error('OpenCode write approval API is unavailable');
        await context.ask({ permission: MUTATION_PERMISSION, patterns: ['*'], always: ['*'], metadata: { action: 'Modify the remote OpenKapsel workspace' } });
      };
      const attribution = async (args) => {
        if (!args.plan_id && !state.planId) {
          const plan = await http('POST', 'context', { json: {
            type: 'plan', taskname: short(args.taskname, state.taskname, 32),
            content: 'OpenCode remote workspace session.', subplans: [],
            ...await planConversationFields('Begin remote OpenCode workspace Plan.'),
          } });
          if (!Number.isInteger(plan?.id) || plan.id <= 0) throw new Error('Server did not return a Plan id');
          state.planId = plan.id;
          state.taskname = short(args.taskname, state.taskname, 32);
          await save();
        }
        return { plan_id: args.plan_id || state.planId, taskname: short(args.taskname, state.taskname, 32), message: short(args.message, 'OpenCode remote operation', 200) };
      };
      return operation({ state, save, call, http, authorize, attribution, planConversationFields });
    });
    queues.set(id, current);
    try { return await current; }
    finally { if (queues.get(id) === current) queues.delete(id); }
  }

  return {
    config: (args, context) => withSession(context, async ({ state, save, call, http }) => {
      const result = await call({ action: 'init', ...args });
      state.taskname = short(args.taskname, 'opencode', 32);
      state.planId = null;
      state.conversationId = null;
      state.writerNonce = null;
      state.pendingConversation = null;
      await save();
      const discovery = await http('GET', '/');
      return { config: result, workspace: { name: discovery?.name, capabilities: discovery?.capabilities }, plan_id: null };
    }),
    status: (_, context) => withSession(context, async ({ state, http }) => {
      const discovery = await http('GET', '/');
      return { taskname: state.taskname, plan_id: state.planId, workspace: { name: discovery?.name, capabilities: discovery?.capabilities } };
    }),
    request: (args, context) => withSession(context, async ({ state, save, http, authorize, attribution, planConversationFields }) => {
      const { method, endpoint, query, json } = args;
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported HTTP method');
      validateEndpoint(endpoint);
      if (json !== undefined && (json === null || typeof json !== 'object' || Array.isArray(json))) throw new Error('json must be an object');
      const mappingRpcMatch = /^\/?mapping\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/rpc\/([a-z][a-z0-9_]{0,31})\/([a-z][a-z0-9_]{0,31})(?:\?|$)/.exec(endpoint);
      const serverRpcMatch = /^\/?rpc\/([a-z][a-z0-9_]{0,31})\/([a-z][a-z0-9_]{0,31})(?:\?|$)/.exec(endpoint);
      let rpcWrite = false;
      let rpcMatched = false;
      if (method === 'POST' && mappingRpcMatch) {
        const listing = await http('GET', 'mapping');
        const mapping = (listing?.mappings ?? []).find((item) => item?.name === mappingRpcMatch[1] || item?.id === mappingRpcMatch[1]);
        if (!mapping) throw new Error('mapping RPC target is not visible in kapsel_mapping_list');
        const capability = mapping.capabilities?.rpc?.[mappingRpcMatch[2]];
        if (!capability || capability.state !== 'available') {
          throw new Error(`mapping RPC family is not available: ${mappingRpcMatch[2]}`);
        }
        const spec = capability.operation_specs?.[mappingRpcMatch[3]];
        if (!spec || typeof spec.write !== 'boolean' || !['sync', 'task'].includes(spec.execution)) {
          throw new Error(`mapping RPC operation lacks write/execution metadata: ${mappingRpcMatch[2]}.${mappingRpcMatch[3]}`);
        }
        rpcMatched = true;
        rpcWrite = spec.write;
        if (rpcWrite && mapping.writable !== true) {
          throw new Error('mapping is read-only for this RPC write operation');
        }
      } else if (method === 'POST' && serverRpcMatch) {
        const discovery = await http('GET', '/');
        const { spec } = serverRpcOperation(discovery, serverRpcMatch[1], serverRpcMatch[2]);
        rpcMatched = true;
        rpcWrite = spec.write;
      }
      const readPost = method === 'POST' && (
        /^\/?fs\/(?:read\/files|query\/manifest)(?:\?|$)/.test(endpoint)
        || (rpcMatched && !rpcWrite)
      );
      const mutating = !['GET', 'HEAD'].includes(method) && !readPost;
      const options = { ...(query ? { query } : {}), ...(json !== undefined ? { json } : {}) };
      if (mutating) {
        await authorize();
        if (/^\/?context(?:[/?#]|$)/.test(endpoint)) {
          options.json = { taskname: short(args.taskname, state.taskname, 32), ...json };
          const relative = endpoint.split(/[?#]/, 1)[0].replace(/^\/+/, '');
          const planCreate = method === 'POST' && relative === 'context' && options.json.type === 'plan';
          const planUpdate = method === 'PATCH' && /^context\/plans\/\d+$/.test(relative);
          if ((planCreate || planUpdate) && options.json.conversation_id === undefined
              && !(planUpdate && options.json.status === 'cancelled' && options.json.content === undefined)) {
            Object.assign(options.json, await planConversationFields(
              planCreate ? 'Create an OpenCode remote Plan.' : `Update OpenCode Plan: ${options.json.status ?? 'content'}.`));
          }
          if (planCreate && options.json.plan_id === undefined && options.json.subplans === undefined) options.json.subplans = [];
        } else Object.assign(options, await attribution(args));
      }
      const result = await http(method, endpoint, options);
      const target = /^\/?context\/plans\/(\d+)$/.exec(endpoint);
      if (mutating && target && Number(target[1]) === state.planId && ['completed', 'cancelled'].includes(json?.status)) {
        state.planId = null;
        await save();
      }
      return result;
    }),
  };
}
