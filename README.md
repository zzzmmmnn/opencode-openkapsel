# opencode-openkapsel

Operate an **OpenKapsel remote workspace from OpenCode**: read and edit files,
run remote Shell tasks, manage Plans, and access the remaining REST interfaces.
The plugin supplies **OpenKapsel** and **OpenKapsel Read-only** agents.

## Install from GitHub

Requires OpenCode, Node.js 22+, and Python 3.10+. Python must be available as
`python3` on macOS/Linux or `python` on Windows. Bash is not required by the adapter.

Install globally from GitHub (the same command works in PowerShell, Bash, and
Zsh):

```sh
opencode plugin --global github:zzzmmmnn/opencode-openkapsel
```

Restart OpenCode after installing or upgrading. The plugin adds **OpenKapsel**
and **OpenKapsel Read-only** without changing the default agent. Select an
OpenKapsel agent for a remote session; Build and Plan remain available for
ordinary local work.

execution guard follows each session's selected agent: OpenKapsel agents are
remote-only, while Build, Plan, and other agents retain their normal tools.
Conversely, OpenKapsel tools are denied outside the two OpenKapsel agents.

Run the global install command again to update. Remove it with OpenCode's global
plugin management command when it is no longer needed.

## Connect and use

Give the agent the read-only workspace URL and matching control token. It calls
`kapsel_config` once, then uses the selected workspace for the current session.
Example tool arguments (placeholders, not real credentials):

```json
{
  "workspace_url": "https://example.com/kapsel/w/READ_TOKEN",
  "control_token": "CONTROL_TOKEN",
  "taskname": "website"
}
```

New sessions need their own configuration. Resuming a session reuses its private
credentials and active Plan. Use `force: true` with `kapsel_config` to switch that
session to a different workspace. Two sessions can connect to different tokens.

| Tools | Purpose |
|---|---|
| `kapsel_config`, `kapsel_status` | Connection setup and capability summary |
| `kapsel_docs` | On-demand reference chapters; start with `overview` |
| `kapsel_fs_list`, `kapsel_fs_stat`, `kapsel_fs_read` | Remote directory/file reads; `.` means the workspace root |
| `kapsel_fs_write`, `kapsel_fs_replace` | Remote text creation and editing |
| `kapsel_mappings` | Client-backed directories, connection state, and advertised execution/RPC capabilities |
| `kapsel_archive` | Browse ZIP/tar archives or read bounded members without extracting; mapped archives use client RPC |
| `kapsel_rpc` | Unified server/mapping RPC entry: omit `mapping_id` for the server workspace or provide it for a client mapping; sync returns directly, task returns a normal server or unified client task id; writes use OpenCode approval + Plan/Context and mapped writes require a writable mapping |
| `kapsel_fs_copy`, `kapsel_fs_move`, `kapsel_transfer` | Cross-root file copy/move and asynchronous transfer control |
| `kapsel_recycle` | List, restore, or explicitly purge entries in a selected recycle root |
| `kapsel_client_task` | List/start legacy client Shell tasks and inspect/interrupt/kill unified client task ids returned by `kapsel_rpc`/`kapsel_shell_exec`; RPC tasks do not accept stdin |
| `kapsel_shell_exec`, `kapsel_task_output` | Server or mapped-client Shell execution and incremental output polling |
| `kapsel_plan_update` | Plan updates and completion with a structured debrief |
| `kapsel_http` | Remaining REST APIs: directories, recycle bin, batch edits, Memory, sharing, schedules, preview, environment configuration, and other endpoints |

Put endpoint-specific request fields inside the `json` object of `kapsel_http`.
It accepts workspace-relative endpoints and same-origin absolute transfer-ticket
URLs. It cannot run the CLI options or upload arbitrary host files. Binary file
transfers and continuous SSE are not exposed as host streaming tools; use the
documented remote APIs and output polling as applicable.

For mapped directories, call `kapsel_mappings` first. Client tasks use an
`argv` array and an export-relative `cwd`; they run on that client, not in the
server Shell. Inspect the advertised sandbox mode before execution:
`native-unsandboxed` has the client OS account's permissions. Task output is
base64-encoded with a `next_offset` cursor. Mutating actions use the same
OpenCode approval and Plan attribution as other remote writes. See
`kapsel_docs` with topic `mappings` for transfer and recycle failure states.

