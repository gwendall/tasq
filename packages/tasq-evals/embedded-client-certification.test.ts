import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const certificate = JSON.parse(readFileSync(
  resolve(root, "docs/contracts/TQ-611_EMBEDDED_TYPESCRIPT_CLIENT.json"),
  "utf8",
));
const kernel = readFileSync(resolve(root, "packages/tasq-core/src/kernel.ts"), "utf8");
const builder = readFileSync(resolve(root, "scripts/release/build-public-packages.ts"), "utf8");
const example = readFileSync(
  resolve(root, "packages/tasq-core/examples/local-client.mjs"),
  "utf8",
).trim();
const packageReadme = readFileSync(resolve(root, "packages/tasq-core/README.md"), "utf8");
const acceptanceTest = readFileSync(
  resolve(root, "packages/tasq-cli/test/public-packages.test.ts"),
  "utf8",
);

describe("TQ-611 embedded TypeScript client certification", () => {
  test("binds the accepted package seam and explicit composition interface", () => {
    expect(certificate).toMatchObject({
      contractVersion: "tasq.embedded-typescript-client-certification.v1",
      status: "published-byte-certified",
      packageBoundary: {
        package: "@tasq-run/core",
        newPackageRejected: "@tasq-run/client",
        entrypoint: "createLocalTasq",
      },
      interface: {
        requiredInputs: ["url", "workspaceId", "actor", "clock"],
        operationGroups: [
          "commitments",
          "claims",
          "attempts",
          "evidence",
          "resources",
          "inspection",
          "events",
          "cursors",
        ],
      },
      publication: {
        targetVersion: "0.2.0",
        state: "published-certified",
        sourceCommit: "28f4d77477e81ae2277f73f326c8703e7124f192",
        releaseWorkflow: "https://github.com/gwendall/tasq/actions/runs/30041513292",
        postReleaseCertification: "https://github.com/gwendall/tasq/actions/runs/30042551026",
        publishedByteReplay: "passed",
        publicSiteClaimAllowed: true,
      },
    });
    expect(certificate.runtimes).toEqual([
      expect.objectContaining({
        name: "bun",
        publishedFreshInstall: "passed",
        publishedSameLedgerRestart: "passed",
      }),
      expect.objectContaining({
        name: "node",
        publishedFreshInstall: "passed",
        publishedSameLedgerRestart: "passed",
      }),
    ]);
    expect(kernel).toContain('export { createLocalTasq } from "./local-client.js"');
  });

  test("publishes compiled ESM and declarations for the certified dependency closure", () => {
    expect(certificate.distribution).toMatchObject({
      format: "compiled-esm-plus-declarations",
      compiledPackages: [
        "@tasq-run/schema",
        "@tasq-run/extension-sdk",
        "@tasq-run/core",
      ],
      packageRoot: "dist",
      rawTypeScriptExecutionRequired: false,
    });
    expect(builder).toContain('"compiled-esm"');
    expect(builder).toContain('"--declaration", "true"');
    expect(builder).toContain('{ name: "node", minimumVersion: "22.0.0" }');
  });

  test("uses one executable example for docs and both runtime restart trials", () => {
    expect(packageReadme).toContain(`\`\`\`js\n${example}\n\`\`\``);
    expect(acceptanceTest).toContain('"node", nodeExample');
    expect(acceptanceTest).toContain('process.execPath, "run", nodeExample');
    expect(acceptanceTest).toContain("expect(JSON.parse(secondNode.stdout)).toEqual(firstNodeResult)");
    expect(acceptanceTest).toContain("expect(JSON.parse(secondBun.stdout)).toEqual(firstBunResult)");
  });
});
