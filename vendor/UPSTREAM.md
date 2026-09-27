# Upstream REST helpers

`openkapsel-rest/` is synchronized from `zzzmmmnn/OpenKapsel`, directory
`skills/openkapsel-rest`, including the vendored `agents/` metadata. The base
revision for this synchronization is `18d7e1bcd92b6852107294c979b359dc3c53ebc2`;
the snapshot also includes the current grouped-route documentation correction
that is still pending its next upstream commit.
The upstream project is the authoritative source for this REST contract and
Python client. Update the snapshot together; do not fork the protocol here.

The OpenCode adapter invokes only the config and HTTP helpers. Upload scripts
remain as reference material; they are not exposed as host-file upload tools.
