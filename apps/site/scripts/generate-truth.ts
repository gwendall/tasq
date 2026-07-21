import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type SupportLevel =
  | "implemented_certified"
  | "implemented_candidate_not_published"
  | "implemented_local_only"
  | "implemented_integration_required"
  | "reference_only"
  | "accepted_design_not_executed"
  | "not_implemented"
  | "impossible_without_transport";

type ProductMatrix = {
  contractVersion: string;
  updatedAt: string;
  definition: string;
  supportLevels: SupportLevel[];
  productShapes: Array<{
    id: string;
    support: SupportLevel;
    entrypoints: string[];
    consumers: string[];
    publiclyDistributed: boolean;
  }>;
  surfaces: Array<{
    id: string;
    support: SupportLevel;
    transport: string;
    entrypoint: string | null;
    mutations: boolean;
    authorityBoundary: string;
  }>;
  consumers: Array<{
    id: string;
    supportedSurfaces: string[];
    irreducibleInputs: string[];
  }>;
  journeys: Array<{
    id: string;
    support: SupportLevel;
    steps: string[];
  }>;
  criticalTruths: string[];
};

type Backlog = {
  contractVersion: string;
  updatedAt: string;
  items: Array<{
    id: string;
    status: string;
    milestone: string;
    outcome: string;
  }>;
  externalGates: Record<string, { state: string }>;
};

type ReleasePolicy = {
  contractVersion: string;
  status: string;
  identity: {
    productName: string;
    cliBinary: string;
    npmScope: string;
    canonicalRepository: string;
    repositoryState: string;
  };
  legal: { license: string; contributionTerms: string };
  packages: Array<{ publicName: string | null; firstRelease: boolean }>;
  candidateCliTargets: string[];
  externalPublicationGateStatus: Record<string, boolean>;
};

