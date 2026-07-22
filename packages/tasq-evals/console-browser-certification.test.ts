/** TQ-705 — machine guard for the cross-platform browser certificate. */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const load = (path: string) => readFile(resolve(root, path), "utf8");

describe("TQ-705 Local Console browser certification", () => {
  test("binds all five states to bounded, fixed-clock browser evidence", async () => {
    const certificate = JSON.parse(await load("docs/contracts/TQ-705_CONSOLE_BROWSER_CERTIFICATION.json"));
    expect(certificate).toMatchObject({
      contractVersion: "tasq.console-browser-certification.v1",
      status: "certified",
      scenarios: ["empty", "mature", "hostile", "corrupt", "large"],
      authority: { fixedUnixMs: 1_735_689_600_000, deviceClockReadInFixture: false },
      largeLedger: {
        commitments: 2_501,
        matchingAuditEvents: 2_501,
        maximumPageRecords: 100,
        maximumInitialHtmlBytes: 256 * 1_024,
        latencySla: false,
      },
      corruptState: { expectedHttpStatus: 500, maximumErrorHtmlBytes: 32 * 1_024 },
      tq705Complete: true,
    });
    expect(certificate.platformJobs).toEqual([
      { os: "linux", runner: "ubuntu-latest", job: "console-browser" },
      { os: "macos", runner: "macos-14", job: "console-browser-macos" },
    ]);
  });

  test("keeps the fixture clock-pure and both public CI platform jobs executable", async () => {
    const [fixture, browser, workflow, backlog] = await Promise.all([
      load("packages/tasq-inspector/browser/console-fixture.ts"),
      load("packages/tasq-inspector/browser/inspector.pw.ts"),
      load(".github/workflows/ci.yml"),
      load("docs/roadmap/BACKLOG.json").then(JSON.parse),
    ]);
    for (const forbidden of ["Date.now(", "new Date(", "systemClock", "performance.now("]) {
      expect(fixture).not.toContain(forbidden);
    }
    expect(fixture).toContain("startTasqInspectorServer");
    expect(fixture).toContain("const LARGE_COMMITMENTS = 2_501");
    for (const scenario of ["empty", "mature", "hostile", "corrupt", "large"]) {
      expect(browser).toContain(`url(\"${scenario}\")`);
    }
    expect(workflow).toMatch(/console-browser:\n\s+runs-on: ubuntu-latest/);
    expect(workflow).toMatch(/console-browser-macos:\n\s+runs-on: macos-14/);
    expect(backlog.items.find((item: { id: string }) => item.id === "TQ-705")).toMatchObject({
      status: "done",
      evidence: ["docs/contracts/TQ-705_CONSOLE_BROWSER_CERTIFICATION.md", "docs/contracts/TQ-705_CONSOLE_BROWSER_CERTIFICATION.json"],
    });
  });
});
