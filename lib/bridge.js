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
When omitted, a session-specific Plan is created after write authorization. Use explicit plans for distinct tasks.
Use kapsel_shell_exec for remote execution and kapsel_task_output to poll results. target=auto routes a mapped cwd to its client and other cwd to the server; target=server or client selects explicitly. Local tools and delegation are unavailable.
For a client-backed directory, inspect kapsel_mappings first. On RPC-first servers, online=true with mounted=false is normal: file/RPC tools need no native mount. Keep target=auto unless server execution is intended. Use mount_mappings for extra server native dependencies, and api/mappings.json for FastAPI dependencies. The client has its own platform and sandbox policy; use kapsel_client_task when a literal argv array is needed.
Never automatically replay a Shell/RPC write after a timeout, cancellation, or lost response; inspect existing tasks and affected paths first. Check unavailable_mappings and truncated query results before claiming a search is complete.
Never echo credentials. The configured token determines remote permissions; read-only mode requires approval for mutations.
The Python scripts mentioned in the reference docs are run internally by this plugin; do not execute them yourself.`;

function short(value, fallback, limit) {
  const text = value?.trim() || fallback;
  return [...text].slice(0, limit).join('');
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
      const authorize = async () => {
        if (typeof context.ask !== 'function') throw new Error('OpenCode write approval API is unavailable');
        await context.ask({ permission: MUTATION_PERMISSION, patterns: ['*'], always: ['*'], metadata: { action: 'Modify the remote OpenKapsel workspace' } });
      };
      const attribution = async (args) => {
        if (!args.plan_id && !state.planId) {
          const plan = await http('POST', 'context', { json: {
            type: 'plan', taskname: short(args.taskname, state.taskname, 32),
            content: 'OpenCode remote workspace session.',
          } });
          if (!Number.isInteger(plan?.id) || plan.id <= 0) throw new Error('Server did not return a Plan id');
          state.planId = plan.id;
          state.taskname = short(args.taskname, state.taskname, 32);
          await save();
        }
        return { plan_id: args.plan_id || state.planId, taskname: short(args.taskname, state.taskname, 32), message: short(args.message, 'OpenCode remote operation', 200) };
      };
      return operation({ state, save, call, http, authorize, attribution });
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
      await save();
      const discovery = await http('GET', '/');
      return { config: result, workspace: { name: discovery?.name, capabilities: discovery?.capabilities }, plan_id: null };
    }),
    status: (_, context) => withSession(context, async ({ state, http }) => {
      const discovery = await http('GET', '/');
      return { taskname: state.taskname, plan_id: state.planId, workspace: { name: discovery?.name, capabilities: discovery?.capabilities } };
    }),
    request: (args, context) => withSession(context, async ({ state, save, http, authorize, attribution }) => {
      const { method, endpoint, query, json } = args;
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported HTTP method');
      validateEndpoint(endpoint);
      if (json !== undefined && (json === null || typeof json !== 'object' || Array.isArray(json))) throw new Error('json must be an object');
      const rpcMatch = /^\/?mappings\/([A-Za-z0-9_-]{24})\/rpc\/([a-z][a-z0-9_]{0,31})\/([a-z][a-z0-9_]{0,31})(?:\?|$)/.exec(endpoint);
      let rpcWrite = false;
      if (method === 'POST' && rpcMatch) {
        const listing = await http('GET', 'mappings');
        const mapping = (listing?.mappings ?? []).find((item) => item?.id === rpcMatch[1]);
        if (!mapping) throw new Error('mapping RPC target is not visible in kapsel_mappings');
        const capability = mapping.capabilities?.rpc?.[rpcMatch[2]];
        if (!capability || capability.state !== 'available') {
          throw new Error(`mapping RPC family is not available: ${rpcMatch[2]}`);
        }
        const spec = capability.operation_specs?.[rpcMatch[3]];
        if (!spec || typeof spec.write !== 'boolean' || !['sync', 'task'].includes(spec.execution)) {
          throw new Error(`mapping RPC operation lacks write/execution metadata: ${rpcMatch[2]}.${rpcMatch[3]}`);
        }
        rpcWrite = spec.write;
        if (rpcWrite && mapping.writable !== true) {
          throw new Error('mapping is read-only for this RPC write operation');
        }
      }
      const readPost = method === 'POST' && (
        /^\/?fs\/(read_many|manifest)(?:\?|$)/.test(endpoint)
        || (rpcMatch && !rpcWrite)
      );
      const mutating = !['GET', 'HEAD'].includes(method) && !readPost;
      const options = { ...(query ? { query } : {}), ...(json !== undefined ? { json } : {}) };
      if (mutating) {
        await authorize();
        if (/^\/?context(?:[/?#]|$)/.test(endpoint)) {
          options.json = { taskname: short(args.taskname, state.taskname, 32), ...json };
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