`kapsel_shell_exec` accepts `target: "auto"` (default), `"server"`, or
`"client"`. Auto selects a client when `cwd` is inside its mapping (such as
`laptop/project`); another cwd selects the server. An offline or denied client
fails without server fallback. A client needs OpenKapsel 1.60.0+ and a writable
execution-enabled mapping. Its platform, sandbox, and limits apply; server
`/env` is not injected. `kapsel_task_output` accepts either task location's ID;
client stdout/stderr are combined in stdout. The ordinary `/tasks` control APIs
remain available through `kapsel_http` (client stdin: at most 16 KiB per call).
Use `kapsel_client_task` for literal client `argv` arrays.

Each approved recorded mutation gets `plan_id`, `taskname` (up to 32 characters),
and `message` (up to 200 characters). The first mutation creates a new session
Plan if none was specified. It does not adopt another agent's open Plan. Context
management requests use their own attribution fields. Completing or cancelling
the current Plan clears the active Plan so the next task gets a new one.

## Permissions and data

| Area | Behavior |
|---|---|
| **OpenKapsel** | Remote mutations allowed by the agent policy; server token grants still apply |
| **OpenKapsel Read-only** | Reads run normally; mutations call OpenCode's `kapsel_write` approval before any Plan creation or write. Denying approval prevents the request |
| Local tools | File, Shell, search, skill discovery, code execution, delegation, and unknown/MCP tools are blocked by an exact-name execution guard |
| Other allowed tools | OpenCode question and todo tools |
| Host access | A fixed Python helper reads/writes private session state and sends HTTP requests. It starts with `shell: false`, isolated Python imports, and JSON on stdin |
| External service | The user-selected OpenKapsel server receives requested file contents, commands and API data |
| Credential renewal | Under two days remaining, the upstream helper renews credentials and saves replacements. Calls within a session are serialized to avoid renewal races |
| Credentials in output | Stored tokens and capability URLs are redacted from helper results and errors |
| Conversation history | URL/token supplied to `kapsel_config` remain tool inputs: OpenCode and the model provider may retain them. Output redaction does not erase the conversation |
| Filesystem protection | Unix state directories use `0700`, files `0600`. Windows uses the user directory's inherited ACLs |

State lives in `$XDG_STATE_HOME/opencode-openkapsel/<sha256-session-id>/`, or
`~/.local/state/opencode-openkapsel/<sha256-session-id>/` when unset. Each session
contains `.openkapsel.env` and `session.json`. Neither belongs in a project repo.
Keep one OpenCode process responsible for a given session's credential file.

The guard limits **model-issued tool calls**. It is not an OS sandbox for the
OpenCode process, user-entered terminal commands, other trusted plugins, or
OpenCode's own startup/context discovery. Use an empty dedicated local directory;
OpenCode can still load its local configuration and instructions independently
of tools. A user with control of the host/configuration can change this setup.
Remote security remains enforced by OpenKapsel and the token's grants.

Typed tools improve call accuracy; generic `kapsel_http` is intentionally broad
and is not an additional endpoint authorization layer. It checks HTTP mutation
methods, so custom backend authors must not put state-changing actions in GET
routes. Automatic credential renewal can happen during reads as well.

## Compatibility and development

The adapter targets the OpenCode 1.x plugin API and pins its SDK to `1.18.21`.
OpenCode V2's different configuration API is not claimed compatible.

| Platform | Verification |
|---|---|
| macOS | Passed Node/Python integration tests and real OpenCode 1.18.21 execution with mock inference: configuration, remote Shell, automatic Plan creation, and attempted local-tool rejection |
| Linux / Windows | CI matrix provided; platform results require the workflow to run |
| Runtimes | CI covers Node 22/24 and Python 3.10/3.14; helpers use Python's standard library |

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

The optional runtime test starts a real installed OpenCode with temporary user
directories and local mock model/workspace servers. No paid model or server
credentials are needed:

```sh
# Bash/Zsh
OPENKAPSEL_RUNTIME_TEST=1 node --test tests/runtime.test.js
```

```powershell
# PowerShell
$env:OPENKAPSEL_RUNTIME_TEST = "1"
node --test tests/runtime.test.js
```

`vendor/openkapsel-rest` is an unchanged snapshot of the OpenKapsel project's
client and reference documentation; [upstream provenance](vendor/UPSTREAM.md)
records the revision. Maintain the protocol there and update this snapshot.

MIT licensed. Independent community integration, not an official OpenCode product.

## Unified RPC and read-side tools

