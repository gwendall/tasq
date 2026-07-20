/** Provider-neutral canonical JSON and content digest helpers. */

import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical JSON does not support non-finite numbers");
  }
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical JSON requires plain JSON objects");
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  throw new Error(`Canonical JSON does not support ${typeof value}`);
}

export function sha256Digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