type RootPackage = {
  packageManager: string;
  engines: { bun: string; node: string };
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../..");
const truthOutputPaths = [
  resolve(repoRoot, "apps/site/src/generated/product-truth.json"),
  resolve(repoRoot, "apps/site/public/product-truth.json"),
];
const adoptionOutputPaths = [
  resolve(repoRoot, "apps/site/src/generated/adopt.json"),
  resolve(repoRoot, "apps/site/public/adopt.json"),
];

async function readJson<T>(relativePath: string): Promise<{ raw: string; value: T }> {
  const raw = await readFile(resolve(repoRoot, relativePath), "utf8");
  return { raw, value: JSON.parse(raw) as T };
}

const [matrixFile, backlogFile, policyFile, rootPackageFile] = await Promise.all([
  readJson<ProductMatrix>("PRODUCT_SURFACE_MATRIX.json"),
  readJson<Backlog>("BACKLOG.json"),
  readJson<ReleasePolicy>("PUBLIC_RELEASE_POLICY.json"),
  readJson<RootPackage>("package.json"),
]);

const matrix = matrixFile.value;
const backlog = backlogFile.value;
const policy = policyFile.value;
const supportVocabulary = new Set(matrix.supportLevels);

for (const claim of [...matrix.productShapes, ...matrix.surfaces, ...matrix.journeys]) {
  if (!supportVocabulary.has(claim.support)) {
    throw new Error(`Unknown support level: ${claim.support}`);
  }
}

for (const surface of matrix.surfaces) {
  if (surface.support === "not_implemented" && surface.entrypoint !== null) {
    throw new Error(`Unimplemented surface ${surface.id} must not advertise an entrypoint`);
  }
}

const published = policy.status === "published";
const privatePrelaunch = policy.identity.repositoryState === "private-canonical-unprotected-prelaunch";
if (!published && matrix.productShapes.some((shape) => shape.publiclyDistributed)) {
  throw new Error("A product shape cannot be publicly distributed before release policy is published");
}

const sourceDigest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const truth = {
  contractVersion: "tasq.public-site-truth.v1",
  sourceUpdatedAt: matrix.updatedAt,
  definition: matrix.definition,
  release: {
    status: policy.status,
    published,
    installAction: published
      ? "install_release"
      : privatePrelaunch
        ? "request_access_then_build"
        : "build_from_source",
    repository: policy.identity.canonicalRepository,
    repositoryState: policy.identity.repositoryState,
    cliBinary: policy.identity.cliBinary,
    npmScope: policy.identity.npmScope,
    license: policy.legal.license,
    contributionTerms: policy.legal.contributionTerms,
    publicPackages: policy.packages
      .filter((entry) => entry.firstRelease && entry.publicName !== null)
      .map((entry) => entry.publicName),
    candidateTargets: policy.candidateCliTargets,
    gates: policy.externalPublicationGateStatus,
  },
  productShapes: matrix.productShapes,
  surfaces: matrix.surfaces,
  consumers: matrix.consumers,
  journeys: matrix.journeys,
  criticalTruths: matrix.criticalTruths,
  backlog: backlog.items.map(({ id, status, milestone, outcome }) => ({
    id,
    status,
    milestone,
    outcome,
  })),
  sourceContracts: [
    {
      path: "PRODUCT_SURFACE_MATRIX.json",
      contractVersion: matrix.contractVersion,
      sha256: sourceDigest(matrixFile.raw),
    },
    {
      path: "BACKLOG.json",
      contractVersion: backlog.contractVersion,
      sha256: sourceDigest(backlogFile.raw),
    },
    {
      path: "PUBLIC_RELEASE_POLICY.json",
      contractVersion: policy.contractVersion,
      sha256: sourceDigest(policyFile.raw),
    },
  ],
};

const serialized = `${JSON.stringify(truth, null, 2)}\n`;
if (published) {
  throw new Error("The protected release requires a reviewed attested-release adoption manifest; source-build instructions fail closed");
}
const packageManager = rootPackageFile.value.packageManager.split("@");
if (packageManager.length !== 2 || packageManager[0] !== "pnpm" || !packageManager[1]) {
  throw new Error("The public adoption manifest requires one exact pnpm packageManager version");
}
const adoption = {
  $schema: "/schemas/public-adoption.v1.schema.json",
  contractVersion: "tasq.public-adoption.v1",
  product: "Tasq Local",
  support: "implemented_candidate_not_published",
  distribution: {
    mode: "source_build",
    published: false,
    repository: policy.identity.canonicalRepository,
    repositoryAccess: privatePrelaunch ? "authorized_private_prelaunch" : "public",
    preconditions: privatePrelaunch ? ["authorized_repository_access"] : [],
    sourceRef: "main",
    sourceRefMutable: true,
    integrity: {
      kind: "repository-contract-digests",
      sourceContracts: truth.sourceContracts.map(({ path, sha256 }) => ({ path, sha256 })),
    },
  },
  requirements: [
    { runtime: "node", version: rootPackageFile.value.engines.node },
    { runtime: "bun", version: rootPackageFile.value.engines.bun },
    { runtime: "pnpm", version: packageManager[1] },
  ],
  human: {
    path: "/docs/getting-started/",
    primaryAction: privatePrelaunch ? "request_access_then_build" : "build_from_source",
  },
  agent: {
    acquisition: [
      {
        id: "source.clone",
        cwd: "{parentDirectory}",
        argv: ["git", "clone", policy.identity.canonicalRepository, "{checkoutPath}"],
        mutatesHost: true,
      },
      {
        id: "dependencies.install",
        cwd: "{checkoutPath}",
        argv: ["pnpm", "install", "--frozen-lockfile"],
        mutatesHost: true,
      },
      {
        id: "source.verify",
        cwd: "{checkoutPath}",
        argv: ["pnpm", "typecheck"],
        mutatesHost: false,
      },
      {
        id: "cli.build",
        cwd: "{checkoutPath}",
        argv: ["pnpm", "build:cli"],
        mutatesHost: true,
      },
    ],
    executableRelativePath: "dist/cli/index.js",
    onboardArgvTemplate: [
      "{tasqExecutable}", "onboard", "--space", "{workspaceId}", "--actor", "{actorLabel}",
      "--capabilities", "read,propose,coordinate", "--json",
    ],
    placeholders: ["{parentDirectory}", "{checkoutPath}", "{tasqExecutable}", "{workspaceId}", "{actorLabel}"],
  },
  invariants: [
    "execute_argv_without_shell_reconstruction",
    "persist_one_executable_identity_for_the_session",
    "read_before_mutation",
    "actor_labels_are_attribution_not_authentication",
    "same_workspace_requires_the_same_store",
    "device_time_is_not_authority",
    "runtime_success_does_not_complete_a_commitment",
    ...(privatePrelaunch ? ["private_prelaunch_repository_requires_authorized_access"] : []),
    "unpublished_source_ref_is_mutable_and_not_a_release_attestation",
  ],
};
const adoptionSerialized = `${JSON.stringify(adoption, null, 2)}\n`;

async function checkOutputs(paths: string[], expected: string): Promise<void> {
  for (const outputPath of paths) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== expected) {
      throw new Error("Generated public-site truth is stale; run `pnpm --filter @tasq-internal/site generate`");
    }
  }
}

if (process.argv.includes("--check")) {
  await checkOutputs(truthOutputPaths, serialized);
  await checkOutputs(adoptionOutputPaths, adoptionSerialized);
} else {
  await Promise.all([
    ...truthOutputPaths.map((outputPath) => writeFile(outputPath, serialized, "utf8")),
    ...adoptionOutputPaths.map((outputPath) => writeFile(outputPath, adoptionSerialized, "utf8")),
  ]);
}