Version 0.3.0 adds `kapsel_git` (status/diff/diff_stat/log/show/ls_files),
`kapsel_fs_read_many`, `kapsel_fs_manifest`, and `kapsel_fs_search`.
The current unified RPC contract targets OpenKapsel 1.62.0+. Git read operations
remain independent of Shell/client execution permission and use bounded
sanitized snapshots. Git `add`, `commit`, `restore`, `checkout`,
`fetch`, `pull`, and `clone` are `write=true, execution=task`;
Archive `create` and `extract` use the same task model.

`kapsel_rpc` is the single dynamic RPC entry point for both locations. Omit
`mapping_id` to target the server workspace; provide a mapping id to target a
client mapping. Server-capable families are advertised by Discovery under
`capabilities.mappings.rpc.families` with `server_rpc` and operation
categories such as `sync_reads` / `task_writes`. Client mappings continue to
publish per-operation `description`, JSON `input_schema`, boolean `write`,
and `execution` through `kapsel_mappings`.

A server task returns a normal server task id; a mapping task returns a unified
`client.<mapping>.<task>` id. Poll either with `kapsel_task_output`. Mapping
RPC tasks can additionally be inspected/controlled with `kapsel_client_task`;
server task controls use the ordinary `/tasks` REST lifecycle. Never replay an
uncertain write-task start. `write=true` always uses OpenCode approval plus
OpenKapsel Plan/Context; mapped writes additionally require the mapping to be
administratively writable. There is no server/mapping/FUSE fallback after the
RPC target is selected. `kapsel_archive` remains a read-preview convenience
tool; Archive create/extract use `kapsel_rpc`.

The generic HTTP tool recognizes POST `fs/read_many` and `fs/manifest` as
read-only. It also classifies both `rpc/<family>/<operation>` and
`mappings/<24-char-id>/rpc/<family>/<operation>` from runtime RPC metadata, so
RPC reads bypass mutation approval while writes use approval and Plan
attribution. Archive preview uses GET `archive/list` and `archive/read`.
Other POST operations retain their existing guard. Query values may be arrays
to send repeated parameters, e.g. `include: ["*.py", "*.js"]` or
`file: ["a", "b"]`. The vendored REST skill is synchronized with the main
OpenKapsel project. Server RPC task deadlines default to 600 seconds unless
overridden (maximum 86400); mapped RPC task deadlines also obey the client task
policy. The bundled HTTP helper waits 120 seconds and the OpenCode helper process
budget is 130 seconds for ordinary synchronous requests.

## Client reconnects and portable text

The bundled REST references track OpenKapsel 1.62.0. The current mapping
handshake requires client 1.62.0+.

A network disconnect does not stop tasks in the running client process.
Reconnect and list/query the original task IDs to retrieve output and exit
status, including tasks that completed offline, or to send stdin/interrupt/kill.
Deadlines continue offline. Uncollected results remain in bounded client memory;
the registry limit is max_tasks + 4. Reading through completed output marks a
result collected; collected results have one-hour/four-record retention and may
be evicted earlier for capacity. Client process restarts do not restore tasks.
Do not automatically replay a start whose response was lost.

Text APIs default to UTF-8 without using the host locale. For a non-default
encoding use `kapsel_http`: pass `encoding` in the `query` for GET `fs/read`,
in `json` for POST `fs/read_many`, `fs/write`, or `fs/replace`, and in each
`json.items[]` entry for `fs/replace/batch`. Typed file tools still use their
existing default encoding; they do not expose this new field.

Supported codecs include UTF-8/BOM, explicit-endian UTF-16, Big5, GBK/GB18030,
Windows-1252, Latin-1, ASCII, and Shift-JIS. See the bundled files reference for
exact codec names and BOM rules. There is no guessing or lossy conversion.
LF, CRLF, and CR remain literal: exact replacements must match original endings,
and new text chooses its own endings. UTF-8-only byte cursors and search retain
their existing restrictions.

## RPC-first mappings (OpenKapsel 1.61.0+)

`kapsel_mappings` may report `online: true` and `mounted: false`: this is normal.
Use file, search, copy/transfer, archive and RPC tools directly; never mount a
mapping or run a Shell command just to make those interfaces work. Static preview
also uses RPC. Keep the default `target: "auto"`: a mapped cwd executes on its
client without a server mount; other working directories execute on the server.

For intentional server execution, the cwd mapping is automatic. Declare other
native filesystem dependencies with the optional `mount_mappings` array of at
most 256 non-empty workspace mapping names or IDs:

