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

function fail(message: string): never {
  throw new Error(`Release authorization rejected: ${message}`);
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(authorization.authorizedAt)) fail("authorization date is not explicit");
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
