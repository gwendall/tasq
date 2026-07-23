import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const packageJson = (name: string) => JSON.parse(
  read(`packages/${name}/package.json`),
) as { name: string; dependencies?: Record<string, string> };

describe("UK-004 extension package boundary", () => {
  test("keeps provider schemas and evaluator rules out of kernel packages", () => {
    const schemaTypes = read("packages/tasq-schema/src/types.ts");
    const schemaExtensions = read("packages/tasq-schema/src/extensions.ts");
    const matchers = read("packages/tasq-service/src/service/matchers.ts");
    for (const providerDefinition of [
      "GmailThreadReplyParameters",
      "GithubPullRequestStateParameters",
      "MercuryTransactionStateParameters",
      "HttpResponseParameters",
      "FilesystemArtifactParameters",
    ]) {
      expect(schemaTypes).not.toContain(providerDefinition);
    }
    expect(schemaExtensions).not.toContain("REFERENCE_EXTENSION_MANIFEST");
    expect(schemaExtensions).not.toContain("schemas.tasq.dev/conditions");
    expect(matchers).not.toContain("connector_account_mismatch");
    expect(matchers).not.toContain('"gmail.thread_reply": {');
  });

  test("enforces schema → SDK → reference extension → service dependency direction", () => {
    const schema = packageJson("tasq-schema").dependencies ?? {};
    const sdk = packageJson("tasq-extension-sdk").dependencies ?? {};
    const reference = packageJson("tasq-reference-extension").dependencies ?? {};
    const service = packageJson("tasq-service").dependencies ?? {};
    expect(schema["@tasq-run/extension-sdk"]).toBeUndefined();
    expect(schema["@tasq-internal/reference-extension"]).toBeUndefined();
    expect(sdk["@tasq-run/schema"]).toBe("workspace:*");
    expect(reference["@tasq-run/extension-sdk"]).toBe("workspace:*");
    expect(reference["@tasq-run/schema"]).toBe("workspace:*");
    expect(service["@tasq-run/extension-sdk"]).toBe("workspace:*");
    expect(service["@tasq-internal/reference-extension"]).toBe("workspace:*");
  });

  test("keeps each compatibility domain in its own extension module", () => {
    for (const domain of ["gmail", "github", "mercury", "http", "filesystem"]) {
      expect(() => read(`packages/tasq-reference-extension/src/domains/${domain}.ts`)).not.toThrow();
    }
  });
});

