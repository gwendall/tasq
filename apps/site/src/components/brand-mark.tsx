import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-7", className)}
      viewBox="0 0 28 28"
      fill="none"
    >
      <path d="M6 6L14 14M22 6L14 14M6 22L14 14M22 22L14 14" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1.5" y="1.5" width="8" height="8" fill="var(--paper)" stroke="currentColor" strokeWidth="1.5" />
      <rect x="18.5" y="1.5" width="8" height="8" fill="var(--signal)" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1.5" y="18.5" width="8" height="8" fill="var(--paper)" stroke="currentColor" strokeWidth="1.5" />
      <rect x="18.5" y="18.5" width="8" height="8" fill="var(--paper)" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="10" width="8" height="8" fill="var(--ink)" />
    </svg>
  );
}
