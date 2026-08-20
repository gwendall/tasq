# @tasq-run/mcp

Capability-scoped local MCP transport over `@tasq-run/core`.

Use `createTasqMcpServer()` for an embedded host. A cold local client should
execute the fully scoped `transport.mcp.stdio` recipe returned by `tasq
onboard`; it invokes `tasq mcp` with explicit space, actor and capabilities.
The standalone `src/stdio.ts` environment composition remains available for
hosts. The stdio default is `read,propose,coordinate`; generic stdio never
exposes direction authority by default and cannot expose effect dispatch.

The optional `direction` capability composes with `propose` and protects the
metadata that admits a commitment to the public roadmap projection. Ordinary
workers can create and revise execution commitments, but cannot create a
direction-level commitment, add its reserved metadata, or revise one that
already carries it. Hosts must grant `direction` explicitly; it is absent from
all default agent recipes.

The read surface includes generic resource world/history inspection. The
coordinate surface includes acquire, renew, verify-fence, release and expiry
sweep. Resource contention is returned as structured
`tasq.resource-problem.v1`, including current holder, fence and expiry.

See [`../../TQ-302_MCP_SERVER.md`](../../docs/contracts/TQ-302_MCP_SERVER.md) for the authority,
clock and deployment boundary.
