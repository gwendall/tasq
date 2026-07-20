/** Language-neutral contracts for zero-integrator local onboarding. */

import { z } from "zod";
import { DiscoveryDocument } from "./discovery.js";

const UnixMs = z.number().int().nonnegative();

/**
 * Deliberately shell-safe and transport-neutral. Spaces are explicit names,
 * never guessed from a directory, repository, HOME or device identity.
 */
export const CoordinationSpaceId = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, {
    message: "space must start with an alphanumeric character and contain only A-Z, a-z, 0-9, '.', '_', ':', '/' or '-'",
  });
export type CoordinationSpaceId = z.infer<typeof CoordinationSpaceId>;

/** Self-asserted attribution label; exact bytes are identity-significant. */
export const BootstrapActorAlias = z.string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, "actor must not have leading or trailing whitespace")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "actor must not contain control characters");
export type BootstrapActorAlias = z.infer<typeof BootstrapActorAlias>;

export const CoordinationSpace = z.object({
  workspaceId: CoordinationSpaceId,
  createdByPrincipalId: z.string().min(1).max(2_000),
  createdAt: UnixMs,
}).strict();
export type CoordinationSpace = z.infer<typeof CoordinationSpace>;

export const BOOTSTRAP_RECIPE_CAPABILITIES = ["read", "propose", "coordinate"] as const;
export const BootstrapRecipeCapability = z.enum(BOOTSTRAP_RECIPE_CAPABILITIES);
export type BootstrapRecipeCapability = z.infer<typeof BootstrapRecipeCapability>;

export const BootstrapRecipeParameter = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/).max(100),
  placeholder: z.string().regex(/^\{[a-z][a-zA-Z0-9]*\}$/).max(102),
  description: z.string().min(1).max(1_000),
  required: z.boolean(),
}).strict();
export type BootstrapRecipeParameter = z.infer<typeof BootstrapRecipeParameter>;

export const BootstrapRecipe = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(200),
  version: z.literal(1),
  description: z.string().min(1).max(1_000),
  requiredCapability: BootstrapRecipeCapability,
  mutates: z.boolean(),
  argvTemplate: z.array(z.string().min(1).max(2_000)).min(2).max(64),
  parameters: z.array(BootstrapRecipeParameter).max(32),
  outputContract: z.string().min(1).max(500),
}).strict().superRefine((recipe, context) => {
  const declared = new Set(recipe.parameters.map((parameter) => parameter.placeholder));
  const used = new Set(recipe.argvTemplate.filter((part) => /^\{[a-z][a-zA-Z0-9]*\}$/.test(part)));
  if (declared.size !== recipe.parameters.length ||
      declared.size !== used.size || [...declared].some((placeholder) => !used.has(placeholder))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "recipe parameters and argv placeholders must be a one-to-one set",
    });
  }
});
export type BootstrapRecipe = z.infer<typeof BootstrapRecipe>;

export const BootstrapJourney = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/).max(200),
  intent: z.string().min(1).max(1_000),
  recipeIds: z.array(z.string().regex(/^[a-z][a-z0-9.-]*$/).max(200)).min(1).max(16),
  invariants: z.array(z.string().min(1).max(1_000)).min(1).max(12),
}).strict();
export type BootstrapJourney = z.infer<typeof BootstrapJourney>;

export const BootstrapGuide = z.object({
  contractVersion: z.literal("tasq.bootstrap-guide.v1"),
  execution: z.object({
    argvPolicy: z.literal("returned_vector_or_frozen_trusted_pointer"),
    pointerBindingPolicy: z.literal("host_must_resolve_same_artifact_for_entire_session"),
    argv0Invocation: z.literal("direct_executable_even_with_js_suffix"),
    runtimeWrapperPolicy: z.literal("forbidden"),
    placeholderPolicy: z.literal("replace_declared_placeholders_only"),
    resultPolicy: z.literal("preserve_exit_status_and_complete_json"),
    shellConcatenation: z.literal(false),
  }).strict(),
  firstReadRecipeId: z.literal("context.read").nullable(),
  journeys: z.array(BootstrapJourney).min(1).max(12),
}).strict();
export type BootstrapGuide = z.infer<typeof BootstrapGuide>;

export const AUTONOMOUS_BOOTSTRAP_CONTRACT_VERSION = "tasq.autonomous-bootstrap.v1" as const;
export const AutonomousBootstrap = z.object({
  contractVersion: z.literal(AUTONOMOUS_BOOTSTRAP_CONTRACT_VERSION),
  disposition: z.enum(["created", "joined"]),
  space: CoordinationSpace,
  actor: z.object({
    alias: BootstrapActorAlias,
    principalId: z.string().min(1).max(2_000),
    authentication: z.literal("local_process_self_asserted"),
  }).strict(),
  transportBoundary: z.literal("local_process"),
  authority: z.object({
    capabilityEnforcement: z.literal("none"),
    effectAuthority: z.literal("not_granted"),
    explanation: z.string().min(1).max(2_000),
  }).strict(),
  recipeCapabilities: z.array(BootstrapRecipeCapability).min(1).max(3),
  guide: BootstrapGuide,
  discovery: DiscoveryDocument,
  recipes: z.array(BootstrapRecipe).min(1).max(100),
  warnings: z.array(z.string().min(1).max(2_000)).min(1).max(16),
}).strict().superRefine((value, context) => {
  const selected = new Set(value.recipeCapabilities);
  if (selected.size !== value.recipeCapabilities.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipeCapabilities"], message: "capabilities must be unique" });
  }
  if (value.recipes.some((recipe) => !selected.has(recipe.requiredCapability))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipes"], message: "recipe exceeds selected capability groups" });
  }
  const recipeIds = new Set(value.recipes.map((recipe) => recipe.id));
  if (recipeIds.size !== value.recipes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["recipes"], message: "recipe ids must be unique" });
  }
  for (const [index, journey] of value.guide.journeys.entries()) {
    if (new Set(journey.recipeIds).size !== journey.recipeIds.length ||
        journey.recipeIds.some((recipeId) => !recipeIds.has(recipeId))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["guide", "journeys", index, "recipeIds"],
        message: "journey steps must be unique recipes advertised by this response",
      });
    }
  }
  if (value.guide.firstReadRecipeId !== null && !recipeIds.has(value.guide.firstReadRecipeId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["guide", "firstReadRecipeId"],
      message: "first read recipe must be advertised by this response",
    });
  }
  if (value.discovery.workspaceId !== value.space.workspaceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["discovery", "workspaceId"], message: "discovery and space must match" });
  }
});
export type AutonomousBootstrap = z.infer<typeof AutonomousBootstrap>;

export const AUTONOMOUS_BOOTSTRAP_PROBLEM_CONTRACT_VERSION = "tasq.autonomous-bootstrap-problem.v1" as const;
export const AutonomousBootstrapProblem = z.object({
  contractVersion: z.literal(AUTONOMOUS_BOOTSTRAP_PROBLEM_CONTRACT_VERSION),
  status: z.literal("error"),
  code: z.enum(["invalid_input", "config_error", "storage_error", "unavailable"]),
  message: z.string().min(1).max(2_000),
  retryable: z.boolean(),
  nextActions: z.array(z.object({
    description: z.string().min(1).max(1_000),
    argv: z.array(z.string().min(1).max(2_000)).min(2).max(32),
  }).strict()).max(8),
}).strict();
export type AutonomousBootstrapProblem = z.infer<typeof AutonomousBootstrapProblem>;
