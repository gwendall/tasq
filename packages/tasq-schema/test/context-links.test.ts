import { describe, expect, test } from "bun:test";
import {
  AttachExternalContextLinkInput,
  DEFAULT_EXTERNAL_CONTEXT_PURPOSE_URI,
  EXTERNAL_CONTEXT_LINK_CONTRACT_VERSION,
  ExternalContextLink,
  ExternalContextLinkPage,
} from "../src/context-links.js";

const linkId = "01900000-0000-7000-8000-000000000001";
const commitmentId = "01900000-0000-7000-8000-000000000002";

describe("external context-link contracts", () => {
  test("defaults a caller input to the neutral purpose and first-chain CAS", () => {
    expect(AttachExternalContextLinkInput.parse({
      workspaceId: "robotics/shared",
      commitmentId,
      target: {
        system: "https://memory.example.test",
        resourceType: "runbook",
        externalId: "calibration/left-arm",
        url: null,
        version: null,
        digest: null,
      },
    })).toMatchObject({
      purposeUri: DEFAULT_EXTERNAL_CONTEXT_PURPOSE_URI,
      expectedPreviousLinkId: null,
    });
  });

  test("requires binding and lifecycle claims to match the immutable target", () => {
    const base = {
      contractVersion: EXTERNAL_CONTEXT_LINK_CONTRACT_VERSION,
      id: linkId,
      workspaceId: "software/team-a",
      commitmentId,
      purposeUri: DEFAULT_EXTERNAL_CONTEXT_PURPOSE_URI,
      action: "attach" as const,
      supersedesLinkId: null,
      target: {
        system: "https://docs.example.test",
        resourceType: "procedure",
        externalId: "deploy/api",
        url: "https://docs.example.test/deploy/api",
        version: "v7",
        digest: null,
      },
      binding: "pinned" as const,
      actorAlias: "agent:planner",
      principalId: "principal:planner",
      createdAt: 1_000,
      state: "active" as const,
    };
    expect(ExternalContextLink.parse(base)).toEqual(base);
    expect(() => ExternalContextLink.parse({ ...base, binding: "floating" })).toThrow(
      /binding must expose/,
    );
    expect(() => ExternalContextLink.parse({
      ...base,
      action: "detach",
      state: "detached",
    })).toThrow(/detach record must supersede/);
    expect(() => ExternalContextLink.parse({ ...base, state: "detached" })).toThrow(
      /state must agree/,
    );
    expect(() => ExternalContextLinkPage.parse({
      contractVersion: "tasq.external-context-link-page.v1",
      items: [{ ...base, state: "superseded" }],
      selection: {
        mode: "current_active",
        excludes: ["detached", "superseded"],
        emptyDoesNotProveNoHistory: true,
        historyRecipeId: "context-link.history",
      },
    })).toThrow(/current-active page/);
  });

  test("rejects credentials, content and other undeclared memory fields", () => {
    expect(() => AttachExternalContextLinkInput.parse({
      workspaceId: "research/lab",
      commitmentId,
      target: {
        system: "https://notes.example.test",
        resourceType: "method",
        externalId: "assay/42",
        url: null,
        version: null,
        digest: null,
        content: "hidden body",
      },
    })).toThrow();
  });
});
