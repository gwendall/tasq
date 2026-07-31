#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const defaultManifestPath = resolve(
  repositoryRoot,
  "docs/contracts/MANAGED_CLOUD_PRODUCTION_READINESS.template.json",
);

export const REQUIRED_CLOUD_GATES = [
  "tq901.production_database",
  "tq901.secret_manager_and_server_digest",
  "tq901.independent_multitenant_review",
  "tq902.deployed_browser_matrix",
  "tq902.identity_callback_and_logout",
  "tq902.independent_web_security_review",
  "tq903.real_oidc_integration",
  "tq903.workload_secret_issuance",
  "tq903.recovery_and_revocation_drill",
  "tq904.provider_backup_restore",
  "tq904.provider_key_rotation",
  "tq904.export_and_verified_deletion",
  "tq904.oncall_incident_and_support_drill",
  "tq905.exact_artifact_deployment",
  "tq905.offsite_restore_and_region_failover",
  "tq905.independent_multitenant_security_review",
  "tq905.unbriefed_operator_incident_drill",
] as const;

const independentGateIds = new Set([
  "tq901.independent_multitenant_review",
  "tq902.independent_web_security_review",
  "tq905.independent_multitenant_security_review",
  "tq905.unbriefed_operator_incident_drill",
]);
const gateStatuses = new Set(["pending", "passed", "failed"]);
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const providerRefPattern = /^urn:tasq-provider:[a-z0-9][a-z0-9._:/-]{2,499}$/;
const imageCoordinatePattern =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@(sha256:[0-9a-f]{64})$/;
const utcInstantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

type JsonObject = Record<string, unknown>;

