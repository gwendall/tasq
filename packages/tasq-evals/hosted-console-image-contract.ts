export interface TasqServerImageInspection {
  Id: string;
  RepoDigests: string[] | null;
  Architecture: string;
  Os: string;
  Config: { Labels?: Record<string, string> };
}

export interface TasqServerOciIdentity {
  title: "Tasq Server";
  source: "https://github.com/gwendall/tasq";
  license: "Apache-2.0";
  version: string;
  revision: string;
}

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function requireExplicitServerImage(value: string | undefined): string {
  if (!value) throw new Error("--image is required; implicit or default Server images are forbidden");
  if (value !== value.trim() || value.length > 500 || /\s/.test(value)) {
    throw new Error("--image must be one bounded explicit OCI reference");
  }
  const digestReference = /@sha256:[a-f0-9]{64}$/.test(value);
  const finalSegment = value.slice(value.lastIndexOf("/") + 1);
  const tag = finalSegment.includes(":") ? finalSegment.slice(finalSegment.lastIndexOf(":") + 1) : null;
  if (!digestReference && (!tag || tag === "latest" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))) {
    throw new Error("--image must use an explicit non-latest tag or sha256 digest");
  }
  return value;
}

export function requireTasqServerOciIdentity(
  inspection: TasqServerImageInspection,
): TasqServerOciIdentity {
  if (!/^sha256:[a-f0-9]{64}$/.test(inspection.Id)) {
    throw new Error("Server image inspection returned no immutable image ID");
  }
  if (!inspection.Os || !inspection.Architecture) {
    throw new Error("Server image inspection returned no platform identity");
  }
  const labels = inspection.Config.Labels ?? {};
  if (labels["org.opencontainers.image.title"] !== "Tasq Server") {
    throw new Error("Server image is missing the Tasq OCI title label");
  }
  if (labels["org.opencontainers.image.source"] !== "https://github.com/gwendall/tasq") {
    throw new Error("Server image is missing the canonical OCI source label");
  }
  if (labels["org.opencontainers.image.licenses"] !== "Apache-2.0") {
    throw new Error("Server image is missing the Apache-2.0 OCI license label");
  }
  const version = labels["org.opencontainers.image.version"];
  if (!version || !semver.test(version) || version === "0.0.0-source") {
    throw new Error("Server image is missing an explicit SemVer OCI version label");
  }
  const revision = labels["org.opencontainers.image.revision"];
  if (!revision || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("Server image is missing an exact source-commit OCI revision label");
  }
  return {
    title: "Tasq Server",
    source: "https://github.com/gwendall/tasq",
    license: "Apache-2.0",
    version,
    revision,
  };
}

export function resolvesRequestedPublishedDigest(
  requestedImage: string,
  inspection: TasqServerImageInspection,
): boolean {
  return /@sha256:[a-f0-9]{64}$/.test(requestedImage)
    && (inspection.RepoDigests ?? []).includes(requestedImage);
}

export function sensitiveCommandFailure(
  exitCode: number,
  _stdout: string,
  _stderr: string,
): string {
  return `sensitive command failed (${exitCode}): [redacted sensitive command output]`;
}
