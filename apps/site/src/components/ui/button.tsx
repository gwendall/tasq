import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "ui-button inline-flex min-h-11 items-center justify-center gap-2 border px-4 text-sm font-semibold tracking-[-0.01em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border-[var(--ink)] bg-[var(--ink)] text-[var(--paper)] shadow-[3px_3px_0_var(--signal)] hover:shadow-[3px_6px_0_var(--signal)] active:shadow-[3px_2px_0_var(--signal)]",
        outline:
          "border-[var(--line-strong)] bg-transparent text-[var(--ink)] shadow-[3px_3px_0_transparent] hover:border-[var(--ink)] hover:shadow-[3px_6px_0_var(--line-strong)] active:shadow-[3px_2px_0_var(--line-strong)]",
        ghost:
          "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink)]",
      },
      size: {
        default: "h-11",
        sm: "h-9 min-h-9 px-3 text-xs",
        lg: "h-12 px-5 text-base",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      className={cn(buttonVariants({ variant, size, className }))}
      data-variant={variant ?? "default"}
      {...props}
    />
  );
}

export { Button, buttonVariants };
