# Upstream REST helpers

`openkapsel-rest/` is synchronized from `zzzmmmnn/OpenKapsel`, directory
`skills/openkapsel-rest`, including the vendored `agents/` metadata. The base
revision is OpenKapsel `9c205e1cc5e20455f9197761fd06f974fa61ef72`
(version 2.3.0), with the current uncommitted canonical REST documentation
corrections in `references/files.md` and `references/shell.md` included.
The vendored files mirror the canonical working tree byte for byte.
The upstream project is the authoritative source for this REST contract and
Python client. Update the snapshot together; do not fork the protocol here.

The OpenCode adapter invokes only the config and HTTP helpers. Upload scripts
remain as reference material; they are not exposed as host-file upload tools.
