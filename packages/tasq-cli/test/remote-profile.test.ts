import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasRemoteProfile,
  loadRemoteProfile,
  removeRemoteProfile,
  saveRemoteProfile,
} from "../src/remote-profile.js";

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  delete process.env.TASQ_HOME;
});

describe("TQ-809 remote credential profile", () => {
  test("stores credentials atomically with private directory and file modes", () => {
    root = mkdtempSync(join(tmpdir(), "tasq-remote-profile-"));
    process.env.TASQ_HOME = join(root, "tasq-home");
    const path = saveRemoteProfile({
      contractVersion: "tasq.remote-profile.v1",
      name: "agent-one",
      endpoint: "https://server.example/",
      workspaceId: "team/alpha",
      credentialId: "credential-one",
      principalId: "principal-one",
      clientKind: "workload_agent",
      accessToken: "tasq_access_secret".padEnd(40, "x"),
      issuedAt: 10,
      expiresAt: 100,
      actionUpperBound: [{
        uri: "urn:tasq:action:workspace.read",
        version: 1,
        implementationDigest: `sha256:${"a".repeat(64)}`,
      }],
    });
    expect(statSync(join(process.env.TASQ_HOME, "remote")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadRemoteProfile("agent-one")).toMatchObject({
      principalId: "principal-one",
      accessToken: "tasq_access_secret".padEnd(40, "x"),
    });
    expect(() => saveRemoteProfile(loadRemoteProfile("agent-one"))).toThrow("--replace");
    expect(removeRemoteProfile("agent-one")).toBe(true);
    expect(hasRemoteProfile("agent-one")).toBe(false);
    expect(removeRemoteProfile("agent-one")).toBe(false);
  });
});
