#!/usr/bin/env bun

import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const defaultStatusPath = resolve(repositoryRoot, "TQ-607_DOGFOOD_STATUS.json");
const consumerIds = new Set([
  "personal-life-pilot",
  "kami-robotics",
  "interactive-agent-runtime",
]);
const frictionCategories = new Set([
  "kernel_invariant",
  "profile_policy",
  "adapter_connector",
  "product_ergonomics",
  "documentation_onboarding",
  "external_environment",
]);
const riskValues = new Set(["none", "data", "authority", "data_and_authority"]);

function parse(argv: string[]) {
  const command = argv[0] ?? "status";
  const flags = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
    const name = token.slice(2);
    if (flags.has(name)) throw new Error(`Duplicate flag: --${name}`);
    if (name === "json") {
      flags.set(name, true);
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    flags.set(name, value);
  }
  return { command, flags };
}

function value(flags: Map<string, string | true>, name: string, required = true): string | undefined {
  const result = flags.get(name);
  if (result === true) throw new Error(`--${name} requires a value`);
  if (result === undefined && required) throw new Error(`Missing --${name}`);
  return result;
}

function statusPath(flags: Map<string, string | true>): string {
  const supplied = value(flags, "file", false);
  return supplied ? (isAbsolute(supplied) ? supplied : resolve(repositoryRoot, supplied)) : defaultStatusPath;
}

function readStatus(path: string): any {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Dogfood status must not be a symlink");
  const status = JSON.parse(readFileSync(path, "utf8"));
  if (status.contractVersion !== "tasq.private-dogfood.v1") throw new Error("Unsupported dogfood contract");
  if (!Number.isInteger(status.revision) || status.revision < 1) throw new Error("Invalid dogfood revision");
  if (!Array.isArray(status.consumers) || status.consumers.length !== 3) throw new Error("Invalid dogfood consumers");
  if (status.consumers.some((consumer: any) => !consumerIds.has(consumer.id))) throw new Error("Unknown dogfood consumer");
  return status;
}

function isoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return value;
}

