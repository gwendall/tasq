import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 border px-2 py-1 font-mono text-[0.6875rem] font-semibold uppercase leading-none tracking-[0.08em]",
  {
    variants: {
      tone: {
        ready: "border-[var(--ready-line)] bg-[var(--ready-soft)] text-[var(--ready)]",
        local: "border-[var(--local-line)] bg-[var(--local-soft)] text-[var(--local)]",
        future: "border-[var(--line)] bg-[var(--paper-strong)] text-[var(--ink-muted)]",
        blocked: "border-[var(--blocked-line)] bg-[var(--blocked-soft)] text-[var(--blocked)]",
        neutral: "border-[var(--line)] bg-transparent text-[var(--ink-muted)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
