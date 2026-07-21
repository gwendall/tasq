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
  };
  legal: { license: string; contributionTerms: string };
  packages: Array<{ publicName: string | null; firstRelease: boolean }>;
  candidateCliTargets: string[];
  externalPublicationGateStatus: Record<string, boolean>;
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../../..");
const outputPaths = [
  resolve(repoRoot, "apps/site/src/generated/product-truth.json"),
  resolve(repoRoot, "apps/site/public/product-truth.json"),
];

async function readJson<T>(relativePath: string): Promise<{ raw: string; value: T }> {
  const raw = await readFile(resolve(repoRoot, relativePath), "utf8");
  return { raw, value: JSON.parse(raw) as T };
}

const [matrixFile, backlogFile, policyFile] = await Promise.all([
  readJson<ProductMatrix>("PRODUCT_SURFACE_MATRIX.json"),
  readJson<Backlog>("BACKLOG.json"),
  readJson<ReleasePolicy>("PUBLIC_RELEASE_POLICY.json"),
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
    installAction: published ? "install_release" : "build_from_source",
    repository: policy.identity.canonicalRepository,
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
if (process.argv.includes("--check")) {
  for (const outputPath of outputPaths) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== serialized) {
      throw new Error("Generated public-site truth is stale; run `pnpm --filter @tasq-internal/site generate`");
    }
  }
} else {
  await Promise.all(outputPaths.map((outputPath) => writeFile(outputPath, serialized, "utf8")));
}
