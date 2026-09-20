import { tool } from '@opencode-ai/plugin';
import { readFile } from 'node:fs/promises';
import { createBridge } from './bridge.js';

const z = tool.schema;
const topics = ['overview', 'api-basics', 'endpoint-index', 'files', 'shell', 'context', 'memory', 'sharing', 'schedules', 'web-and-apps', 'mappings'];
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
    kapsel_git: define('Read-only Git snapshot inspection. No Shell permission or Plan needed; see shell docs for snapshot limits.', {
      action: z.enum(['status', 'diff', 'diff_stat', 'log', 'show', 'ls_files']), path: path.optional(),
      revision: z.string().optional(), to_revision: z.string().optional(), staged: z.boolean().optional(),
      file: z.array(z.string()).optional(), limit: z.number().int().optional(), skip: z.number().int().optional(), timeout_seconds: z.number().int().optional(),
    }, ({ action, ...query }, ctx) => request('GET', `git/${action}`, undefined, {}, ctx, query)),
    kapsel_fs_read_many: define('Read multiple UTF-8 files with per-file status. No mutation authorization.', {
      paths: z.array(path).min(1), limit: z.number().int().positive().optional(), max_total_chars: z.number().int().positive().optional(),
    }, (body, ctx) => request('POST', 'fs/read_many', body, {}, ctx)),
    kapsel_fs_manifest: define('Read batch metadata or recursive manifest with optional SHA256. No mutation authorization.', {
      items: z.array(z.object({ path, size: z.number().int().nonnegative().optional(), sha256: z.string().optional() })).optional(),
      recursive: z.boolean().optional(), path: path.optional(), depth: z.number().int().nonnegative().optional(), include_sha256: z.boolean().optional(),
    }, (body, ctx) => request('POST', 'fs/manifest', body, {}, ctx)),
    kapsel_fs_search: define('Search UTF-8 files with include/exclude glob arrays.', {
      query: z.string(), path: path.optional(), regex: z.boolean().optional(), case_sensitive: z.boolean().optional(),
      depth: z.number().int().nonnegative().optional(), max_results: z.number().int().positive().optional(),
      include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional(),
    }, (query, ctx) => request('GET', 'fs/search', undefined, {}, ctx, query)),
    kapsel_fs_list: define('List remote directory children with pagination. Dot means workspace root.', {
      path: path.optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(),
    }, (args, ctx) => request('GET', 'fs/list', undefined, {}, ctx, { ...args, path: args.path ?? '.' })),
    kapsel_fs_stat: define('Read remote file/directory metadata, optionally selecting size, type, etag, modified_at, or sha256.', {
      path: path.optional(), fields: z.array(z.string()).optional(),
    }, (args, ctx) => request('GET', 'fs/stat', undefined, {}, ctx, { path: args.path ?? '.', fields: args.fields?.join(',') ?? 'type,size,etag,modified_at' })),
    kapsel_fs_read: define('Read a remote UTF-8 file. Use byte_offset and limit for large files.', {
      path, byte_offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(),
    }, (args, ctx) => request('GET', 'fs/read', undefined, {}, ctx, args)),
    kapsel_fs_write: define('Create or replace a remote UTF-8 file. Requires remote-write authorization and Plan attribution.', {
      path, content: z.string(), create_parents: z.boolean().optional(), ...contextFields,
    }, ({ path, content, create_parents, ...args }, ctx) => request('POST', 'fs/write', { path, content, create_parents }, args, ctx)),
    kapsel_fs_replace: define('Replace literal text in a remote file. By default the old text must occur exactly once.', {
      path, old: z.string(), new: z.string(), expected_matches: z.number().int().nonnegative().optional(), replace_all: z.boolean().optional(), ...contextFields,
    }, ({ path, old, new: replacement, expected_matches, replace_all, ...args }, ctx) => request('POST', 'fs/replace', { path, old, new: replacement, expected_matches, replace_all }, args, ctx)),
    kapsel_mappings: define('List client-backed directories, connection status, write access, and advertised execution capabilities. Check before using a mapped path or starting a client task.', {},
      (_args, ctx) => request('GET', 'mappings', undefined, {}, ctx)),
    kapsel_fs_copy: define('Start a verified asynchronous copy across workspace and client-backed storage. Existing destinations are not overwritten; poll kapsel_transfer using the returned id.', {
      source: path, destination: path, ...contextFields,
    }, ({ source, destination, ...args }, ctx) => request('POST', 'fs/copy', { source, destination }, args, ctx)),
    kapsel_fs_move: define('Move a remote path. Cross-root moves return a transfer id and recycle the source only after the copy is verified. Existing destinations are not overwritten.', {
      source: path, destination: path, ...contextFields,
    }, ({ source, destination, ...args }, ctx) => request('POST', 'fs/move', { source, destination }, args, ctx)),
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
    kapsel_client_task: define('List, start, inspect, feed stdin to, interrupt, or kill a process on a connected client mapping. Check kapsel_mappings for platform and sandbox policy first; native-unsandboxed tasks have the client OS account permissions.', {
      mapping_id: z.string(), action: z.enum(['list', 'start', 'status', 'stdin', 'interrupt', 'kill']),
      task_id: z.string().optional(), argv: z.array(z.string()).optional(), cwd: z.string().optional(),
      timeout_seconds: z.number().positive().optional(), offset: z.number().int().nonnegative().optional(),
      stdin_text: z.string().optional(), stdin_base64: z.string().optional(), eof: z.boolean().optional(), ...contextFields,
    }, ({ mapping_id, action, task_id, argv, cwd, timeout_seconds, offset, stdin_text, stdin_base64, eof, ...args }, ctx) => {
      const base = `mappings/${encodeURIComponent(mapping_id)}/tasks`;
      if (action === 'list') return request('GET', base, undefined, {}, ctx);
      if (action === 'start') {
        if (!argv?.length) throw new Error('start requires a non-empty argv array');
        return request('POST', base, { argv, cwd: cwd ?? '.', ...(timeout_seconds === undefined ? {} : { timeout_seconds }) }, args, ctx);
      }
      if (!task_id) throw new Error(`task_id is required for ${action}`);
      const endpoint = `${base}/${encodeURIComponent(task_id)}`;
      if (action === 'status') return request('GET', endpoint, undefined, {}, ctx, { offset: offset ?? 0 });
      if (action === 'stdin') {
        if (stdin_text !== undefined && stdin_base64 !== undefined) throw new Error('choose stdin_text or stdin_base64');
        if (eof && (stdin_text !== undefined || stdin_base64 !== undefined)) throw new Error('eof cannot include stdin data');
        const data = stdin_base64 ?? Buffer.from(stdin_text ?? '', 'utf8').toString('base64');
        return request('POST', `${endpoint}/stdin`, { data, ...(eof ? { eof: true } : {}) }, args, ctx);
      }
      return request('POST', `${endpoint}/${action}`, {}, args, ctx);
    }),
    kapsel_shell_exec: define('Run a Shell command on the server or a mapped client. target=auto (default) selects the client for a mapped cwd and server otherwise; client errors never fall back to server. The selected location uses its own execution limits and sandbox. Poll the unified task_id with kapsel_task_output. All Shell calls require remote-write authorization.', {
      command: z.string(), cwd: path.optional(), target: z.enum(['auto', 'server', 'client']).optional(),
      timeout_seconds: z.number().positive().optional(), interactive: z.boolean().optional(), ...contextFields,
    }, ({ command, cwd = '.', target = 'auto', timeout_seconds, interactive = false, ...args }, ctx) => request('POST', 'shell/exec', { command, cwd, target, timeout_seconds, interactive }, args, ctx)),
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
