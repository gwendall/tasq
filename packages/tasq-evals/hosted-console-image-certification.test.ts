import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  requireExplicitServerImage,
  requireTasqServerOciIdentity,
  resolvesRequestedPublishedDigest,
  sensitiveCommandFailure,
  type TasqServerImageInspection,
} from "./hosted-console-image-contract.js";

const imageId = `sha256:${"a".repeat(64)}`;
const validInspection: TasqServerImageInspection = {
  Id: imageId,
  RepoDigests: null,
  Architecture: "arm64",
  Os: "linux",
  Config: {
    Labels: {
      "org.opencontainers.image.title": "Tasq Server",
      "org.opencontainers.image.source": "https://github.com/gwendall/tasq",
      "org.opencontainers.image.licenses": "Apache-2.0",
      "org.opencontainers.image.version": "0.0.0-tq811.local",
      "org.opencontainers.image.revision": "b".repeat(40),
    },
  },
};

describe("TQ-811 hosted Console image certification contract", () => {
  test("requires an explicit non-latest tag or digest", () => {
    expect(() => requireExplicitServerImage(undefined)).toThrow("--image is required");
    expect(() => requireExplicitServerImage("tasq-server")).toThrow("explicit non-latest tag");
    expect(() => requireExplicitServerImage("tasq-server:latest")).toThrow("explicit non-latest tag");
    expect(requireExplicitServerImage("tasq-server:tq811-local")).toBe("tasq-server:tq811-local");
    expect(requireExplicitServerImage(`ghcr.io/gwendall/tasq-server@sha256:${"c".repeat(64)}`))
      .toEndWith(`@sha256:${"c".repeat(64)}`);
  });

  test("fails closed unless every release identity label is exact", () => {
    expect(requireTasqServerOciIdentity(validInspection)).toEqual({
      title: "Tasq Server",
      source: "https://github.com/gwendall/tasq",
      license: "Apache-2.0",
      version: "0.0.0-tq811.local",
      revision: "b".repeat(40),
    });
    for (const label of Object.keys(validInspection.Config.Labels!)) {
      const changed = structuredClone(validInspection);
      delete changed.Config.Labels![label];
      expect(() => requireTasqServerOciIdentity(changed), label).toThrow();
    }
  });

  test("recognizes an exact published digest only when the requested repository digest resolves", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const requested = `ghcr.io/gwendall/tasq-server@${digest}`;
    expect(resolvesRequestedPublishedDigest("tasq-server:tq811-local", validInspection)).toBe(false);
    expect(resolvesRequestedPublishedDigest(requested, validInspection)).toBe(false);
    expect(resolvesRequestedPublishedDigest(requested, {
      ...validInspection,
      RepoDigests: [requested],
    })).toBe(true);
  });

  test("never includes enrollment or access credentials in sensitive command failures", () => {
    const message = sensitiveCommandFailure(
      1,
      "tasq_enroll_enrollment-secret",
      "tasq_access_credential-secret",
    );
    expect(message).toBe("sensitive command failed (1): [redacted sensitive command output]");
    expect(message).not.toContain("tasq_enroll_");
    expect(message).not.toContain("tasq_access_");
  });

  test("the real browser path asserts cookie, guard denial and receipt replay without traces", async () => {
    const root = resolve(import.meta.dir, "..");
    const [scenario, config, certifier, hostedConsole] = await Promise.all([
      readFile(resolve(root, "tasq-inspector/hosted-browser/hosted-console-image.pw.ts"), "utf8"),
      readFile(resolve(root, "tasq-inspector/hosted-browser.playwright.config.ts"), "utf8"),
      readFile(resolve(import.meta.dir, "scripts/certify-hosted-console-image.ts"), "utf8"),
      readFile(resolve(root, "tasq-server/src/hosted-console.ts"), "utf8"),
    ]);
    expect(scenario).toContain('"__Host-tasq_session"');
    expect(scenario).toContain("authentication_required");
    expect(scenario).toContain("const attacker = await page.context().newPage()");
    expect(scenario).toContain("await attacker.setContent");
    expect(scenario).toContain("Cross-origin submit");
    expect(scenario).toContain("receiptReplay: true");
    expect(config).toContain('trace: "off"');
    expect(config).toContain('video: "off"');
    expect(config).toContain("outputDir");
    expect(certifier).toContain('"one_use_human_device_enrollment_redeemed"');
    expect(certifier).toContain("TASQ_TQ811_PLAYWRIGHT_OUTPUT");
    expect(certifier).toContain("directConsoleCoreMutationPath: false");
    expect(certifier).toContain("exactPublishedDigest");
    expect(certifier).not.toContain('responseHeaders.set("referrer-policy"');
    expect(hostedConsole).toContain('"referrer-policy": "same-origin"');
  });
});
