/** Language-neutral client helpers. Deliberately imports no Tasq package. */

import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null) return "null";
  if (["string", "boolean", "number"].includes(typeof value)) return JSON.stringify(value);
  if (typeof value !== "object") throw new Error("input is not JSON data");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function onboard(input: any, protocolVersion: string) {
  const document = input.document;
  if (document.contractVersion !== "tasq.discovery.v1") throw new Error("unsupported discovery contract");
  if (input.adapterManifest?.contractVersion !== "tasq.protocol-adapter.v1") {
    throw new Error("unsupported adapter contract");
  }
  if (input.adapterManifest.completionAuthority !== "none") {
    throw new Error("execution adapter unexpectedly has commitment authority");
  }
  if (!input.adapterManifest.requiresInjectedClock) throw new Error("adapter clock is not injectable");
  const mapping = input.adapterManifest.mappings.find((candidate: any) =>
    candidate.protocolVersion === protocolVersion);
  if (!mapping) throw new Error(`required execution protocol is unavailable: ${protocolVersion}`);

  const describedTypes = document.extensions.flatMap((extension: any) => extension.types);
  if (describedTypes.length !== input.schemas.length) throw new Error("schema resource set is incomplete");
  for (const type of describedTypes) {
    const resource = input.schemas.find((candidate: any) => candidate.resourceId === type.resourceId);
    if (!resource || resource.schemaDigest !== type.schemaDigest) throw new Error("schema identity mismatch");
    if (digest(canonicalJson(resource.schema)) !== resource.schemaDigest) throw new Error("schema digest mismatch");
  }

  return {
    contractVersion: "tasq.client-hello.v1",
    supportedProtocolVersions: document.protocol.versions,
    requiredCapabilities: document.capabilities.map((capability: any) => ({
      uri: capability.uri,
      version: capability.version,
    })),
    requiredTypes: describedTypes.map((type: any) => ({
      typeUri: type.typeUri,
      schemaVersion: type.schemaVersion,
      schemaDigest: type.schemaDigest,
    })),
    requiredCursors: document.cursors.map((cursor: any) => ({
      uri: cursor.uri,
      version: cursor.version,
    })),
    knownCompatibilityDigest: document.compatibilityDigest,
    maxSchemaBytes: Math.max(1, ...describedTypes.map((type: any) => type.schemaBytes)),
  };
}

export function validatePacket(input: any): void {
  const packet = input.packet;
  const resource = input.schemas.find((candidate: any) =>
    candidate.typeUri === packet.typeUri && candidate.schemaVersion === packet.schemaVersion);
  if (!resource) throw new Error("work packet type was not discovered");
  const schema = resource.schema;
  if (schema.type !== "object" || typeof packet.payload !== "object" || packet.payload === null) {
    throw new Error("work packet does not satisfy its object schema");
  }
  const payload = packet.payload as Record<string, unknown>;
  for (const required of schema.required ?? []) {
    if (!(required in payload)) throw new Error(`work packet is missing required field ${required}`);
  }
  for (const [key, value] of Object.entries(payload)) {
    const expected = schema.properties?.[key]?.type;
    if (!expected) {
      if (schema.additionalProperties === false) throw new Error(`work packet has unknown field ${key}`);
      continue;
    }
    const valid = expected === "integer"
      ? Number.isInteger(value)
      : expected === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : typeof value === expected;
    if (!valid) throw new Error(`work packet field ${key} is not ${expected}`);
  }
}

export function validateEventResume(events: any[], afterSequence: number): void {
  let prior = afterSequence;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= prior) {
      throw new Error("event resume cursor is not strictly monotone and exclusive");
    }
    prior = event.sequence;
  }
}