function instant(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an explicit UTC ISO timestamp`);
  }
  return value;
}

function evidence(value: string): string {
  if (value.includes("/Users/") || value.includes("\\Users\\")) throw new Error("Evidence must not contain a workstation path");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^(?:evidence|apps|packages)\//.test(value)) return value;
  throw new Error("Evidence must be an absolute URI or a repository evidence/apps/packages path");
}

function consumer(status: any, id: string): any {
  if (!consumerIds.has(id)) throw new Error(`Unknown consumer: ${id}`);
  return status.consumers.find((item: any) => item.id === id)!;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function allJourneysComplete(item: any): boolean {
  const completed = new Set((item.completedJourneys ?? []).map((entry: any) => entry.id));
  return (item.requiredJourneys ?? []).every((id: string) => completed.has(id));
}

function recompute(status: any): any {
  const personal = consumer(status, "personal-life-pilot");
  personal.activeUseDates = unique(personal.activeUseDates ?? []);
  personal.recordedActiveUseDays = personal.activeUseDates.length;

  for (const item of status.consumers) {
    const started = item.evidence.length > 0 ||
      (item.completedJourneys ?? []).length > 0 ||
      (item.activeUseDates ?? []).length > 0;
    const activeEnough = item.id !== "personal-life-pilot" ||
      item.recordedActiveUseDays >= item.requiredActiveUseDays;
    item.state = activeEnough && allJourneysComplete(item)
      ? "complete"
      : started ? "in_progress" : "not_started";
  }

  const cross = status.crossCuttingEvidence;
  cross.completedForwardUpgradeDrills = unique(cross.forwardUpgradeEvidence ?? []).length;
  cross.backupRestoreCompleted = (cross.backupRestoreEvidence ?? []).length > 0;
  cross.replacementActorRecoveryCompleted = (cross.replacementActorRecoveryEvidence ?? []).length > 0;
  cross.coldAgentOnboardingCompleted = (cross.coldAgentOnboardingEvidence ?? []).length > 0;
  cross.supportBundleReviewCompleted = (cross.supportBundleReviewEvidence ?? []).length > 0;

  const baselineComplete = status.baseline !== null;
  const firstJourneysComplete = status.consumers.every((item: any) => (item.completedJourneys ?? []).length > 0);
  const repeatedOperationComplete = status.consumers.every((item: any) => item.state === "complete");
  const resilienceComplete = cross.completedForwardUpgradeDrills >= cross.requiredForwardUpgradeDrills &&
    cross.backupRestoreCompleted && cross.replacementActorRecoveryCompleted &&
    cross.coldAgentOnboardingCompleted && cross.supportBundleReviewCompleted;
  const phaseStates = [
    ["baseline_and_activation", baselineComplete],
    ["first_complete_journeys", firstJourneysComplete],
    ["repeated_operation", repeatedOperationComplete],
    ["resilience_drills", resilienceComplete],
  ] as const;
  const current = phaseStates.find(([, complete]) => !complete)?.[0] ?? "decision_review";
  status.currentPhase = current;
  status.phases = phaseStates.map(([id, complete]) => ({
    id,
    state: complete ? "complete" : id === current ? "in_progress" : "pending",
  }));
  status.phases.push({
    id: "decision_review",
    state: status.publicLaunchDecision === "undecided"
      ? `blocked_until_${status.earliestDecisionAt}`
      : "complete",
  });
  status.nextAction = current === "baseline_and_activation"
    ? "Record the exact candidate version and commit, then verify the first isolated backup and attach its evidence."
    : current === "first_complete_journeys"
      ? "Complete and record the first required journey for every dogfood consumer."
      : current === "repeated_operation"
        ? "Accumulate retained real-use days and finish every required consumer journey."
        : current === "resilience_drills"
          ? "Complete the remaining upgrade, recovery, onboarding and support-bundle drills."
          : `Review all evidence and unresolved failures no earlier than ${status.earliestDecisionAt}.`;
  status.tq607Complete = status.publicLaunchDecision === "go" &&
    repeatedOperationComplete && resilienceComplete && status.unresolvedCriticalFailures.length === 0;
  return status;
}

function progress(status: any) {
  const cross = status.crossCuttingEvidence;
  return {
    revision: status.revision,
    status: status.status,
    phase: status.currentPhase,
    nextAction: status.nextAction,
    consumers: status.consumers.map((item: any) => ({
      id: item.id,
      state: item.state,
      activeUseDays: item.recordedActiveUseDays ?? null,
      requiredActiveUseDays: item.requiredActiveUseDays ?? null,
      journeys: (item.completedJourneys ?? []).length,
      requiredJourneys: (item.requiredJourneys ?? []).length,
    })),
    drills: {
      forwardUpgrades: `${cross.completedForwardUpgradeDrills}/${cross.requiredForwardUpgradeDrills}`,
      backupRestore: cross.backupRestoreCompleted,
      replacementActorRecovery: cross.replacementActorRecoveryCompleted,
      coldAgentOnboarding: cross.coldAgentOnboardingCompleted,
      supportBundleReview: cross.supportBundleReviewCompleted,
    },
    frictionCount: status.frictionLog.length,
    unresolvedCriticalFailures: status.unresolvedCriticalFailures.length,
    earliestDecisionAt: status.earliestDecisionAt,
    publicLaunchDecision: status.publicLaunchDecision,
    complete: status.tq607Complete,
  };
}

function writeStatus(path: string, status: any, expectedRevision: number, action: string, at: string): void {
  const lockPath = `${path}.lock`;
  let lock: number | undefined;
  try {
    lock = openSync(lockPath, "wx", 0o600);
    const current = readStatus(path);
    if (current.revision !== expectedRevision) {
      throw new Error(`Revision conflict: expected ${expectedRevision}, current ${current.revision}`);
    }
    status.revision = expectedRevision + 1;
    status.audit = [...(status.audit ?? []), { revision: status.revision, action, at }];
    recompute(status);
    const temporary = resolve(dirname(path), `.${path.split("/").pop()}.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    if (lock !== undefined) closeSync(lock);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
}

function mutate(path: string, flags: Map<string, string | true>, action: string, fn: (status: any) => void): any {
  const expected = Number(value(flags, "expected-revision"));
  if (!Number.isInteger(expected) || expected < 1) throw new Error("--expected-revision must be a positive integer");
  const at = instant(value(flags, "at")!, "--at");
  const status = recompute(readStatus(path));
  if (status.revision !== expected) throw new Error(`Revision conflict: expected ${expected}, current ${status.revision}`);
  fn(status);
  writeStatus(path, status, expected, action, at);
  return recompute(readStatus(path));
}

