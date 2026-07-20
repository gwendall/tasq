import { describe, expect, it } from "bun:test";
import { ClientHello, OnboardingResponse } from "../src/discovery.js";

const digest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

describe("discovery DTO invariants", () => {
  it("strictly rejects duplicate hello requirements and unknown keys", () => {
    const base = {
      contractVersion: "tasq.client-hello.v1",
      supportedProtocolVersions: [1],
      requiredCapabilities: [],
      requiredTypes: [],
      requiredCursors: [],
    };
    expect(ClientHello.safeParse({ ...base, unknown: true }).success).toBe(false);
    expect(ClientHello.safeParse({
      ...base,
      requiredCapabilities: [
        { uri: "https://schemas.example.test/capability", version: 1 },
        { uri: "https://schemas.example.test/capability", version: 1 },
      ],
    }).success).toBe(false);
  });

  it("does not admit contradictory onboarding status/subset/problem shapes", () => {
    const base = {
      contractVersion: "tasq.onboarding.v1",
      compatibilityDigest: digest,
      capabilities: [], types: [], cursors: [], problems: [],
    };
    expect(OnboardingResponse.safeParse({
      ...base, status: "compatible", selectedProtocolVersion: 1,
    }).success).toBe(true);
    expect(OnboardingResponse.safeParse({
      ...base, status: "compatible", selectedProtocolVersion: null,
    }).success).toBe(false);
    expect(OnboardingResponse.safeParse({
      ...base, status: "incompatible", selectedProtocolVersion: 1,
    }).success).toBe(false);
    expect(OnboardingResponse.safeParse({
      ...base,
      status: "refresh_required",
      selectedProtocolVersion: null,
      problems: [{ code: "missing_type", path: "requiredTypes[0]", message: "missing" }],
    }).success).toBe(false);
  });
});
