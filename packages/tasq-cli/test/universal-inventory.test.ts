import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Area,
  ATTEMPT_STATUSES,
  ASSIGNMENT_STATUSES,
  CANONICAL_EVENT_TYPES,
  CoordinationSpace,
  Event,
  Goal,
  Observation,
  Project,
  RESOURCE_EVENT_TYPES,
  ResourceEvent,
  ResourceLease,
  Reconciliation,
  schema,
  Task,
  TaskAttempt,
  TaskClaim,
  TaskDependency,
  TaskEvidence,
  WaitCondition,
} from "@tasq/schema";
import { CONFIG_KEYS } from "../src/config.js";

const productRoot = resolve(import.meta.dir, "../../..");
const inventory = JSON.parse(
  readFileSync(resolve(productRoot, "docs/contracts/UNIVERSAL_COMPATIBILITY_INVENTORY.json"), "utf8"),
) as Inventory;

type Classification =
  | "kernel"
  | "kernel_rename"
  | "kernel_generalize"
  | "extension"
  | "profile"
  | "surface"
  | "internal"
  | "compatibility";

interface Inventory {
  inventoryVersion: number;
  status: string;
  classifications: Record<Classification, string>;
  tables: Record<string, {
    exportName: string;
    recordOwner: Classification;
    fieldGroups: Partial<Record<Classification, string[]>>;
  }>;
  commands: Record<Classification, string[]>;
  events: { emitted: string[]; documentedReserved: string[]; resourceEmitted: string[] };
  jsonRecords: Record<string, { schema: string; owner: Classification; fields: string[] }>;
  jsonEnvelopes: Record<string, { owner: Classification; fields?: string[]; [key: string]: unknown }>;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function unique(values: readonly string[], label: string): void {
  expect(new Set(values).size, `${label} contains duplicate entries`).toBe(values.length);
}

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[Symbol.for("drizzle:Name")];
}

function tableFields(table: unknown): string[] {
  const columns = (table as Record<symbol, Record<string, unknown>>)[
    Symbol.for("drizzle:Columns")
  ];
  return Object.keys(columns ?? {});
}

function zodFields(value: unknown): string[] {
  let current = value as { shape?: Record<string, unknown>; _def?: { schema?: unknown } };
  while (!current.shape && current._def?.schema) {
    current = current._def.schema as typeof current;
  }
  if (!current.shape) throw new Error("Inventory schema is not a Zod object/effect");
  return Object.keys(current.shape);
}

const publicSchemas: Record<string, unknown> = {
  CoordinationSpace,
  ResourceLease,
  ResourceEvent,
  Area,
  Goal,
  Project,
  Task,
  TaskDependency,
  TaskClaim,
  TaskAttempt,
  TaskEvidence,
  WaitCondition,
  Observation,
  Reconciliation,
  Event,
};