export interface CloudReadinessValidation {
  contractVersion: "tasq.managed-cloud-production-readiness-validation.v1";
  valid: boolean;
  readyForMaintainerDecision: boolean;
  state: string | null;
  passedGateCount: number;
  totalGateCount: number;
  missing: string[];
  errors: string[];
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
  errors: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    errors.push(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function utcInstant(value: unknown): value is string {
  if (typeof value !== "string" || !utcInstantPattern.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value === canonical ||
    (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"));
}

function evidenceRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 550) return false;
  if (/^urn:sha256:[0-9a-f]{64}$/.test(value)) return true;
  if (/^evidence\/cloud\/[a-zA-Z0-9][a-zA-Z0-9._/-]{2,499}$/.test(value)) {
    return !value.includes("..");
  }
  if (!value.startsWith("https://") || value.includes("?") || value.includes("#")) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname !== "/";
  } catch {
    return false;
  }
}

function evidenceRefs(
  value: unknown,
  label: string,
  errors: string[],
): value is string[] {
  if (!Array.isArray(value) || value.length > 64) {
    errors.push(`${label} must be an array with at most 64 references`);
    return false;
  }
  if (value.some((entry) => !evidenceRef(entry))) {
    errors.push(`${label} contains an unsafe or invalid evidence reference`);
    return false;
  }
  if (new Set(value).size !== value.length) {
    errors.push(`${label} must not contain duplicate references`);
    return false;
  }
  return true;
}

function providerRef(value: unknown): value is string {
  return typeof value === "string" && providerRefPattern.test(value);
}

function rejectSecretMaterial(candidate: unknown, errors: string[]): void {
  const serialized = JSON.stringify(candidate);
  const forbidden: Array<[RegExp, string]> = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key material"],
    [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/i, "bearer credential"],
    [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/i, "provider credential"],
    [/\bAKIA[0-9A-Z]{16}\b/, "access-key identifier"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, "JWT"],
    [/\btasq_access_[A-Za-z0-9_-]{8,}\b/, "Tasq access credential"],
    [/\btasq_enroll_[A-Za-z0-9_-]{8,}\b/, "Tasq enrollment credential"],
    [/\b__Host-tasq_session=[A-Za-z0-9._~+/-]{8,}=*/i, "Tasq session cookie"],
    [/(?:^|[/"'])\/Users\//, "workstation path"],
    [/(?:^|[/"'])\/home\/[a-z0-9_-]+\//i, "workstation path"],
    [/\b[A-Za-z]:\\{1,2}Users\\{1,2}[^\\/"']+\\{1,2}/i, "workstation path"],
    [/file:\/\//i, "file URI"],
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(serialized)) errors.push(`manifest contains forbidden ${label}`);
  }
}

export function validateManagedCloudReadiness(
  candidate: unknown,
): CloudReadinessValidation {
  const errors: string[] = [];
  const missing: string[] = [];
  let state: string | null = null;
  let passedGateCount = 0;

  if (!object(candidate)) {
    return {
      contractVersion: "tasq.managed-cloud-production-readiness-validation.v1",
      valid: false,
      readyForMaintainerDecision: false,
      state,
      passedGateCount,
      totalGateCount: REQUIRED_CLOUD_GATES.length,
      missing,
      errors: ["manifest must be a JSON object"],
    };
  }

  rejectSecretMaterial(candidate, errors);
  exactKeys(candidate, [
    "contractVersion",
    "state",
    "candidate",
    "deployment",
    "reliability",
    "gates",
    "nonClaims",
  ], "manifest", errors);

  if (candidate.contractVersion !== "tasq.managed-cloud-production-readiness.v1") {
    errors.push(
      "contractVersion must be tasq.managed-cloud-production-readiness.v1",
    );
  }
  if (
    candidate.state !== "external_gates_open" &&
    candidate.state !== "ready_for_maintainer_decision"
  ) {
    errors.push("state must be external_gates_open or ready_for_maintainer_decision");
  } else {
    state = candidate.state;
  }

  if (!object(candidate.candidate)) {
    errors.push("candidate must be an object");
  } else {
    const artifact = candidate.candidate;
    exactKeys(artifact, [
      "sourceCommit",
      "controlPlaneDigest",
      "serverImage",
      "provenanceRefs",
    ], "candidate", errors);
    if (!commitPattern.test(String(artifact.sourceCommit ?? ""))) {
      missing.push("candidate.sourceCommit");
      if (artifact.sourceCommit !== null) {
        errors.push("candidate.sourceCommit must be a 40-character lowercase commit");
      }
    }
    if (!digestPattern.test(String(artifact.controlPlaneDigest ?? ""))) {
      missing.push("candidate.controlPlaneDigest");
      if (artifact.controlPlaneDigest !== null) {
        errors.push("candidate.controlPlaneDigest must be a sha256 digest");
      }
    }
    if (!evidenceRefs(artifact.provenanceRefs, "candidate.provenanceRefs", errors)) {
      // Structural error already recorded.
    } else if (artifact.provenanceRefs.length === 0) {
      missing.push("candidate.provenanceRefs");
    }
    if (!object(artifact.serverImage)) {
      errors.push("candidate.serverImage must be an object");
    } else {
      exactKeys(artifact.serverImage, ["coordinate", "digest"], "candidate.serverImage", errors);
      const coordinate = artifact.serverImage.coordinate;
      const digest = artifact.serverImage.digest;
      const coordinateMatch = typeof coordinate === "string"
        ? coordinate.match(imageCoordinatePattern)
        : null;
      if (!coordinateMatch) {
        missing.push("candidate.serverImage.coordinate");
        if (coordinate !== null) {
          errors.push(
            "candidate.serverImage.coordinate must be an exact registry/name@sha256 coordinate",
          );
        }
      }
      if (!digestPattern.test(String(digest ?? ""))) {
        missing.push("candidate.serverImage.digest");
        if (digest !== null) {
          errors.push("candidate.serverImage.digest must be a sha256 digest");
        }
      }
      if (coordinateMatch && digestPattern.test(String(digest)) && coordinateMatch[1] !== digest) {
        errors.push("candidate.serverImage coordinate and digest must identify the same bytes");
      }
    }
  }

  if (!object(candidate.deployment)) {
    errors.push("deployment must be an object");
  } else {
    const deployment = candidate.deployment;
    const refFields = [
      "deploymentRef",
      "providerProfileRef",
      "deploymentIdentityRef",
      "databaseRef",
      "secretManagerRef",
    ] as const;
    exactKeys(deployment, [
      ...refFields,
      "publicOrigin",
      "tlsPolicyRef",
      "cspPolicyRef",
      "regions",
    ], "deployment", errors);
    for (const field of refFields) {
      if (!providerRef(deployment[field])) {
        missing.push(`deployment.${field}`);
        if (deployment[field] !== null) {
          errors.push(`deployment.${field} must be an opaque urn:tasq-provider:* reference`);
        }
      }
    }
    if (typeof deployment.publicOrigin !== "string") {
      missing.push("deployment.publicOrigin");
      if (deployment.publicOrigin !== null) {
        errors.push("deployment.publicOrigin must be a canonical HTTPS origin");
      }
    } else {
      try {
        const origin = new URL(deployment.publicOrigin);
        if (
          origin.protocol !== "https:" ||
          origin.username ||
          origin.password ||
          origin.pathname !== "/" ||
          origin.search ||
          origin.hash ||
          origin.origin !== deployment.publicOrigin
        ) {
          errors.push("deployment.publicOrigin must be an exact canonical HTTPS origin");
        }
      } catch {
        errors.push("deployment.publicOrigin must be an exact canonical HTTPS origin");
      }
    }
    for (const field of ["tlsPolicyRef", "cspPolicyRef"] as const) {
      if (!evidenceRef(deployment[field])) {
        missing.push(`deployment.${field}`);
        if (deployment[field] !== null) {
          errors.push(`deployment.${field} must be a safe evidence reference`);
        }
      }
    }
    if (!Array.isArray(deployment.regions)) {
      errors.push("deployment.regions must be an array");
    } else {
      if (
        deployment.regions.length > 16 ||
        deployment.regions.some((entry) => !providerRef(entry)) ||
        new Set(deployment.regions).size !== deployment.regions.length
      ) {
        errors.push("deployment.regions must contain unique opaque provider references");
      }
      if (deployment.regions.length < 2) missing.push("deployment.regions[2]");
    }
  }

  if (!object(candidate.reliability)) {
    errors.push("reliability must be an object");
  } else {
    const reliability = candidate.reliability;
    exactKeys(reliability, [
      "availabilityTargetPercent",
      "measurementWindowDays",
      "recoveryPointObjectiveMinutes",
      "recoveryTimeObjectiveMinutes",
      "sloEvidenceRefs",
      "disasterRecoveryEvidenceRefs",
    ], "reliability", errors);
    const availability = reliability.availabilityTargetPercent;
    if (typeof availability !== "number") {
      missing.push("reliability.availabilityTargetPercent");
      if (availability !== null) {
        errors.push("reliability.availabilityTargetPercent must be a number");
      }
    } else if (!Number.isFinite(availability) || availability < 99 || availability > 100) {
      errors.push(
        "reliability.availabilityTargetPercent must be a non-trivial target between 99 and 100",
      );
    }
    const measurementWindow = reliability.measurementWindowDays;
    if (!Number.isInteger(measurementWindow)) {
      missing.push("reliability.measurementWindowDays");
      if (measurementWindow !== null) {
        errors.push("reliability.measurementWindowDays must be an integer");
      }
    } else if ((measurementWindow as number) < 28 || (measurementWindow as number) > 366) {
      errors.push("reliability.measurementWindowDays must be between 28 and 366");
    }
    for (
      const field of [
        "recoveryPointObjectiveMinutes",
        "recoveryTimeObjectiveMinutes",
      ] as const
    ) {
      const value = reliability[field];
      if (!Number.isInteger(value)) {
        missing.push(`reliability.${field}`);
        if (value !== null) errors.push(`reliability.${field} must be an integer`);
      } else if ((value as number) < 0 || (value as number) > 10080) {
        errors.push(`reliability.${field} must be between 0 and 10080`);
      }
    }
    for (const field of ["sloEvidenceRefs", "disasterRecoveryEvidenceRefs"] as const) {
      if (!evidenceRefs(reliability[field], `reliability.${field}`, errors)) {
        continue;
      }
      if (reliability[field].length === 0) missing.push(`reliability.${field}`);
    }
  }

  const gateById = new Map<string, JsonObject>();
  if (!Array.isArray(candidate.gates)) {
    errors.push("gates must be an array");
  } else {
    candidate.gates.forEach((gate, index) => {
      const label = `gates[${index}]`;
      if (!object(gate)) {
        errors.push(`${label} must be an object`);
        return;
      }
      exactKeys(gate, [
        "id",
        "status",
        "observedAt",
        "evidenceRefs",
        "reviewerRef",
        "notes",
      ], label, errors);
      if (
        typeof gate.id !== "string" ||
        !(REQUIRED_CLOUD_GATES as readonly string[]).includes(gate.id)
      ) {
        errors.push(`${label}.id is not a required Cloud gate`);
        return;
      }
      if (gateById.has(gate.id)) {
        errors.push(`${label}.id is duplicated`);
      } else {
        gateById.set(gate.id, gate);
      }
      if (!gateStatuses.has(String(gate.status))) {
        errors.push(`${label}.status must be pending, passed or failed`);
      }
      const refsValid = evidenceRefs(gate.evidenceRefs, `${label}.evidenceRefs`, errors);
      if (typeof gate.notes !== "string" || gate.notes.trim().length === 0 || gate.notes.length > 1000) {
        errors.push(`${label}.notes must contain 1-1000 characters`);
      }
      if (gate.status === "passed" || gate.status === "failed") {
        if (!utcInstant(gate.observedAt)) {
          errors.push(`${label}.observedAt must be an explicit UTC instant`);
        }
        if (refsValid && Array.isArray(gate.evidenceRefs) && gate.evidenceRefs.length === 0) {
          errors.push(`${label}.evidenceRefs must prove a concluded gate`);
        }
        if (independentGateIds.has(gate.id) && !evidenceRef(gate.reviewerRef)) {
          errors.push(`${label}.reviewerRef must identify independent review evidence`);
        } else if (gate.reviewerRef !== null && !evidenceRef(gate.reviewerRef)) {
          errors.push(`${label}.reviewerRef is invalid`);
        }
      } else {
        if (gate.observedAt !== null) {
          errors.push(`${label}.observedAt must be null while pending`);
        }
        if (gate.reviewerRef !== null && !evidenceRef(gate.reviewerRef)) {
          errors.push(`${label}.reviewerRef is invalid`);
        }
      }
      if (gate.status === "passed") passedGateCount += 1;
    });
  }

  for (const id of REQUIRED_CLOUD_GATES) {
    const gate = gateById.get(id);
    if (!gate) {
      errors.push(`missing required gate: ${id}`);
    } else if (gate.status !== "passed") {
      missing.push(`gates.${id}`);
    }
  }
  if (gateById.size !== REQUIRED_CLOUD_GATES.length) {
    errors.push(`gates must contain exactly ${REQUIRED_CLOUD_GATES.length} unique required gates`);
  }

  if (!object(candidate.nonClaims)) {
    errors.push("nonClaims must be an object");
  } else {
    exactKeys(candidate.nonClaims, [
      "managedCloudAvailable",
      "remoteEffectsEnabled",
      "manifestGrantsAuthority",
    ], "nonClaims", errors);
    for (
      const field of [
        "managedCloudAvailable",
        "remoteEffectsEnabled",
        "manifestGrantsAuthority",
      ] as const
    ) {
      if (candidate.nonClaims[field] !== false) {
        errors.push(`nonClaims.${field} must remain false`);
      }
    }
  }

  const uniqueMissing = [...new Set(missing)].sort();
  const structurallyReady = errors.length === 0 && uniqueMissing.length === 0;
  if (structurallyReady && state !== "ready_for_maintainer_decision") {
    errors.push(
      "state must be ready_for_maintainer_decision only after every readiness requirement passes",
    );
  }
  if (!structurallyReady && state === "ready_for_maintainer_decision") {
    errors.push("state cannot claim ready_for_maintainer_decision while requirements are open");
  }

  return {
    contractVersion: "tasq.managed-cloud-production-readiness-validation.v1",
    valid: errors.length === 0,
    readyForMaintainerDecision:
      errors.length === 0 &&
      uniqueMissing.length === 0 &&
      state === "ready_for_maintainer_decision",
    state,
    passedGateCount,
    totalGateCount: REQUIRED_CLOUD_GATES.length,
    missing: uniqueMissing,
    errors,
  };
}

function parseArgs(argv: string[]): {
  manifestPath: string;
  requireReady: boolean;
} {
  let manifestPath = defaultManifestPath;
  let requireReady = false;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === "--require-ready") {
      requireReady = true;
      continue;
    }
    if (argument === "--manifest") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--manifest requires a path");
      }
      manifestPath = isAbsolute(value) ? value : resolve(repositoryRoot, value);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { manifestPath, requireReady };
}

if (import.meta.main) {
  try {
    const { manifestPath, requireReady } = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    const result = validateManagedCloudReadiness(manifest);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exit(1);
    if (requireReady && !result.readyForMaintainerDecision) process.exit(2);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        contractVersion: "tasq.managed-cloud-production-readiness-validation.v1",
        valid: false,
        readyForMaintainerDecision: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(1);
  }
}