const { command, flags } = parse(process.argv.slice(2));
const commonFlags = ["file", "json"];
const mutationFlags = ["expected-revision", "at"];
const allowedFlags: Record<string, string[]> = {
  status: commonFlags,
  baseline: [...commonFlags, ...mutationFlags, "version", "commit", "backup-evidence", "backup-digest"],
  use: [...commonFlags, ...mutationFlags, "consumer", "date", "evidence"],
  journey: [...commonFlags, ...mutationFlags, "consumer", "journey", "evidence"],
  drill: [...commonFlags, ...mutationFlags, "kind", "evidence"],
  friction: [...commonFlags, ...mutationFlags, "id", "consumer", "category", "symptom", "intervention", "version", "risk", "resolution", "evidence"],
  "failure-add": [...commonFlags, ...mutationFlags, "id", "consumer", "summary", "evidence"],
  "failure-resolve": [...commonFlags, ...mutationFlags, "id", "evidence"],
  decision: [...commonFlags, ...mutationFlags, "value", "summary", "evidence", "review-date"],
};
if (!allowedFlags[command]) throw new Error(`Unknown dogfood command: ${command}`);
for (const name of flags.keys()) {
  if (!allowedFlags[command]!.includes(name)) throw new Error(`Unknown flag for ${command}: --${name}`);
}
const path = statusPath(flags);
let status: any;

