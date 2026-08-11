import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(60_000);
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
const homes: string[] = [];
afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

async function run(home: string, args: string[]) {
  const process = Bun.spawn(["bun", "run", cli, ...args], {
    env: { ...globalThis.process.env, HOME: home, TASQ_DB_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function ok(home: string, args: string[]) {
  const result = await run(home, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
}

describe("attempt cost CLI", () => {
  test("requires metering for renewal and releases authority at the bound", async () => {
    const home = mkdtempSync(join(tmpdir(), "tasq-cost-cli-"));
    homes.push(home);
    await ok(home, ["setup", "--space", "cost-cli", "--actor", "runtime-a"]);
    const task = JSON.parse((await ok(home, ["add", "Metered task", "--json"])).stdout);
    const configured = JSON.parse((await ok(home, [
      "cost", "budget", task.id,
      "--currency", "USD",
      "--max-micros", "1000000",
      "--reserve-micros", "100000",
      "--metering", "required",
      "--json",
    ])).stdout);
    expect(configured.summary.budget).toMatchObject({
      currency: "USD", maxGrossMicros: "1000000", metering: "required",
    });
    const claim = JSON.parse((await ok(home, ["claim", task.id, "--for", "30m", "--json"])).stdout);
    const attempt = JSON.parse((await ok(home, [
      "attempt", "start", task.id, "--claim", claim.id, "--runtime", "provider-adapter", "--json",
    ])).stdout);

    const unmetered = await run(home, ["claim", task.id, "--for", "30m", "--json"]);
    expect(unmetered.exitCode).toBe(2);
    expect(JSON.parse(unmetered.stdout)).toMatchObject({
      contractVersion: "tasq.cost-bound-problem.v1",
      code: "cost_metering_required",
      summary: { currentClaimId: claim.id },
    });

    await ok(home, [
      "cost", "record", attempt.id,
      "--meter", "https://meter.example.test/provider",
      "--observation", "receipt-zero",
      "--currency", "USD",
      "--gross-micros", "0",
      "--basis", "provider_receipt",
      "--idempotency-key", "receipt-zero",
      "--json",
    ]);
    expect(JSON.parse((await ok(home, ["claim", task.id, "--for", "30m", "--json"])).stdout).id)
      .toBe(claim.id);

    const exhausted = JSON.parse((await ok(home, [
      "cost", "record", attempt.id,
      "--meter", "https://meter.example.test/provider",
      "--observation", "receipt-spend",
      "--currency", "USD",
      "--gross-micros", "950001",
      "--basis", "provider_receipt",
      "--idempotency-key", "receipt-spend",
      "--json",
    ])).stdout);
    expect(exhausted).toMatchObject({
      claimReleased: true,
      summary: { renewal: { allowed: false, reason: "bound_reached" } },
    });
    const shown = JSON.parse((await ok(home, ["show", task.id, "--json"])).stdout);
    expect(shown.claim).toBeNull();
    const summary = JSON.parse((await ok(home, ["cost", "show", task.id, "--json"])).stdout);
    expect(summary).toMatchObject({
      observedGrossByCurrency: { USD: "950001" },
      observationCount: 2,
      renewal: { allowed: false, reason: "bound_reached", remainingMicros: "49999" },
    });
  });
});
