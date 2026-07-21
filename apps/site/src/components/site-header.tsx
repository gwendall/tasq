import Link from "next/link";
import { GitBranch } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { productTruth } from "@/lib/product-truth";

const nav = [
  { href: "/docs/getting-started", label: "Docs" },
  { href: "/docs/architecture", label: "Concepts" },
  { href: "/status", label: "Status" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[color-mix(in_srgb,var(--paper)_92%,transparent)] backdrop-blur-md">
      <div className="site-container flex h-16 items-center justify-between gap-5">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 font-semibold tracking-[-0.04em]" aria-label="Tasq home">
          <BrandMark />
          <span className="text-lg">tasq</span>
          <span className="hidden border-l border-[var(--line)] pl-2.5 font-mono text-[0.62rem] font-medium uppercase tracking-[0.12em] text-[var(--ink-faint)] sm:inline">
            local first
          </span>
        </Link>
        <nav aria-label="Primary navigation" className="flex items-center gap-0 sm:gap-1">
          {nav.map((item) => (
            <Button asChild key={item.href} variant="ghost" size="sm">
              <Link href={item.href}>{item.label}</Link>
            </Button>
          ))}
          <Button asChild variant="outline" size="sm" className="ml-1 hidden sm:inline-flex">
            <a href={productTruth.release.repository} rel="noreferrer">
              <GitBranch aria-hidden="true" className="size-3.5" />
              GitHub
            </a>
          </Button>
        </nav>
      </div>
    </header>
  );
}
