import truth from "@/generated/product-truth.json";

export type SupportTone = "ready" | "local" | "future" | "blocked" | "neutral";

export const productTruth = truth;

export const supportPresentation: Record<string, { label: string; tone: SupportTone }> = {
  implemented_certified: { label: "Certified", tone: "ready" },
  implemented_candidate_not_published: { label: "Candidate", tone: "blocked" },
  implemented_local_only: { label: "Local only", tone: "local" },
  implemented_integration_required: { label: "Integration", tone: "local" },
  reference_only: { label: "Reference", tone: "neutral" },
  accepted_design_not_executed: { label: "Designed", tone: "future" },
  not_implemented: { label: "Not built", tone: "future" },
  impossible_without_transport: { label: "Needs transport", tone: "future" },
};

export function words(value: string): string {
  return value.replaceAll("_", " ");
}

export function titleWords(value: string): string {
  return words(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}
