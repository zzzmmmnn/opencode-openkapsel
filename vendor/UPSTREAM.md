# Upstream REST helpers

`openkapsel-rest/` is vendored unchanged from `zzzmmmnn/OpenKapsel`, commit
`1de0bf52a24c85bd9adee83ad12d75934bfd6e58` (OpenKapsel 1.57.0), directory `skills/openkapsel-rest`
(excluding the Codex-specific `agents/` metadata).
The upstream project is the authoritative source for this REST contract and
Python client. Update the snapshot together; do not fork the protocol here.

The OpenCode adapter invokes only the config and HTTP helpers. Upload scripts
remain as reference material; they are not exposed as host-file upload tools.
