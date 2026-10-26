# Vendored OpenKapsel REST skill

`vendor/openkapsel-rest/` is synchronized from `zzzmmmnn/OpenKapsel`,
`skills/openkapsel-rest/`, at source commit
`f4208159cb22bbaf13116271b0c01692103bd72c` (OpenKapsel 2.4.0).
All tracked Markdown references, SKILL.md, and Python upload/config/HTTP helpers
are byte-identical to that upstream source; OS-generated caches and metadata
are excluded. Update the entire snapshot together to avoid protocol drift.

The OpenCode adapter invokes only the config and HTTP helpers from the
vendored skill. The upload scripts are included as protocol documentation
and cannot access or upload arbitrary host files through OpenCode tools.
Use current workspace-relative endpoints: `fs/content` for raw file bytes,
`upload/create`, `upload/status/<id>`, `upload/chunk/<id>`,
`upload/commit/<id>` and `upload/cancel/<id>` for resumable transfer, and
`fs/transfer/<id>` for asynchronous cross-root copy/move tracking.
Deprecated service-origin `/transfer/*` aliases and `/uploads/*` routes
are not supported by this adapter.
