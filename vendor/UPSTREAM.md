# Upstream REST helpers

`openkapsel-rest/` is vendored unchanged from `zzzmmmnn/OpenKapsel`, commit
`a0f4b251f8ab184203201c6659bc71760c15bb1d` (OpenKapsel 1.60.1), directory `skills/openkapsel-rest`
(excluding the Codex-specific `agents/` metadata).
The upstream project is the authoritative source for this REST contract and
Python client. Update the snapshot together; do not fork the protocol here.

The OpenCode adapter invokes only the config and HTTP helpers. Upload scripts
remain as reference material; they are not exposed as host-file upload tools.
