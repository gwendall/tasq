export type ReleaseChannel = "public-alpha" | "stable";

export type ReleasePolicyAuthorization = {
  state: string;
  version: string;
  channel: ReleaseChannel;
  decision: string;
  authorizedBy: string;
  authorizedAt: string;
  rationale: string;
};

export type ReleasePolicy = {
  contractVersion: string;
  status: string;
  identity: {
    canonicalRepository: string;
    npmScope: string;
    repositoryState: string;
  };
  packages: Array<{
    source: string;
    publicName: string | null;
    firstRelease: boolean;
  }>;
  releaseChannels: Record<ReleaseChannel, {
    blockers: string[];
    nonBlockingEvidence: string[];
  }>;
  releaseAuthorization: ReleasePolicyAuthorization;
  externalPublicationGateStatus: Record<string, boolean>;
  candidatePublications: Record<CandidatePublication, CandidatePublicationAuthorization>;
  publishedRelease: {
    version: string;
    publishedPackages: Array<{ name: string; version: string }>;
  };
};

export type CandidatePublication =
  | "serverImage"
  | "pythonWheel"
  | "remoteTypeScriptClient";

export type CandidatePublicationAuthorization = {
  state: "prepared_not_authorized" | "authorized";
  coordinate: string;
  workflow: string;
  environment: "release";
  version: string | null;
  sourceBinding: "protected_immutable_version_tag_runtime_commit";
  decision: "pending" | "go";
  authorizedBy: string | null;
  authorizedAt: string | null;
};

export type VerifiedReleaseAuthorization = {
  contractVersion: "tasq.release-authorization.v1";
  version: string;
  sourceCommit: string;
  channel: ReleaseChannel;
  authorizedBy: string;
  requiredGates: string[];
  publicPackages: string[];
};

export type VerifiedCandidatePublicationAuthorization = {
  contractVersion: "tasq.candidate-publication-authorization.v1";
  surface: CandidatePublication;
  version: string;
  sourceCommit: string;
  sourceTag: string;
  sourceBinding: "protected_immutable_version_tag_runtime_commit";
  coordinate: string;
  workflow: string;
  environment: "release";
  authorizedBy: string;
};

const expectedRepository = "https://github.com/gwendall/tasq";
const expectedPackages = [
  ["packages/tasq-schema", "@tasq-run/schema"],
  ["packages/tasq-core", "@tasq-run/core"],
  ["packages/tasq-cli", "@tasq-run/cli"],
  ["packages/tasq-mcp", "@tasq-run/mcp"],
  ["packages/tasq-extension-sdk", "@tasq-run/extension-sdk"],
  ["packages/tasq-protocol-adapters", "@tasq-run/protocol-adapters"],
  ["packages/tasq-inspector", "@tasq-run/console"],
] as const;
const expectedCandidatePublications = {
  serverImage: {
    coordinate: "ghcr.io/gwendall/tasq-server",
    workflow: "publish-server.yml",
  },
  pythonWheel: {
    coordinate: "tasq-remote",
    workflow: "publish-python.yml",
  },
  remoteTypeScriptClient: {
    coordinate: "@tasq-run/client",
    workflow: "release.yml",
  },
} as const;

function fail(message: string): never {
  throw new Error(`Release authorization rejected: ${message}`);
}

function stableSemverParts(version: string): [bigint, bigint, bigint] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) fail(`invalid stable SemVer ${version}`);
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function isGreaterVersion(candidate: string, baseline: string): boolean {
  const left = stableSemverParts(candidate);
  const right = stableSemverParts(baseline);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return false;
}

function isExplicitCalendarDate(value: string | null): value is string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

function verifyCandidateShape(
  policy: ReleasePolicy,
  surface: CandidatePublication,
): CandidatePublicationAuthorization {
  const candidate = policy.candidatePublications?.[surface];
  const expected = expectedCandidatePublications[surface];
  if (!candidate) fail(`missing candidate publication ${surface}`);
  if (candidate.coordinate !== expected.coordinate) {
    fail(`${surface} coordinate drift`);
  }
  if (candidate.workflow !== expected.workflow) {
    fail(`${surface} workflow drift`);
  }
  if (candidate.environment !== "release") {
    fail(`${surface} environment drift`);
  }
  if (candidate.sourceBinding !== "protected_immutable_version_tag_runtime_commit") {
    fail(`${surface} source binding drift`);
  }
  if (!["prepared_not_authorized", "authorized"].includes(candidate.state)) {
    fail(`${surface} has unknown authorization state`);
  }
  return candidate;
}

