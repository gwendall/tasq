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