```json
{
  "command": "python laptop/project/main.py",
  "cwd": ".",
  "target": "server",
  "mount_mappings": ["laptop"]
}
```

Pass this to `kapsel_shell_exec`, or put it in `kapsel_http.json` for POST
`shell/exec`. The field does not change auto placement, and non-empty dependencies
are invalid for client execution. Both routes retain normal write approval and
Plan/Context attribution. Do not parse commands to guess dependencies or default
to mounting every mapping.

FastAPI's extra native dependencies belong in the application's
`api/mappings.json`, for example `{"mount_mappings":["datasets"]}`. Its containing
mapping is automatic. Mount leases follow the task or API worker, not one HTTP
request; ordinary file operations never use FUSE fallback. A server may disable
native mounts while leaving file/RPC and client execution available.

Current clients always enable core file RPC: **rpc.file has been removed**;
remove that key from older client configurations. Upgrade both client and server
for `file_stream` metadata. Treat `unavailable_mappings`, `truncated`, and
unavailable tree/manifest nodes as incomplete results, not missing files. After
a timeout, cancellation or lost write/start response, inspect existing tasks and
affected paths; never automatically replay the command or RPC mutation.

The bundled skill's mappings, Shell and web/application references document the
contract. Runtime Discovery remains authoritative for server-version differences.

## Structured configuration and large tables

Use `kapsel_mappings` to inspect the client's `structured` and `tabular` schemas,
then call `kapsel_rpc`. Structured JSON/YAML/TOML edits use conditional atomic
write/patch tasks; CSV/Excel operations are read-only, including asynchronous
`tabular.scan`. CSV pages use authenticated seek cursors, not repeated row-offset
scans. Segment scans return explicit progress/continuation and must not be
mistaken for complete whole-file aggregates. Format availability depends on
optional libraries installed on the mapping client. No FUSE is needed.

Read `kapsel_docs` with `topic: "data-rpc"` for the complete contract.

## SSH RPC

Use `kapsel_mappings` to inspect the client's `ssh` capability, then call
`kapsel_rpc`. SSH profiles and credentials stay on the mapping client. The
first operation may select a configured profile and returns a process-scoped
`connection_id`; later `exec`, SFTP read/list/stat, upload, and download
operations can reuse the same authenticated transport. Connections expire after
60 seconds idle by default, but active commands or transfers do not count as
idle. Expired, lost, and explicitly closed IDs fail distinctly and are never
silently reconnected.

All SSH operations advertise `write=true`, including remote reads, because
using client-local SSH credentials is privileged external access. They therefore
require OpenCode write approval, OpenKapsel Plan/Context, and an administratively
writable mapping. Never automatically replay `ssh_execution_uncertain` after a
transport loss. Paramiko is required only on the mapping client, not by this
OpenCode plugin.

The vendored `openkapsel-rest` skill includes `references/ssh-rpc.md`.

## Atomic plan batches

On a server advertising `capabilities.context.plan_creation.atomic_subplans`,
use `kapsel_http` once with `method: "POST"`, `endpoint: "context"` and `json`
containing `type: "plan"`, `taskname`, `content`, optional `request_id`, and
`subplans: [{"ref":"code","content":"Implement"},{"ref":"tests","content":"Verify"}]`.
The response returns the parent `id` and every child's `id`/`plan_id`/`ref`.
Pass a returned child ID to subsequent mutation tools; no extra Plan creation is
necessary. Do not put endpoint fields beside `json`.

The server creates the complete batch atomically. Reuse the same `request_id`
and request only to recover an uncertain response, not to start new work. The
plugin does not automatically replay failed writes or change its approval policy.
See the bundled Context reference for direct-child limits and idempotency rules.

## OAuth browser consent is separate from this REST bridge

OpenKapsel OAuth-capable MCP clients use the independent browser consent page. A user verifies ownership there with the current control token for the exact linked configuration; administrator login is not required. This plugin continues using its existing REST credentials and never submits them to a browser form or client callback. OAuth access/refresh credentials remain separate from REST credentials. Updating server consent does not require a new plugin transport or new tool. If you already have an authenticated OAuth or Static MCP connection on another platform, the server-side `get_workspace_credentials` tool can export the current REST workspace URL/control token for configuring this plugin, and `renew_workspace_credentials` can rotate that REST pair inside the normal renewal window without changing the MCP credential.
