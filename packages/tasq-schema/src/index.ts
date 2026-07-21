/**
 * @tasq/schema — public surface.
 *
 * Three sub-modules:
 *   - `./types`  Zod schemas + TS types for entities and operations
 *   - `./tables` Drizzle table definitions for storage
 *   - `./ids`    UUIDv7 generation + helpers
 *   - `./effects` exact external-effect request identity
 *
 * Re-exported here for convenience. Consumers (service, cli, future
 * MCP/REST surfaces) should import from here.
 */

export * from "./types.js";
export * from "./tables.js";
export * from "./ids.js";
export * from "./clock.js";
export * from "./extensions.js";
export * from "./discovery.js";
export * from "./effects.js";
export * from "./replication.js";
export * from "./bootstrap.js";
export * from "./resources.js";
export * from "./context.js";
export * from "./summaries.js";
export * from "./context-links.js";
export * from "./inspector.js";
export * from "./console.js";