describe("UK-005 planning profile boundary", () => {
  test("keeps the bundled prioritizer DB-free and outside kernel packages", () => {
    const profile = packageJson("tasq-life-planning-profile").dependencies ?? {};
    const profileSource = read("packages/tasq-life-planning-profile/src/prioritizer.ts");
    const projectionSource = read("packages/tasq-life-planning-profile/src/projection.ts");
    const recurrenceSource = read("packages/tasq-life-planning-profile/src/recurrence.ts");
    const hierarchySource = read("packages/tasq-life-planning-profile/src/hierarchy.ts");
    const serviceAdapter = read("packages/tasq-service/src/prioritizer.ts");
    const serviceProjection = read("packages/tasq-service/src/projection/markdown.ts");
    const serviceRecurrence = read("packages/tasq-service/src/service/recurrence.ts");
    const serviceTasks = read("packages/tasq-service/src/service/tasks.ts");
    const lifeTaskPolicy = read("packages/tasq-service/src/service/life-task-policy.ts");
    const service = packageJson("tasq-service").dependencies ?? {};

    expect(profile).toEqual({});
    expect(profileSource).not.toContain("drizzle-orm");
    expect(profileSource).not.toContain("@tasq-run/schema");
    expect(profileSource).not.toContain("TasqDb");
    expect(projectionSource).not.toContain("drizzle-orm");
    expect(projectionSource).not.toContain("@kami/");
    expect(projectionSource).not.toContain("TasqDb");
    expect(projectionSource).not.toContain("Date.now()");
    expect(recurrenceSource).not.toContain("drizzle-orm");
    expect(recurrenceSource).not.toContain("@tasq-run/schema");
    expect(recurrenceSource).not.toContain("TasqDb");
    expect(hierarchySource).not.toContain("drizzle-orm");
    expect(hierarchySource).not.toContain("@tasq-run/schema");
    expect(hierarchySource).not.toContain("TasqDb");
    expect(serviceAdapter).toContain('from "@tasq-internal/life-planning-profile"');
    expect(serviceAdapter).not.toContain("const AVOIDANCE_WEIGHT");
    expect(serviceProjection).toContain("renderLifePlanningMarkdown");
    expect(serviceProjection).not.toContain("STATUS_ICON");
    expect(serviceProjection).not.toContain("Top priorities (next-action)");
    expect(serviceRecurrence).toContain('from "@tasq-internal/life-planning-profile"');
    expect(serviceRecurrence).not.toContain("setUTCMonth");
    expect(serviceRecurrence).not.toContain("missedAtLeastOneCadence");
    expect(lifeTaskPolicy).toContain("resolveCanonicalLifePlanningScope");
    expect(serviceTasks).not.toContain("resolveCanonicalLifePlanningScope");
    expect(serviceTasks).not.toContain("tasq-life-planning-profile");
    expect(service["@tasq-internal/life-planning-profile"]).toBe("workspace:*");
  });

  test("publishes a profile-neutral kernel entrypoint", () => {
    const service = JSON.parse(read("packages/tasq-service/package.json")) as {
      exports?: Record<string, string>;
    };
    const kernel = read("packages/tasq-service/src/kernel.ts");
    const commitments = read("packages/tasq-service/src/commitments.ts");
    expect(service.exports?.["./kernel"]).toBe("./src/kernel.ts");
    for (const profileSurface of [
      "createArea",
      "createGoal",
      "createProject",
      "pickNext",
      "renderProjection",
      "nextOccurrence",
    ]) expect(kernel).not.toContain(profileSurface);
    expect(kernel).not.toContain("tasq-life-planning-profile");
    expect(kernel).not.toContain("tasq-reference-extension");
    expect(commitments).not.toContain("areaId");
    expect(commitments).not.toContain("goalId");
    expect(commitments).not.toContain("projectId");
    expect(commitments).not.toContain("recurrence");
    expect(commitments).not.toContain("nextAction");
  });
});

describe("UK-010 protocol adapter boundary", () => {
  test("keeps MCP and A2A mapping dependencies outside the kernel", () => {
    const adapters = packageJson("tasq-protocol-adapters").dependencies ?? {};
    const schema = packageJson("tasq-schema").dependencies ?? {};
    const servicePackage = packageJson("tasq-service");
    const service = servicePackage.dependencies ?? {};
    const kernelCoordinate = adapters["@tasq-run/core"] ? "@tasq-run/core" : servicePackage.name;
    expect(adapters["@tasq-run/schema"]).toBe("workspace:*");
    expect(adapters).toEqual({
      "@tasq-run/schema": "workspace:*",
      [kernelCoordinate]: "workspace:*",
      zod: "^3.23.8",
    });
    expect(schema["@tasq-run/protocol-adapters"]).toBeUndefined();
    expect(service["@tasq-run/protocol-adapters"]).toBeUndefined();
    for (const path of [
      ...walkTypeScript("packages/tasq-schema/src"),
      ...walkTypeScript("packages/tasq-service/src"),
    ]) {
      expect(read(path), path).not.toContain("@tasq-run/protocol-adapters");
      expect(read(path), path).not.toContain("TASK_STATE_SUBMITTED");
      expect(read(path), path).not.toContain("TASK_STATE_AUTH_REQUIRED");
    }
  });
});

describe("TQ-304 durable-runtime recipe boundary", () => {
  test("documents Temporal, Restate and LangGraph without embedding their engines", () => {
    const forbidden = /(?:temporalio|restate|langgraph|langchain)/i;
    const packageNames = readdirSync(resolve(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("tasq-"))
      .map((entry) => entry.name);
    for (const name of packageNames) {
      const manifest = JSON.parse(read(`packages/${name}/package.json`)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const dependencyNames = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      });
      expect(dependencyNames.filter((dependency) => forbidden.test(dependency)), name).toEqual([]);
    }
    for (const path of [
      ...walkTypeScript("packages/tasq-schema/src"),
      ...walkTypeScript("packages/tasq-service/src"),
    ]) {
      expect(read(path), path).not.toMatch(forbidden);
    }
  });
});

