import {
  CONNECTOR_CONFORMANCE_PROTOCOL,
  defineConnectorConformanceProfile,
  type ConnectorConformanceProfile,
  type NormalizedConnectorObservation,
} from "@tasq-run/extension-sdk";
import { canonicalizeEffectJson } from "@tasq-run/schema";
import {
  REFERENCE_CONNECTOR_VERSION,
  WORK_ITEM_OBSERVATION_TYPE_URI,
  WORK_ITEM_READ_CONNECTOR_URI,
  WORK_ITEM_SCHEMA_VERSION,
  sha256,
} from "./constants.js";
import type { WorkItemProviderClient } from "./provider.js";

export interface ReferenceWorkItemReadConnectorOptions {
  instanceRef: string;
  bindingDigest: string;
  providerIssuerUri: string;
  providerAccountRef: string;
  providerAudience: string;
  client: WorkItemProviderClient;
}

export interface ReferenceWorkItemReadConnector {
  readonly profile: Readonly<ConnectorConformanceProfile>;
  observe(input: { projectRef: string; itemRef: string }): Promise<NormalizedConnectorObservation>;
}

/** A complete read connector: provider I/O in, bounded normalized fact out. */
export function createReferenceWorkItemReadConnector(
  options: ReferenceWorkItemReadConnectorOptions,
): ReferenceWorkItemReadConnector {
  const providerOrigin = new URL(options.providerIssuerUri).origin;
  const profile = defineConnectorConformanceProfile({
    protocol: CONNECTOR_CONFORMANCE_PROTOCOL,
    connectorUri: WORK_ITEM_READ_CONNECTOR_URI,
    connectorVersion: REFERENCE_CONNECTOR_VERSION,
    instanceRef: options.instanceRef,
    bindingDigest: options.bindingDigest,
    provider: {
      issuerUri: options.providerIssuerUri,
      accountRef: options.providerAccountRef,
      audience: options.providerAudience,
    },
    clock: "injected",
    credentials: "secret_refs_only",
    redirects: "forbid_credential_forwarding",
    observations: {
      deliveryIdentity: "source_external_event_id",
      exactReplay: "return_original",
      conflictingReplay: "reject",
      sourceTime: "provenance_only",
      secretMinimized: true,
      digestBoundRawReference: true,
    },
    effects: [],
  });

  const connector: ReferenceWorkItemReadConnector = {
    profile,
    async observe(input: { projectRef: string; itemRef: string }) {
      const snapshot = await options.client.readWorkItem(input);
      if (snapshot.accountRef !== options.providerAccountRef ||
        snapshot.projectRef !== input.projectRef || snapshot.itemRef !== input.itemRef) {
        throw new Error("Provider work item does not match the connector request binding");
      }
      const recordRef = new URL(snapshot.recordRef);
      if (recordRef.protocol !== "https:" || recordRef.origin !== providerOrigin ||
        recordRef.username || recordRef.password) {
        throw new Error("Provider work item raw reference escaped the pinned provider origin");
      }
      const payload = {
        providerAccountRef: snapshot.accountRef,
        projectRef: snapshot.projectRef,
        itemRef: snapshot.itemRef,
        version: snapshot.version,
        state: snapshot.state,
        titleDigest: sha256(snapshot.title),
      };
      const deliveryIdentity = sha256(canonicalizeEffectJson({
        providerAccountRef: snapshot.accountRef,
        projectRef: snapshot.projectRef,
        itemRef: snapshot.itemRef,
        version: snapshot.version,
      }));
      const rawDigest = sha256(canonicalizeEffectJson(snapshot));
      const observation: NormalizedConnectorObservation = {
        source: `reference-work-items:${options.providerAccountRef}`,
        externalEventId: `work-item-snapshot:${deliveryIdentity}`,
        typeUri: WORK_ITEM_OBSERVATION_TYPE_URI,
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        payload,
        occurredAt: snapshot.updatedAt,
        verificationLevel: "authenticated_source",
        verificationMethod: "pinned-origin-bearer-session",
        rawRef: recordRef.href,
        digest: rawDigest,
        metadata: {
          connectorContract: "tasq.reference-work-item-read.v1",
          connectorInstanceRef: options.instanceRef,
        },
      };
      return observation;
    },
  };
  return Object.freeze(connector);
}
