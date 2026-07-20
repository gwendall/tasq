/**
 * Deliberately unfamiliar client: no Tasq package import and no domain names.
 * It receives only the well-known document plus requested schema resources.
 */

import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || value === undefined) return "null";
  if (["string", "boolean", "number"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value !== "object") throw new Error("input is not canonical JSON data");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const input = JSON.parse(await Bun.stdin.text()) as {
  document: any;
  schemas: any[];
};
if (input.document.contractVersion !== "tasq.discovery.v1") throw new Error("unsupported discovery");
const describedTypes = input.document.extensions.flatMap((extension: any) => extension.types);
if (describedTypes.length !== input.schemas.length) throw new Error("schema resource set is incomplete");
for (const type of describedTypes) {
  const resource = input.schemas.find((candidate) => candidate.resourceId === type.resourceId);
  if (!resource || resource.schemaDigest !== type.schemaDigest) throw new Error("schema identity mismatch");
  if (digest(canonicalJson(resource.schema)) !== resource.schemaDigest) throw new Error("schema digest mismatch");
}

process.stdout.write(JSON.stringify({
  contractVersion: "tasq.client-hello.v1",
  supportedProtocolVersions: input.document.protocol.versions,
  requiredCapabilities: input.document.capabilities.map((capability: any) => ({
    uri: capability.uri,
    version: capability.version,
  })),
  requiredTypes: describedTypes.map((type: any) => ({
    typeUri: type.typeUri,
    schemaVersion: type.schemaVersion,
    schemaDigest: type.schemaDigest,
  })),
  requiredCursors: input.document.cursors.map((cursor: any) => ({
    uri: cursor.uri,
    version: cursor.version,
  })),
  knownCompatibilityDigest: input.document.compatibilityDigest,
  maxSchemaBytes: Math.max(1, ...describedTypes.map((type: any) => type.schemaBytes)),
}));