describe("TQ-306 reference connector boundary", () => {
  test("keeps provider I/O outside schema and service while depending only outward", () => {
    const connectors = packageJson("tasq-reference-connectors").dependencies ?? {};
    const schema = packageJson("tasq-schema").dependencies ?? {};
    const service = packageJson("tasq-service").dependencies ?? {};
    expect(connectors["@tasq-run/schema"]).toBe("workspace:*");
    expect(connectors["@tasq-run/extension-sdk"]).toBe("workspace:*");
    expect(connectors["@tasq-internal/local-service"]).toBeUndefined();
    expect(schema["@tasq-internal/reference-connectors"]).toBeUndefined();
    expect(service["@tasq-internal/reference-connectors"]).toBeUndefined();
    for (const path of [
      ...walkTypeScript("packages/tasq-schema/src"),
      ...walkTypeScript("packages/tasq-service/src"),
    ]) {
      expect(read(path), path).not.toContain("@tasq-internal/reference-connectors");
      expect(read(path), path).not.toContain("reference-work-item-comment");
    }
  });
});

describe("TQ-504 read-first inspector boundary", () => {
  test("keeps the browser projection outside the kernel and dependent only inward", () => {
    const inspector = packageJson("tasq-inspector").dependencies ?? {};
    const schema = packageJson("tasq-schema").dependencies ?? {};
    const servicePackage = packageJson("tasq-service");
    const service = servicePackage.dependencies ?? {};
    const kernelCoordinate = inspector["@tasq-run/core"] ? "@tasq-run/core" : servicePackage.name;
    expect(inspector).toEqual({
      "@tasq-run/schema": "workspace:*",
      [kernelCoordinate]: "workspace:*",
    });
    expect(schema["@tasq-run/console"]).toBeUndefined();
    expect(service["@tasq-run/console"]).toBeUndefined();
    for (const path of [
      ...walkTypeScript("packages/tasq-schema/src"),
      ...walkTypeScript("packages/tasq-service/src"),
    ]) {
      expect(read(path), path).not.toContain("@tasq-run/console");
    }
  });
});

describe("kernel clock boundary", () => {
  test("permits raw device time only inside the system clock adapter", () => {
    const productionRoots = [
      "packages/tasq-schema/src",
      "packages/tasq-extension-sdk/src",
      "packages/tasq-reference-extension/src",
      "packages/tasq-life-planning-profile/src",
      "packages/tasq-filesystem-watcher/src",
      "packages/tasq-reference-connectors/src",
      "packages/tasq-protocol-adapters/src",
      "packages/tasq-mcp/src",
      "packages/tasq-inspector/src",
      "packages/tasq-service/src",
      "packages/tasq-cli/src",
      "packages/tasq-evals/src",
      "scripts",
    ];
    const allowed = "packages/tasq-schema/src/clock.ts";
    const forbidden: string[] = [];
    for (const base of productionRoots) {
      for (const path of walkTypeScript(base)) {
        if (path === allowed) continue;
        const source = read(path);
        if (
          /\bDate\.now\s*\(/.test(source) ||
          /\bnew\s+Date\s*\(\s*\)/.test(source) ||
          /\bperformance\.now\s*\(/.test(source) ||
          /\bprocess\.hrtime\b/.test(source) ||
          /\bCURRENT_TIMESTAMP\b/i.test(source) ||
          /\b(?:datetime|strftime)\s*\([^\n)]*["']now["']/i.test(source)
        ) forbidden.push(path);
      }
    }
    expect(forbidden).toEqual([]);
  });
});

function walkTypeScript(relativeDir: string): string[] {
  const absolute = resolve(root, relativeDir);
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) return walkTypeScript(relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relativePath] : [];
  });
}
