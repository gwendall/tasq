#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const defaultEvidencePath = resolve(
  repositoryRoot,
  "docs/contracts/TQ-606_HUMAN_SESSION_EVIDENCE.template.json",
);
const stepIds = [
  "public-entrypoint-opened",
  "release-installed",
  "human-onboarded",
  "agent-connected",
  "contention-observed",
  "contention-recovered",
  "evidence-bound-completion-observed",
  "same-ledger-console-inspected",
] as const;
const targets = new Set(["darwin-arm64", "linux-x64-gnu"]);
const outcomes = new Set([
  "completed_without_undocumented_help",
  "completed_with_undocumented_help",
  "not_completed",
]);
const stepStatuses = new Set(["completed", "failed", "not_reached"]);
const interventionActors = new Set(["participant", "facilitator", "environment"]);
const interventionKinds = new Set([
  "public_documentation",
  "facilitator_coaching",
  "environment_repair",
  "other",
]);
const failureSeverities = new Set(["friction", "blocking"]);
const failureDispositions = new Set([
  "recovered_self_service",
  "recovered_with_help",
  "unresolved",
]);

function parseArgs(argv: string[]): { evidencePath: string } {
  let evidencePath = defaultEvidencePath;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag !== "--evidence") throw new Error(`Unknown argument: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    seen.add(flag);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("--evidence requires a path");
    evidencePath = isAbsolute(value) ? value : resolve(repositoryRoot, value);
  }
  return { evidencePath };
}

function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utcInstant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return value === canonical ||
    (canonical.endsWith(".000Z") && value === canonical.replace(".000Z", "Z"));
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function evidenceRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 550) return false;
  if (/^urn:sha256:[a-f0-9]{64}$/.test(value)) return true;
  if (/^evidence\/tq-606\/[a-zA-Z0-9][a-zA-Z0-9._/-]{0,499}$/.test(value)) {
    return !value.includes("..");
  }
  if (!value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

function rejectUnsafeText(candidate: unknown, errors: string[]): void {
  const values: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (object(value)) {
      for (const entry of Object.values(value)) collect(entry);
    }
  };
  collect(candidate);

  const forbidden: Array<[RegExp, string]> = [
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i, "private key material"],
    [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/i, "bearer credential"],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, "JWT"],
    [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,}\b/i, "provider credential"],
    [/\btasq_access_[A-Za-z0-9_-]{8,}\b/, "Tasq access credential"],
    [/\btasq_enroll_[A-Za-z0-9_-]{8,}\b/, "Tasq enrollment credential"],
    [/\b__Host-tasq_session=[A-Za-z0-9._~+/-]{8,}=*/i, "Tasq session cookie"],
    [/(?:^|[\\/"'])\/Users\//, "workstation path"],
    [/(?:^|[\\/"'])\/home\/[a-z0-9_-]+\//i, "workstation path"],
    [/\b[A-Za-z]:\\{1,2}Users\\{1,2}[^\\/"']+\\{1,2}/i, "workstation path"],
    [/file:\/\//i, "file URI"],
  ];
  for (const [pattern, label] of forbidden) {
    if (values.some((value) => pattern.test(value))) {
      errors.push(`evidence contains forbidden ${label}`);
    }
  }

  for (const value of values) {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      try {
        const url = new URL(match[0]);
        if (
          url.username !== "" ||
          url.password !== "" ||
          url.search !== "" ||
          url.hash !== ""
        ) {
          errors.push("evidence contains a URL with credentials, query or fragment");
        }
      } catch {
        errors.push("evidence contains an invalid URL");
      }
    }
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
  errors: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    errors.push(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function validateEvidence(candidate: unknown): string[] {
  const errors: string[] = [];
  if (!object(candidate)) return ["evidence must be a JSON object"];
  rejectUnsafeText(candidate, errors);
  exactKeys(candidate, [
    "contractVersion",
    "session",
    "independence",
    "journey",
    "interventions",
    "failures",
    "metrics",
    "attestation",
    "outcome",
  ], "evidence", errors);

  if (candidate.contractVersion !== "tasq.independent-human-adoption-evidence.v1") {
    errors.push("contractVersion must be tasq.independent-human-adoption-evidence.v1");
  }
  if (!outcomes.has(candidate.outcome)) errors.push("outcome is invalid");

  if (!object(candidate.session)) {
    errors.push("session must be an object");
  } else {
    exactKeys(candidate.session, [
      "id",
      "target",
      "entrypoint",
      "releaseVersion",
      "releaseUrl",
      "startedAt",
      "endedAt",
    ], "session", errors);
    if (typeof candidate.session.id !== "string" ||
      !/^tq606-[a-z0-9][a-z0-9-]{5,63}$/.test(candidate.session.id)) {
      errors.push("session.id must be an opaque tq606-* identifier");
    }
    if (!targets.has(candidate.session.target)) errors.push("session.target is unsupported");
    if (candidate.session.entrypoint !== "https://tasq.run") {
      errors.push("session.entrypoint must be https://tasq.run");
    }
    if (candidate.session.releaseVersion !== "0.3.0") {
      errors.push("session.releaseVersion must identify the certified 0.3.0 release");
    }
    if (candidate.session.releaseUrl !== "https://github.com/gwendall/tasq/releases/tag/v0.3.0") {
      errors.push("session.releaseUrl must identify the certified v0.3.0 release");
    }
    if (!utcInstant(candidate.session.startedAt)) errors.push("session.startedAt must be an explicit UTC instant");
    if (!utcInstant(candidate.session.endedAt)) errors.push("session.endedAt must be an explicit UTC instant");
    if (utcInstant(candidate.session.startedAt) && utcInstant(candidate.session.endedAt) &&
      Date.parse(candidate.session.endedAt) <= Date.parse(candidate.session.startedAt)) {
      errors.push("session.endedAt must be after session.startedAt");
    }
  }

  if (!object(candidate.independence)) {
    errors.push("independence must be an object");
  } else {
    exactKeys(candidate.independence, [
      "participantExternal",
      "participantPreviouslyUsedTasq",
      "participantReceivedRepositoryBriefing",
      "repositoryAccessDuringSession",
      "facilitatorCoachingAfterStart",
      "undocumentedHelpUsed",
      "startingMaterials",
    ], "independence", errors);
    if (candidate.independence.participantExternal !== true) {
      errors.push("participant must be external");
    }
    for (const field of [
      "participantPreviouslyUsedTasq",
      "participantReceivedRepositoryBriefing",
      "repositoryAccessDuringSession",
      "facilitatorCoachingAfterStart",
      "undocumentedHelpUsed",
    ]) {
      if (candidate.independence[field] !== false) errors.push(`independence.${field} must be false`);
    }
    if (!Array.isArray(candidate.independence.startingMaterials) ||
      candidate.independence.startingMaterials.length !== 1 ||
      candidate.independence.startingMaterials[0] !== "https://tasq.run") {
      errors.push("startingMaterials must contain only https://tasq.run");
    }
  }

  const journeyById = new Map<string, Record<string, any>>();
  let previousJourneyObservedAt: number | undefined;
  if (!Array.isArray(candidate.journey) || candidate.journey.length !== stepIds.length) {
    errors.push(`journey must contain exactly ${stepIds.length} ordered steps`);
  } else {
    candidate.journey.forEach((step: unknown, index: number) => {
      const label = `journey[${index}]`;
      if (!object(step)) {
        errors.push(`${label} must be an object`);
        return;
      }
      exactKeys(step, ["id", "status", "observedAt", "evidenceRefs", "note"], label, errors);
      const expectedId = stepIds[index]!;
      if (step.id !== expectedId) errors.push(`${label}.id must be ${expectedId}`);
      if (typeof step.id === "string") {
        if (journeyById.has(step.id)) errors.push(`${label}.id is duplicated`);
        journeyById.set(step.id, step);
      }
      if (!stepStatuses.has(step.status)) errors.push(`${label}.status is invalid`);
      if (step.status !== "completed") errors.push(`${label}.status must be completed`);
      if (!utcInstant(step.observedAt)) errors.push(`${label}.observedAt must be an explicit UTC instant`);
      if (
        utcInstant(step.observedAt) &&
        object(candidate.session) &&
        utcInstant(candidate.session.startedAt) &&
        utcInstant(candidate.session.endedAt)
      ) {
        const observedAt = Date.parse(step.observedAt);
        if (
          observedAt < Date.parse(candidate.session.startedAt) ||
          observedAt > Date.parse(candidate.session.endedAt)
        ) {
          errors.push(`${label}.observedAt must fall within the session interval`);
        }
        if (
          previousJourneyObservedAt !== undefined &&
          observedAt <= previousJourneyObservedAt
        ) {
          errors.push(`${label}.observedAt must be later than the previous journey step`);
        }
        previousJourneyObservedAt = observedAt;
      }
      if (!Array.isArray(step.evidenceRefs) || step.evidenceRefs.length === 0 ||
        step.evidenceRefs.some((ref: unknown) => !evidenceRef(ref))) {
        errors.push(`${label}.evidenceRefs must contain safe evidence references`);
      }
      if (typeof step.note !== "string" || step.note.trim().length === 0) {
        errors.push(`${label}.note must describe the observed result`);
      }
    });
  }

  if (!Array.isArray(candidate.interventions)) {
    errors.push("interventions must be an array");
  } else {
    candidate.interventions.forEach((intervention: unknown, index: number) => {
      const label = `interventions[${index}]`;
      if (!object(intervention)) {
        errors.push(`${label} must be an object`);
        return;
      }
      exactKeys(intervention, ["at", "actor", "kind", "description", "documentedPath"], label, errors);
      if (!utcInstant(intervention.at)) errors.push(`${label}.at must be an explicit UTC instant`);
      if (
        utcInstant(intervention.at) &&
        object(candidate.session) &&
        utcInstant(candidate.session.startedAt) &&
        utcInstant(candidate.session.endedAt) &&
        (
          Date.parse(intervention.at) < Date.parse(candidate.session.startedAt) ||
          Date.parse(intervention.at) > Date.parse(candidate.session.endedAt)
        )
      ) {
        errors.push(`${label}.at must fall within the session interval`);
      }
      if (!interventionActors.has(intervention.actor)) errors.push(`${label}.actor is invalid`);
      if (!interventionKinds.has(intervention.kind)) errors.push(`${label}.kind is invalid`);
      if (typeof intervention.description !== "string" || intervention.description.trim().length === 0) {
        errors.push(`${label}.description is required`);
      }
      if (intervention.documentedPath !== null && !evidenceRef(intervention.documentedPath)) {
        errors.push(`${label}.documentedPath must be null or a safe reference`);
      }
      if (intervention.actor !== "participant" ||
        intervention.kind !== "public_documentation" ||
        intervention.documentedPath === null) {
        errors.push(`${label} invalidates an independent blind completion`);
      }
    });
  }

  if (!Array.isArray(candidate.failures)) {
    errors.push("failures must be an array");
  } else {
    candidate.failures.forEach((failure: unknown, index: number) => {
      const label = `failures[${index}]`;
      if (!object(failure)) {
        errors.push(`${label} must be an object`);
        return;
      }
      exactKeys(failure, [
        "at",
        "stepId",
        "severity",
        "description",
        "disposition",
        "evidenceRefs",
      ], label, errors);
      if (!utcInstant(failure.at)) errors.push(`${label}.at must be an explicit UTC instant`);
      if (
        utcInstant(failure.at) &&
        object(candidate.session) &&
        utcInstant(candidate.session.startedAt) &&
        utcInstant(candidate.session.endedAt) &&
        (
          Date.parse(failure.at) < Date.parse(candidate.session.startedAt) ||
          Date.parse(failure.at) > Date.parse(candidate.session.endedAt)
        )
      ) {
        errors.push(`${label}.at must fall within the session interval`);
      }
      if (!stepIds.includes(failure.stepId)) errors.push(`${label}.stepId is invalid`);
      if (!failureSeverities.has(failure.severity)) errors.push(`${label}.severity is invalid`);
      if (!failureDispositions.has(failure.disposition)) errors.push(`${label}.disposition is invalid`);
      if (failure.disposition !== "recovered_self_service") {
        errors.push(`${label}.disposition does not preserve independent completion`);
      }
      if (typeof failure.description !== "string" || failure.description.trim().length === 0) {
        errors.push(`${label}.description is required`);
      }
      if (!Array.isArray(failure.evidenceRefs) || failure.evidenceRefs.length === 0 ||
        failure.evidenceRefs.some((ref: unknown) => !evidenceRef(ref))) {
        errors.push(`${label}.evidenceRefs must contain safe evidence references`);
      }
    });
  }

  if (!object(candidate.metrics)) {
    errors.push("metrics must be an object");
  } else {
    exactKeys(candidate.metrics, [
      "activationStepId",
      "timeToActivationSeconds",
      "totalElapsedSeconds",
      "stepsCompleted",
    ], "metrics", errors);
    if (candidate.metrics.activationStepId !== "evidence-bound-completion-observed") {
      errors.push("metrics.activationStepId is invalid");
    }
    for (const field of ["timeToActivationSeconds", "totalElapsedSeconds", "stepsCompleted"]) {
      if (!Number.isInteger(candidate.metrics[field]) || candidate.metrics[field] < 0) {
        errors.push(`metrics.${field} must be a non-negative integer`);
      }
    }
    if (
      Number.isInteger(candidate.metrics.totalElapsedSeconds) &&
      candidate.metrics.totalElapsedSeconds < 1
    ) {
      errors.push("metrics.totalElapsedSeconds must be at least 1");
    }
    if (candidate.metrics.stepsCompleted !== stepIds.length) {
      errors.push(`metrics.stepsCompleted must be ${stepIds.length}`);
    }
    if (candidate.metrics.timeToActivationSeconds > candidate.metrics.totalElapsedSeconds) {
      errors.push("timeToActivationSeconds cannot exceed totalElapsedSeconds");
    }
    if (object(candidate.session) &&
      utcInstant(candidate.session.startedAt) &&
      utcInstant(candidate.session.endedAt)) {
      const elapsed = Math.floor(
        (Date.parse(candidate.session.endedAt) - Date.parse(candidate.session.startedAt)) / 1_000,
      );
      if (candidate.metrics.totalElapsedSeconds !== elapsed) {
        errors.push("metrics.totalElapsedSeconds must equal the explicit session interval");
      }
      const activation = journeyById.get("evidence-bound-completion-observed");
      if (activation && utcInstant(activation.observedAt)) {
        const timeToActivation = Math.floor(
          (Date.parse(activation.observedAt) - Date.parse(candidate.session.startedAt)) / 1_000,
        );
        if (candidate.metrics.timeToActivationSeconds !== timeToActivation) {
          errors.push("metrics.timeToActivationSeconds must equal the observed activation interval");
        }
      }
    }
  }

  if (!object(candidate.attestation)) {
    errors.push("attestation must be an object");
  } else {
    exactKeys(candidate.attestation, [
      "observerRef",
      "participantConsentRecorded",
      "accountAccurate",
      "privateTranscriptCommitted",
      "evidenceDigest",
    ], "attestation", errors);
    if (typeof candidate.attestation.observerRef !== "string" ||
      !/^observer-[a-z0-9][a-z0-9-]{2,63}$/.test(candidate.attestation.observerRef)) {
      errors.push("attestation.observerRef must be an opaque observer-* identifier");
    }
    if (candidate.attestation.participantConsentRecorded !== true) {
      errors.push("participant consent must be recorded");
    }
    if (candidate.attestation.accountAccurate !== true) {
      errors.push("observer must attest that the account is accurate");
    }
    if (candidate.attestation.privateTranscriptCommitted !== false) {
      errors.push("private transcripts must not be committed");
    }
    if (!sha256(candidate.attestation.evidenceDigest)) {
      errors.push("attestation.evidenceDigest must be a sha256 digest");
    }
  }

  if (candidate.outcome !== "completed_without_undocumented_help") {
    errors.push("outcome must be completed_without_undocumented_help");
  }

  return [...new Set(errors)].sort();
}

let report: {
  contractVersion: string;
  evidenceFile: string;
  readyForExternalGateReview: boolean;
  certificateMutationAuthorized: false;
  errors: string[];
};

try {
  const { evidencePath } = parseArgs(process.argv.slice(2));
  if (!existsSync(evidencePath)) throw new Error(`Evidence file does not exist: ${evidencePath}`);
  if (lstatSync(evidencePath).isSymbolicLink()) throw new Error("Evidence file must not be a symlink");
  const raw = readFileSync(evidencePath, "utf8");
  const errors = validateEvidence(JSON.parse(raw));
  report = {
    contractVersion: "tasq.independent-human-adoption-validation.v1",
    evidenceFile: basename(evidencePath),
    readyForExternalGateReview: errors.length === 0,
    certificateMutationAuthorized: false,
    errors,
  };
} catch (error) {
  report = {
    contractVersion: "tasq.independent-human-adoption-validation.v1",
    evidenceFile: "unreadable",
    readyForExternalGateReview: false,
    certificateMutationAuthorized: false,
    errors: [error instanceof Error ? error.message : String(error)],
  };
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.readyForExternalGateReview) process.exitCode = 1;
