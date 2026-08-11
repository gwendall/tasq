export const CUSTODY_DESIGN_DECISION = Object.freeze({
  contractVersion: "tasq.custody-design-decision.v1" as const,
  alternatives: {
    resourceLease: {
      decision: "reject_as_custody_model" as const,
      reason: "A lease coordinates temporary use and expires; it cannot preserve bilateral possession transfer or incident lineage.",
    },
    signedObservation: {
      decision: "compose_as_evidence_only" as const,
      reason: "A signature authenticates an assertion, but two contradictory signed assertions can both exist without electing one successor.",
    },
    firstClassHandoff: {
      decision: "graduate_as_shared_experimental_module" as const,
      reason: "Exclusive successor election, bilateral offer/accept/refuse, exact condition evidence and incidents require one transactional lifecycle.",
    },
  },
  kernelAdmission: {
    decision: "not_requested" as const,
    reason: "Cross-domain source evidence supports a private Shared Module; replication, remote authority and wider product evidence remain before Kernel admission.",
  },
  assurance: {
    provesPhysicalPossession: false as const,
    grantsOwnership: false as const,
    grantsEffectAuthority: false as const,
  },
});
