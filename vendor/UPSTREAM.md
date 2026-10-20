# Upstream REST helpers

`openkapsel-rest/` is synchronized from `zzzmmmnn/OpenKapsel`, directory
`skills/openkapsel-rest`, including the vendored `agents/` metadata. The base
revision is OpenKapsel `9c205e1cc5e20455f9197761fd06f974fa61ef72`
(version 2.3.0), with later OpenKapsel 2.3.2-compatible documentation
addenda in `references/context.md` (terminal Plan immutability) and
`references/files.md` (generic Function Approval, scoped `ro` elevation,
independent `protect` approvals, and absolute `deny` precedence) in addition
to prior File and Shell documentation corrections. Approval URLs last thirty
minutes; the default post-approval grant remains ten minutes. These addenda are maintained
locally until the full upstream skill snapshot is refreshed; they are not
claimed to be byte-identical to the base upstream revision.
The upstream project is the authoritative source for this REST contract and
Python client. Update the snapshot together; do not fork the protocol here.

The OpenCode adapter invokes only the config and HTTP helpers. Upload scripts
remain as reference material; they are not exposed as host-file upload tools.
