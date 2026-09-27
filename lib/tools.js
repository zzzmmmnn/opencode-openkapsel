import { tool } from '@opencode-ai/plugin';
import { readFile } from 'node:fs/promises';
import { createBridge } from './bridge.js';

const z = tool.schema;
const topics = ['overview', 'api-basics', 'endpoint-index', 'files', 'shell', 'context', 'memory', 'sharing', 'schedules', 'web-and-apps', 'mappings', 'data-rpc', 'ssh-rpc'];
const contextFields = {
  plan_id: z.number().int().positive().optional().describe('Explicit Plan id; omitted uses this session\'s Plan.'),
  taskname: z.string().max(32).optional().describe('Task title; defaults to the session taskname, initially opencode.'),
  message: z.string().max(200).optional().describe('Short operation summary; defaults to OpenCode remote operation.'),
};
const path = z.string().describe('Path on the remote workspace; never a host path.');

export function createTools(options) {
  const bridge = createBridge(options);
  const define = (description, args, execute) => tool({ description, args, async execute(input, context) {
    const result = await execute(input, context);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } });
  const request = (method, endpoint, json, args, context, query) => bridge.request({ ...args, method, endpoint, ...(json === undefined ? {} : { json }), query }, context);
  return {
    kapsel_config: define('Select a remote workspace for this OpenCode session. Stores URL/token privately and enables automatic renewal. No remote Plan is created until the first approved mutation. Credentials supplied as tool inputs may remain in OpenCode conversation history.', {
      workspace_url: z.string(), control_token: z.string(),
      taskname: contextFields.taskname, force: z.boolean().optional().describe('Replace existing credentials for this session.'),
    }, bridge.config),
    kapsel_status: define('Get the current remote workspace capability summary, taskname, and Plan id without echoing credentials.', {}, bridge.status),
    kapsel_docs: define('Read the bundled OpenKapsel REST reference. Start with overview, then request a topic. Use kapsel_http instead of executing the Python CLI examples in these docs.', {
      topic: z.enum(topics).optional(),
    }, async ({ topic = 'overview' }) => {
      if (!topics.includes(topic)) throw new Error('Unknown documentation topic');
      const file = topic === 'overview' ? 'SKILL.md' : `references/${topic}.md`;
      return 'Use the kapsel_* tools to perform these operations. CLI examples describe the underlying protocol; host execution is unavailable.\nTopics: ' + topics.join(', ') + '\n\n'
        + await readFile(new URL('../vendor/openkapsel-rest/' + file, import.meta.url), 'utf8');
    }),
    kapsel_http: define('Call any workspace-relative REST endpoint. All endpoint-specific fields go in json (an object). Same-origin absolute /transfer/ ticket URLs are supported. Mutation methods require remote-write authorization and automatically attach Context; Context management uses its own fields. Read the relevant kapsel_docs topic first. Typed tools are conveniences, not extra authorization boundaries.', {
      method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']), endpoint: z.string(),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional(),
      json: z.record(z.string(), z.unknown()).optional(), ...contextFields,
    }, bridge.request),
    kapsel_fs_read_many: define('Read multiple UTF-8 files with per-file status. No mutation authorization.', {
      paths: z.array(path).min(1), limit: z.number().int().positive().optional(), max_total_chars: z.number().int().positive().optional(),
    }, (body, ctx) => request('POST', 'fs/read/many', body, {}, ctx)),
    kapsel_fs_manifest: define('Read batch metadata or recursive manifest with optional SHA256. No mutation authorization.', {
      items: z.array(z.object({ path, size: z.number().int().nonnegative().optional(), sha256: z.string().optional() })).optional(),
      recursive: z.boolean().optional(), path: path.optional(), depth: z.number().int().nonnegative().optional(), include_sha256: z.boolean().optional(),
    }, (body, ctx) => request('POST', 'fs/query/manifest', body, {}, ctx)),
    kapsel_fs_search: define('Search UTF-8 files with include/exclude glob arrays.', {
      query: z.string(), path: path.optional(), regex: z.boolean().optional(), case_sensitive: z.boolean().optional(),
      depth: z.number().int().nonnegative().optional(), max_results: z.number().int().positive().optional(),
      include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional(),
    }, (query, ctx) => request('GET', 'fs/query/search', undefined, {}, ctx, query)),
    kapsel_fs_list: define('List remote directory children with pagination. Dot means workspace root.', {
      path: path.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(),
    }, (args, ctx) => request('GET', 'fs/query/list', undefined, {}, ctx, { ...args, path: args.path ?? '.' })),
    kapsel_fs_stat: define('Read remote file/directory metadata, optionally selecting size, type, etag, modified_at, or sha256.', {
      path: path.optional(), fields: z.array(z.string()).optional(),
    }, (args, ctx) => request('GET', 'fs/query/stat', undefined, {}, ctx, { path: args.path ?? '.', fields: args.fields?.join(',') ?? 'type,size,etag,modified_at' })),
    kapsel_fs_read: define('Read a remote UTF-8 file. Use byte_offset and limit for large files.', {
      path, byte_offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(),
    }, (args, ctx) => request('GET', 'fs/read/text', undefined, {}, ctx, args)),
    kapsel_fs_write: define('Create a UTF-8 text file, or replace an existing file only with its exact expected_etag, through /fs/write/mutate.', {
      path, content: z.string(), expected_etag: z.string().optional().describe('Exact ETag required for replacement; omit for create-only.'), ...contextFields,
    }, ({ path, content, expected_etag, ...args }, ctx) => request('POST', 'fs/write/mutate', {
      items: [{ op: expected_etag === undefined ? 'file.create' : 'file.replace', path, content, ...(expected_etag === undefined ? {} : { expected_etag }) }],
    }, args, ctx)),
    kapsel_fs_replace: define('Replace literal text through /fs/write/mutate. Requires exact expected_etag; expected_matches defaults to 1.', {
      path, old: z.string(), new: z.string(), expected_etag: z.string(), expected_matches: z.number().int().nonnegative().optional(), ...contextFields,
    }, ({ path, old, new: replacement, expected_etag, expected_matches, ...args }, ctx) => request('POST', 'fs/write/mutate', {
      items: [{ op: 'text.replace', path, expected_etag, replacements: [{ old, new: replacement, expected_count: expected_matches ?? 1 }] }],
    }, args, ctx)),
    kapsel_mappings: define('List client-backed directories and capabilities. RPC families self-describe with family description plus per-operation description/input_schema; inspect this before kapsel_rpc.', {},
      (_args, ctx) => request('GET', 'mappings', undefined, {}, ctx)),
    kapsel_rpc: define('Invoke one dynamic RPC operation on the server workspace or a client mapping. Omit mapping_id for server RPC; provide mapping_id for client RPC. Server-capable operations come from Discovery, while mapping operations use kapsel_mappings operation_specs. execution=sync returns directly; execution=task returns a task_id polled with kapsel_task_output. Never replay an uncertain write-task start. write=true requires OpenCode approval and Plan/Context; mapped writes also require a writable mapping. No server/mapping/FUSE fallback after the target is selected.', {
      mapping_id: z.string().min(1).optional().describe('Optional mapping id from kapsel_mappings. Omit to target the server workspace.'),
      family: z.string().min(1), operation: z.string().min(1),
      args: z.record(z.string(), z.unknown()).optional(),
      timeout_seconds: z.number().positive().optional().describe('Task deadline. Server RPC allows up to 86400 seconds; mapping RPC also obeys the client task policy.'),
      ...contextFields,
    }, ({ mapping_id, family, operation, args, timeout_seconds, ...context }, ctx) => {
      const prefix = mapping_id === undefined
        ? 'rpc'
        : `mappings/${encodeURIComponent(mapping_id)}/rpc`;
      return request('POST',
        `${prefix}/${encodeURIComponent(family)}/${encodeURIComponent(operation)}`,
        { args: args ?? {}, ...(timeout_seconds === undefined ? {} : { timeout_seconds }) }, context, ctx);
    }),
    kapsel_fs_copy: define('Start a verified asynchronous copy across workspace and client-backed storage. Existing destinations are not overwritten; poll kapsel_transfer using the returned id.', {
      source: path, destination: path, ...contextFields,
    }, ({ source, destination, ...args }, ctx) => request('POST', 'fs/write/copy', { source, destination }, args, ctx)),
    kapsel_fs_move: define('Move a remote path. Cross-root moves return a transfer id and recycle the source only after the copy is verified. Existing destinations are not overwritten.', {
      source: path, destination: path, ...contextFields,
    }, ({ source, destination, ...args }, ctx) => request('POST', 'fs/write/move', { source, destination }, args, ctx)),
    kapsel_transfer: define('Inspect, cancel, or resume a cross-root file transfer returned by kapsel_fs_copy or kapsel_fs_move.', {
      transfer_id: z.string(), action: z.enum(['status', 'cancel', 'resume']), ...contextFields,
    }, ({ transfer_id, action, ...args }, ctx) => {
      const endpoint = `fs/transfers/${encodeURIComponent(transfer_id)}`;
      return action === 'status'
        ? request('GET', endpoint, undefined, {}, ctx)
        : request('POST', `${endpoint}/${action}`, {}, args, ctx);
    }),
    kapsel_recycle: define('List, restore, or permanently purge an item from the ordinary workspace (root ".") or a named client mapping. Permanent purge requires confirm=true.', {
      action: z.enum(['list', 'restore', 'purge']), root: z.string().optional(), recycle_id: z.string().optional(),
      confirm: z.boolean().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(), ...contextFields,
    }, ({ action, root = '.', recycle_id, confirm, offset, limit, ...args }, ctx) => {
      if (action === 'list') return request('GET', 'recycle/list', undefined, {}, ctx, { root, offset, limit });
      if (!recycle_id) throw new Error('recycle_id is required for restore or purge');
      if (action === 'purge' && confirm !== true) throw new Error('permanent purge requires confirm=true');
      return request('POST', `recycle/${action}`, { root, recycle_id, ...(action === 'purge' ? { confirm: true } : {}) }, args, ctx);
    }),
    kapsel_shell_exec: define('Run a Shell command on the server or a mapped client. target=auto (default) selects the client for a mapped cwd and server otherwise; client errors never fall back to server. Declare extra native dependencies using mount_mappings for server execution only; the server cwd mapping is automatic. The selected location uses its own limits and sandbox. Poll the unified task_id with kapsel_task_output. All Shell calls require remote-write authorization. Never automatically replay a start after transport uncertainty.', {
      command: z.string(), cwd: path.optional(), target: z.enum(['auto', 'server', 'client']).optional(),
      mount_mappings: z.array(z.string().min(1)).max(256).optional().describe('Additional workspace mapping names or IDs for server native filesystem access. Auto placement still follows cwd. Omit for client execution or ordinary file/RPC operations.'),
      timeout_seconds: z.number().positive().optional(), interactive: z.boolean().optional(), ...contextFields,
    }, ({ command, cwd = '.', target = 'auto', mount_mappings, timeout_seconds, interactive = false, ...args }, ctx) => {
      if (mount_mappings !== undefined) {
        if (!Array.isArray(mount_mappings) || mount_mappings.length > 256
            || mount_mappings.some(name => typeof name !== 'string' || !name || name.includes('\0'))) {
          throw new Error('mount_mappings must be an array of at most 256 non-empty mapping names or IDs without NUL');
        }
        if (target === 'client' && mount_mappings.length) {
          throw new Error('mount_mappings applies only to server execution; omit it for client tasks');
        }
      }
      return request('POST', 'shell/exec', {
        command, cwd, target, timeout_seconds, interactive,
        ...(mount_mappings === undefined ? {} : { mount_mappings }),
      }, args, ctx);
    }),
    kapsel_task_output: define('Poll remote Shell output. Server tasks have separate stdout/stderr; client tasks combine both streams in stdout with empty stderr. Advance returned next_offset cursors.', {
      task_id: z.string(), stdout_offset: z.number().int().nonnegative().optional(), stderr_offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(), wait_seconds: z.number().min(0).max(30).optional(),
    }, ({ task_id, ...query }, ctx) => request('GET', `tasks/${encodeURIComponent(task_id)}/output`, undefined, {}, ctx, query)),
    kapsel_plan_update: define('Update a remote Plan. Completion requires debrief {summary, outcome, memory_actions}. parent_plan_id is the parent, plan_id is the target. Completing the session Plan clears the cached active Plan.', {
      plan_id: z.number().int().positive(), taskname: contextFields.taskname,
      content: z.string().optional(), status: z.enum(['in_progress', 'completed', 'cancelled']).optional(),
      parent_plan_id: z.number().int().positive().optional(), move_to_root: z.boolean().optional(),
      debrief: z.object({ summary: z.string(), outcome: z.enum(['succeeded', 'partial', 'no_change']), memory_actions: z.array(z.record(z.string(), z.unknown())) }).optional(),
    }, ({ plan_id, parent_plan_id, move_to_root, ...json }, ctx) => {
      if (parent_plan_id && move_to_root) throw new Error('parent_plan_id and move_to_root are mutually exclusive');
      if (json.status === 'completed' && !json.debrief) throw new Error('Completing a Plan requires a structured debrief');
      if (json.debrief && json.status !== 'completed') throw new Error('debrief requires completed status');
      if (json.content === undefined && !json.status && !parent_plan_id && !move_to_root) throw new Error('No Plan changes supplied');
      if (parent_plan_id || move_to_root) json.plan_id = move_to_root ? null : parent_plan_id;
      return request('PATCH', `context/plans/${plan_id}`, json, {}, ctx);
    }),
  };
}