if (command === "status") {
  status = recompute(readStatus(path));
} else if (command === "baseline") {
  status = mutate(path, flags, command, (draft) => {
    if (draft.baseline !== null) throw new Error("Baseline already recorded");
    const commit = value(flags, "commit")!;
    const version = value(flags, "version")!;
    const digest = value(flags, "backup-digest")!;
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("--commit must be a lowercase 40-character Git commit");
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error("--version must be SemVer");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("--backup-digest must be sha256:<64 lowercase hex>");
    draft.baseline = {
      candidateVersion: version,
      sourceCommit: commit,
      backupEvidence: evidence(value(flags, "backup-evidence")!),
      backupDigest: digest,
      recordedAt: instant(value(flags, "at")!, "--at"),
    };
  });
} else if (command === "use") {
  status = mutate(path, flags, command, (draft) => {
    const id = value(flags, "consumer")!;
    if (id !== "personal-life-pilot") throw new Error("Active-use days apply only to personal-life-pilot");
    const item = consumer(draft, id);
    item.activeUseDates = unique([...(item.activeUseDates ?? []), isoDate(value(flags, "date")!, "--date")]);
    item.evidence = unique([...item.evidence, evidence(value(flags, "evidence")!)]);
  });
} else if (command === "journey") {
  status = mutate(path, flags, command, (draft) => {
    const item = consumer(draft, value(flags, "consumer")!);
    const id = value(flags, "journey")!;
    if (!(item.requiredJourneys ?? []).includes(id)) throw new Error(`Journey is not required for ${item.id}: ${id}`);
    const proof = evidence(value(flags, "evidence")!);
    item.completedJourneys = [
      ...(item.completedJourneys ?? []).filter((entry: any) => entry.id !== id),
      { id, evidence: proof, completedAt: instant(value(flags, "at")!, "--at") },
    ].sort((left: any, right: any) => left.id.localeCompare(right.id));
    item.evidence = unique([...item.evidence, proof]);
  });
} else if (command === "drill") {
  status = mutate(path, flags, command, (draft) => {
    const kind = value(flags, "kind")!;
    const proof = evidence(value(flags, "evidence")!);
    const map: Record<string, string> = {
      "forward-upgrade": "forwardUpgradeEvidence",
      "backup-restore": "backupRestoreEvidence",
      "replacement-actor-recovery": "replacementActorRecoveryEvidence",
      "cold-agent-onboarding": "coldAgentOnboardingEvidence",
      "support-bundle-review": "supportBundleReviewEvidence",
    };
    const field = map[kind];
    if (!field) throw new Error(`Unknown drill kind: ${kind}`);
    draft.crossCuttingEvidence[field] = unique([...(draft.crossCuttingEvidence[field] ?? []), proof]);
  });
} else if (command === "friction") {
  status = mutate(path, flags, command, (draft) => {
    const id = value(flags, "id")!;
    if (draft.frictionLog.some((entry: any) => entry.id === id)) throw new Error(`Friction id already exists: ${id}`);
    const category = value(flags, "category")!;
    const risk = value(flags, "risk")!;
    if (!frictionCategories.has(category)) throw new Error(`Unknown friction category: ${category}`);
    if (!riskValues.has(risk)) throw new Error(`Unknown risk: ${risk}`);
    draft.frictionLog.push({
      id,
      consumer: consumer(draft, value(flags, "consumer")!).id,
      category,
      symptom: value(flags, "symptom")!,
      intervention: value(flags, "intervention")!,
      affectedVersion: value(flags, "version")!,
      risk,
      resolution: value(flags, "resolution")!,
      evidence: evidence(value(flags, "evidence")!),
      recordedAt: instant(value(flags, "at")!, "--at"),
    });
  });
} else if (command === "failure-add") {
  status = mutate(path, flags, command, (draft) => {
    const id = value(flags, "id")!;
    if (draft.unresolvedCriticalFailures.some((entry: any) => entry.id === id)) throw new Error(`Failure id already exists: ${id}`);
    draft.unresolvedCriticalFailures.push({
      id,
      consumer: consumer(draft, value(flags, "consumer")!).id,
      summary: value(flags, "summary")!,
      evidence: evidence(value(flags, "evidence")!),
      recordedAt: instant(value(flags, "at")!, "--at"),
    });
  });
} else if (command === "failure-resolve") {
  status = mutate(path, flags, command, (draft) => {
    const id = value(flags, "id")!;
    const before = draft.unresolvedCriticalFailures.length;
    draft.unresolvedCriticalFailures = draft.unresolvedCriticalFailures.filter((entry: any) => entry.id !== id);
    if (draft.unresolvedCriticalFailures.length === before) throw new Error(`Unknown unresolved failure: ${id}`);
    draft.resolvedCriticalFailures = [...(draft.resolvedCriticalFailures ?? []), {
      id,
      resolutionEvidence: evidence(value(flags, "evidence")!),
      resolvedAt: instant(value(flags, "at")!, "--at"),
    }];
  });
} else if (command === "decision") {
  status = mutate(path, flags, command, (draft) => {
    const decision = value(flags, "value")!;
    const at = instant(value(flags, "at")!, "--at");
    if (!["go", "extend", "no_go"].includes(decision)) throw new Error("--value must be go, extend or no_go");
    if (Date.parse(at) < Date.parse(`${draft.earliestDecisionAt}T00:00:00Z`)) {
      throw new Error(`Decision is blocked until ${draft.earliestDecisionAt}`);
    }
    recompute(draft);
    if (decision === "go") {
      if (draft.baseline === null) throw new Error("Go requires a recorded baseline");
      if (draft.consumers.some((item: any) => item.state !== "complete")) throw new Error("Go requires all consumer journeys");
      const cross = draft.crossCuttingEvidence;
      if (cross.completedForwardUpgradeDrills < cross.requiredForwardUpgradeDrills ||
        !cross.backupRestoreCompleted || !cross.replacementActorRecoveryCompleted ||
        !cross.coldAgentOnboardingCompleted || !cross.supportBundleReviewCompleted) {
        throw new Error("Go requires every resilience drill");
      }
      if (draft.unresolvedCriticalFailures.length > 0) throw new Error("Go is blocked by unresolved critical failures");
    }
    const record: any = {
      decision,
      summary: value(flags, "summary")!,
      evidence: evidence(value(flags, "evidence")!),
      decidedAt: at,
    };
    if (decision === "extend") {
      const reviewDate = isoDate(value(flags, "review-date")!, "--review-date");
      if (Date.parse(`${reviewDate}T00:00:00Z`) <= Date.parse(at)) throw new Error("--review-date must be after --at");
      record.reviewDate = reviewDate;
      draft.earliestDecisionAt = reviewDate;
      draft.status = "program-extended";
    } else {
      draft.status = decision === "go" ? "accepted-private-dogfood" : "public-launch-declined";
    }
    draft.publicLaunchDecision = decision;
    draft.decisionRecord = record;
  });
}

const output = progress(status);
if (flags.get("json") === true) {
  console.log(JSON.stringify(output));
} else {
  console.log(`TQ-607 revision ${output.revision}: ${output.status}`);
  console.log(`Phase: ${output.phase}`);
  console.log(`Next: ${output.nextAction}`);
  for (const item of output.consumers) {
    const days = item.activeUseDays === null ? "" : `, days ${item.activeUseDays}/${item.requiredActiveUseDays}`;
    console.log(`- ${item.id}: ${item.state}, journeys ${item.journeys}/${item.requiredJourneys}${days}`);
  }
  console.log(`Decision: ${output.publicLaunchDecision}; earliest ${output.earliestDecisionAt}`);
}
