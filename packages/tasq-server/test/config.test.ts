import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TasqServerBootstrap,
  TasqServerConfig,
} from "../src/index.js";

const deployment = join(import.meta.dir, "../../../deploy/server");

describe("Tasq Server operator contracts", () => {
  test("keeps checked-in config and bootstrap examples executable", async () => {
    expect(TasqServerConfig.parse(JSON.parse(
      await readFile(join(deployment, "server.example.json"), "utf8"),
    ))).toMatchObject({
      contractVersion: "tasq.server-config.v1",
      listen: { trustTlsProxy: true },
      jwt: { scopeActions: { "tasq:coordinate": "coordinator" } },
    });
    expect(TasqServerBootstrap.parse(JSON.parse(
      await readFile(join(deployment, "bootstrap.example.json"), "utf8"),
    ))).toMatchObject({
      contractVersion: "tasq.server-bootstrap.v1",
      hostTenantId: "self-host",
    });
  });

  test("pins deployment base images and publishes bounded OCI identity", async () => {
    const dockerfile = await readFile(join(deployment, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(
      /^FROM oven\/bun:1\.3\.11-alpine@sha256:[0-9a-f]{64}$/m,
    );
    for (const label of [
      "org.opencontainers.image.source",
      "org.opencontainers.image.licenses",
      "org.opencontainers.image.version",
      "org.opencontainers.image.revision",
    ]) {
      expect(dockerfile).toContain(label);
    }
    const compose = await readFile(join(deployment, "compose.yaml"), "utf8");
    expect(compose).toMatch(
      /image: caddy:2\.10\.2-alpine@sha256:[0-9a-f]{64}/,
    );
    const dockerignore = await readFile(join(deployment, "../../.dockerignore"), "utf8");
    expect(dockerignore).toContain("**/playwright-report");
    expect(dockerignore).toContain("**/test-results");
  });

  test("fails closed on unsafe listeners, audience drift, path origins and database aliasing", async () => {
    const base = JSON.parse(await readFile(join(deployment, "server.example.json"), "utf8"));
    for (const changed of [
      { ...base, listen: { ...base.listen, trustTlsProxy: false } },
      { ...base, publicUrl: "https://tasks.example.com/prefix/" },
      { ...base, jwt: { ...base.jwt, audience: "https://other.example.com/" } },
      {
        ...base,
        workspaces: [{
          ...base.workspaces[0],
          receiptDatabaseUrl: base.workspaces[0].databaseUrl,
        }],
      },
    ]) {
      expect(TasqServerConfig.safeParse(changed).success).toBe(false);
    }
  });
});
