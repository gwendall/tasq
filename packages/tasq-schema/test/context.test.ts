import { describe, expect, it } from "bun:test";
import { ContextPacketRequest } from "../src/context.js";

describe("context packet DTOs", () => {
  it("defaults to bounded portable budgets and rejects ambiguous input", () => {
    expect(ContextPacketRequest.parse({})).toEqual({
      maxRecords: 20,
      maxTokens: 8_192,
      includeDeferred: false,
      actor: null,
    });
    expect(ContextPacketRequest.safeParse({ maxRecords: 0 }).success).toBe(false);
    expect(ContextPacketRequest.safeParse({ maxTokens: 1_023 }).success).toBe(false);
    expect(ContextPacketRequest.safeParse({ unknown: true }).success).toBe(false);
  });
});
