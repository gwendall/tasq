# ADR-018 — Fly for the first hosted private beta

> **Status:** accepted for the first hosted Server beta; exact-image deployment gate open
> **Date:** 2026-08-11

## Decision

Run the first hosted Tasq Server beta on Fly.io, in `cdg`, as one Machine with
one encrypted local volume. Keep `api.tasq.run` as the canonical Server origin,
keep `tasq.run` on Vercel, and make `cloud.tasq.run` a human-friendly redirect
to `https://api.tasq.run/console`.

This replaces the earlier recommendation to begin with GKE. It does not select
Fly as the permanent Managed Cloud platform and does not change the
provider-neutral `CloudProvisioner` interface.

## First-principles basis

The first beta needs to answer whether people and agents obtain value from a
hosted, authenticated coordination ledger. It does not yet need to answer how
to operate thousands of tenants across regions.

The current executable constraints are:

1. Server accepts only absolute local `file:` SQLite URLs.
2. SQLite WAL requires one local writer and is not a network-filesystem design.
3. The Server image already contains REST, remote MCP, enrollment, Console,
   health, backup, restore and upgrade behavior.
4. TQ-901's control plane is a provider-neutral source library, not a runnable
   public service.

Fly Machines plus one local encrypted volume satisfy those constraints with
the smallest operational surface. GKE adds a cluster, ingress, workload
identity, persistent-volume policy and a much larger monthly floor before the
product-value hypothesis is tested.

## Invariants

- one active writer Machine;
- one canonical HTTPS origin and credential audience;
- exact protected GHCR image by digest, never source build or mutable tag;
- immediate replacement deployment, never overlapping writers;
- explicit fixed non-root UID/GID for volume ownership;
- Fly configuration remains outside Core and the provider-neutral Cloud
  interfaces;
- native Tasq backups must leave the volume; provider snapshots alone are not
  sufficient;
- remote effects remain disabled.

## Exit triggers

Revisit Fly and the single-machine design when any one is true:

- contracted availability or recovery objectives exceed what one regional
  volume plus off-site restore can meet;
- multi-tenant isolation requires independent deployment lifecycles at scale;
- the control plane needs multiple concurrent writers;
- regional data-residency or enterprise networking requirements demand a
  larger provider stack;
- measured load exceeds the single-writer envelope.

At that point GKE, Railway, a managed PostgreSQL control plane or another
provider can be evaluated against measured requirements. No migration is
authorized merely because a more elaborate platform exists.

## Current gate

The Fly app, volume, ingress, DNS and CI environment can be provisioned before
runtime deployment. The endpoint remains non-live until the protected v0.4.0
multi-architecture Server image exists and the digest-bound deployment
workflow proves health, readiness, version and Console routes.
