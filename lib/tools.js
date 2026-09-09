import { tool } from '@opencode-ai/plugin';
import { readFile } from 'node:fs/promises';
import { createBridge } from './bridge.js';

const z = tool.schema;
const topics = ['overview', 'api-basics', 'endpoint-index', 'files', 'shell', 'context', 'memory', 'sharing', 'schedules', 'web-and-apps'];
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
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      json: z.record(z.string(), z.unknown()).optional(), ...contextFields,
    }, bridge.request),
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
    kapsel_shell_exec: define('Execute a command ONLY on the remote server, under that token\'s sandbox and limits. Poll returned task_id using kapsel_task_output. All Shell calls require remote-write authorization.', {
      command: z.string(), cwd: path.optional(), timeout_seconds: z.number().positive().optional(), interactive: z.boolean().optional(), ...contextFields,
    }, ({ command, cwd = '.', timeout_seconds, interactive = false, ...args }, ctx) => request('POST', 'shell/exec', { command, cwd, timeout_seconds, interactive }, args, ctx)),
    kapsel_task_output: define('Poll remote Shell stdout/stderr. Advance returned next_offset cursors on subsequent calls.', {
      task_id: z.string(), stdout_offset: z.number().int().nonnegative().optional(), stderr_offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(), wait_seconds: z.number().min(0).max(60).optional(),
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