describe("UK-002 universal compatibility inventory", () => {
  test("the inventory is accepted, versioned, and defines every classification", () => {
    expect(inventory.inventoryVersion).toBe(1);
    expect(inventory.status).toBe("accepted-uk-002");
    expect(sorted(Object.keys(inventory.classifications))).toEqual(sorted([
      "kernel", "kernel_rename", "kernel_generalize", "extension",
      "profile", "surface", "internal", "compatibility",
    ]));
  });

  test("every physical table and field is classified exactly once", () => {
    const actualTables = Object.values(schema).map((table) => tableName(table));
    expect(sorted(Object.keys(inventory.tables))).toEqual(sorted(actualTables));

    for (const table of Object.values(schema)) {
      const name = tableName(table);
      const entry = inventory.tables[name];
      expect(entry, `missing table inventory for ${name}`).toBeDefined();
      expect((schema as Record<string, unknown>)[entry!.exportName]).toBe(table);
      expect(inventory.classifications[entry!.recordOwner]).toBeDefined();

      const classified = Object.entries(entry!.fieldGroups).flatMap(([classification, fields]) => {
        expect(inventory.classifications[classification as Classification],
          `${name} uses unknown classification ${classification}`).toBeDefined();
        return fields ?? [];
      });
      unique(classified, `${name} fields`);
      expect(sorted(classified), `${name} field coverage drift`).toEqual(sorted(tableFields(table)));
    }
  });

  test("every top-level command, including aliases, is classified exactly once", () => {
    const source = readFileSync(resolve(productRoot, "packages/tasq-cli/src/index.ts"), "utf8");
    const routed = [...source.matchAll(/case "([a-z][a-z-]*)":/g)].map((match) => match[1]!);
    const actual = [...routed, "help", "version"];
    const classified = Object.values(inventory.commands).flat();
    unique(classified, "commands");
    expect(sorted(classified)).toEqual(sorted(actual));
  });

  test("every currently emitted or reserved event type is frozen", () => {
    const serviceDirs = [
      resolve(productRoot, "packages/tasq-core/src/service"),
      resolve(productRoot, "packages/tasq-service/src/service"),
    ];
    const serviceSource = serviceDirs
      .flatMap((serviceDir) => readdirSync(serviceDir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFileSync(resolve(serviceDir, name), "utf8")))
      .join("\n");
    const literals = [...serviceSource.matchAll(/eventType:\s*"([a-z_]+)"/g)]
      .map((match) => match[1]!);
    const namedConstants = [
      ...serviceSource.matchAll(/(?:export\s+)?const\s+[A-Z0-9_]*EVENT_TYPE\s*=\s*"([a-z_]+)"/g),
    ].map((match) => match[1]!);
    const taskLifecycle = [
      "started", "completed", "blocked", "cancelled", "unblocked",
      "uncancelled", "status_changed",
    ];
    const dynamicAttempts = ATTEMPT_STATUSES.map((status) => `attempt_${status}`);
    const dynamicAssignments = ASSIGNMENT_STATUSES
      .filter((status) => status !== "proposed")
      .map((status) => `assignment_${status}`);
    const emitted = sorted(new Set([
      ...literals, ...namedConstants, ...taskLifecycle, ...dynamicAttempts, ...dynamicAssignments,
    ]));

    unique(inventory.events.emitted, "emitted events");
    unique(inventory.events.documentedReserved, "reserved events");
    expect(sorted(inventory.events.emitted)).toEqual(emitted);
    expect(sorted(CANONICAL_EVENT_TYPES)).toEqual(sorted([
      ...inventory.events.emitted,
      ...inventory.events.documentedReserved,
    ]));
    unique(inventory.events.resourceEmitted, "resource events");
    expect(sorted(inventory.events.resourceEmitted)).toEqual(sorted(RESOURCE_EVENT_TYPES));
  });

  test("every table-backed public JSON record freezes its exact Zod keys", () => {
    expect(sorted(Object.keys(inventory.jsonRecords))).toEqual(sorted([
      "CoordinationSpaceV1",
      "ResourceLeaseV1", "ResourceEventV1",
      "AreaV1", "GoalV1", "ProjectV1", "TaskV1", "TaskDependencyV1",
      "TaskClaimV1", "TaskAttemptV1", "TaskEvidenceV1", "WaitConditionV1",
      "ObservationV1", "ReconciliationV1", "EventV1",
    ]));
    for (const [contractName, entry] of Object.entries(inventory.jsonRecords)) {
      const zod = publicSchemas[entry.schema];
      expect(zod, `${contractName} references unknown schema ${entry.schema}`).toBeDefined();
      unique(entry.fields, `${contractName} fields`);
      const hiddenV1Fields: Record<string, string[]> = {
        Task: ["revision"], Event: ["principalId"], TaskClaim: ["principalId", "revision"],
        TaskAttempt: ["principalId", "revision"], TaskEvidence: ["principalId"],
      };
      const actual = zodFields(zod).filter((field) => !hiddenV1Fields[entry.schema]?.includes(field));
      expect(sorted(entry.fields), `${contractName} JSON key drift`).toEqual(sorted(actual));
    }
  });

  test("derived and maintenance JSON envelopes have classified, unique key sets", () => {
    expect(inventory.jsonEnvelopes.ConfigV1?.fields).toEqual(CONFIG_KEYS);
    for (const [name, entry] of Object.entries(inventory.jsonEnvelopes)) {
      expect(inventory.classifications[entry.owner], `${name} has unknown owner`).toBeDefined();
      for (const [key, value] of Object.entries(entry)) {
        if (key === "owner" || !key.endsWith("Fields") && key !== "fields") continue;
        if (Array.isArray(value)) unique(value as string[], `${name}.${key}`);
      }
    }
  });
});
