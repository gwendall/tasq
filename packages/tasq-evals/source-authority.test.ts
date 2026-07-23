import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const coreRoot = join(root, "packages/tasq-core/src");
const localRoot = join(root, "packages/tasq-service/src");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("single Core source authority", () => {
  test("Local forwards every overlapping neutral module and owns no copied migration", () => {
    const forwarded: string[] = [];
    const violations: string[] = [];

    for (const corePath of walk(coreRoot)) {
      const modulePath = relative(coreRoot, corePath);
      const localPath = join(localRoot, modulePath);
      if (!existsSync(localPath)) continue;
      if (modulePath.endsWith(".sql")) {
        violations.push(`${modulePath}: copied SQL migration`);
        continue;
      }
      if (!modulePath.endsWith(".ts")) continue;
      const specifier = modulePath === "kernel.ts"
        ? "@tasq-run/core"
        : `@tasq-run/core/internal/${modulePath.slice(0, -3)}`;
      const expected = `/** Forwarding compatibility module. Canonical implementation: packages/tasq-core/src/${modulePath}. */\nexport * from "${specifier}";\n`;
      if (readFileSync(localPath, "utf8") !== expected) {
        violations.push(`${modulePath}: overlapping implementation is not an exact Core forwarder`);
      } else {
        forwarded.push(modulePath);
      }
    }

    expect(violations).toEqual([]);
    expect(forwarded.length).toBeGreaterThanOrEqual(28);
  });

  test("workspace and release composition both name packages/tasq-core as authority", () => {
    const core = JSON.parse(read("packages/tasq-core/package.json")) as {
      exports: Record<string, string>;
    };
    const local = JSON.parse(read("packages/tasq-service/package.json")) as {
      dependencies: Record<string, string>;
    };
    const builder = read("scripts/release/build-public-packages.ts");

    expect(core.exports["."]).toBe("./src/kernel.ts");
    expect(core.exports["./internal/*"]).toBe("./src/*.ts");
    expect(local.dependencies["@tasq-run/core"]).toBe("workspace:*");
    expect(builder).toContain('name: "@tasq-run/core",\n      sourceDirectory: "tasq-core"');
    expect(builder).not.toContain('name: "@tasq-run/core",\n      sourceDirectory: "tasq-service"');
  });
});