function verifyCandidateDecision(input: {
  candidate: CandidatePublicationAuthorization;
  surface: CandidatePublication;
  version: string;
  publishedVersion: string;
}): void {
  const { candidate, surface, version, publishedVersion } = input;
  if (candidate.state !== "authorized") {
    fail(`${surface} publication state is ${candidate.state}`);
  }
  if (candidate.decision !== "go") {
    fail(`${surface} publication decision is ${candidate.decision}`);
  }
  if (candidate.version !== version) {
    fail(`${surface} authorized version ${candidate.version ?? "none"} does not match ${version}`);
  }
  if (!isGreaterVersion(version, publishedVersion)) {
    fail(`${surface} version ${version} must be newer than published ${publishedVersion}`);
  }
  if (candidate.authorizedBy !== "@gwendall") {
    fail(`${surface} release owner did not authorize publication`);
  }
  if (!isExplicitCalendarDate(candidate.authorizedAt)) {
    fail(`${surface} authorization date is not explicit`);
  }
}

export function verifyReleaseAuthorization(input: {
  policy: ReleasePolicy;
  version: string;
  sourceCommit: string;
  repository: string;
}): VerifiedReleaseAuthorization {
  const { policy, version, sourceCommit, repository } = input;
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    fail(`invalid stable SemVer ${version}`);
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("source commit must be a lowercase 40-character Git commit");
  if (repository !== "gwendall/tasq") fail(`unexpected workflow repository ${repository}`);
  if (policy.contractVersion !== "tasq.public-release-policy.v1") fail("unknown policy contract");
  if (policy.identity.canonicalRepository !== expectedRepository) fail("canonical repository drift");
  if (policy.identity.repositoryState !== "public-alpha-source") fail("repository is not the public source authority");
  if (policy.identity.npmScope !== "@tasq-run") fail("npm scope drift");

  const authorization = policy.releaseAuthorization;
  if (authorization.state !== "authorized") fail(`authorization state is ${authorization.state}`);
  if (authorization.decision !== "go") fail(`authorization decision is ${authorization.decision}`);
  if (authorization.version !== version) {
    fail(`authorized version ${authorization.version} does not match ${version}`);
  }
  if (authorization.authorizedBy !== "@gwendall") fail("release owner did not authorize this release");
  if (!isExplicitCalendarDate(authorization.authorizedAt)) fail("authorization date is not explicit");
  if (authorization.rationale.trim().length < 20) fail("authorization rationale is missing");

  const channel = policy.releaseChannels[authorization.channel];
  if (!channel) fail(`unknown release channel ${authorization.channel}`);
  if (new Set(channel.blockers).size !== channel.blockers.length) fail("release channel repeats a blocker");
  for (const gate of channel.blockers) {
    if (policy.externalPublicationGateStatus[gate] !== true) fail(`required gate ${gate} is not verified`);
  }

  const publicPackages = policy.packages
    .filter((entry): entry is typeof entry & { publicName: string } => (
      entry.firstRelease && entry.publicName !== null
    ))
    .map((entry) => [entry.source, entry.publicName] as const);
  if (JSON.stringify(publicPackages) !== JSON.stringify(expectedPackages)) {
    fail("first-release package boundary drift");
  }
  const clientCandidate = verifyCandidateShape(policy, "remoteTypeScriptClient");
  if (clientCandidate.state === "authorized") {
    verifyCandidateDecision({
      candidate: clientCandidate,
      surface: "remoteTypeScriptClient",
      version,
      publishedVersion: policy.publishedRelease.version,
    });
    publicPackages.push(["packages/tasq-client", "@tasq-run/client"]);
  }

  return {
    contractVersion: "tasq.release-authorization.v1",
    version,
    sourceCommit,
    channel: authorization.channel,
    authorizedBy: authorization.authorizedBy,
    requiredGates: [...channel.blockers],
    publicPackages: publicPackages.map(([, name]) => name),
  };
}

export function verifyCandidatePublicationAuthorization(input: {
  policy: ReleasePolicy;
  surface: CandidatePublication;
  version: string;
  sourceCommit: string;
  repository: string;
}): VerifiedCandidatePublicationAuthorization {
  const release = verifyReleaseAuthorization(input);
  const candidate = verifyCandidateShape(input.policy, input.surface);
  verifyCandidateDecision({
    candidate,
    surface: input.surface,
    version: input.version,
    publishedVersion: input.policy.publishedRelease.version,
  });
  return {
    contractVersion: "tasq.candidate-publication-authorization.v1",
    surface: input.surface,
    version: release.version,
    sourceCommit: release.sourceCommit,
    sourceTag: `v${release.version}`,
    sourceBinding: candidate.sourceBinding,
    coordinate: candidate.coordinate,
    workflow: candidate.workflow,
    environment: candidate.environment,
    authorizedBy: candidate.authorizedBy!,
  };
}
