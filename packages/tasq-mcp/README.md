# @tasq/mcp

Capability-scoped local MCP transport over `@tasq/core`.

Use `createTasqMcpServer()` for an embedded host. A cold local client should
execute the fully scoped `transport.mcp.stdio` recipe returned by `tasq
onboard`; it invokes `tasq mcp` with explicit space, actor and capabilities.
The standalone `src/stdio.ts` environment composition remains available for
hosts. The stdio default is `read,propose,coordinate`; generic stdio never
exposes effect dispatch.

The read surface includes generic resource world/history inspection. The
coordinate surface includes acquire, renew, verify-fence, release and expiry
sweep. Resource contention is returned as structured
`tasq.resource-problem.v1`, including current holder, fence and expiry.

See [`../../TQ-302_MCP_SERVER.md`](../../TQ-302_MCP_SERVER.md) for the authority,
clock and deployment boundary.
