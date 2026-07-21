import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";
import { productTruth } from "@/lib/product-truth";

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--line-strong)] bg-[var(--ink)] text-[var(--paper)]">
      <div className="site-container grid gap-10 py-10 md:grid-cols-[1.5fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5 text-lg font-semibold tracking-[-0.04em]">
            <BrandMark className="[--paper:var(--ink)]" /> tasq
          </div>
          <p className="mt-4 max-w-sm text-sm leading-6 text-white/60">
            Durable coordination truth for humans, agents and the runtimes around them.
          </p>
        </div>
        <div className="footer-links">
          <p>Explore</p>
          <Link href="/docs/getting-started">Getting started</Link>
          <Link href="/docs/agents">Agent guide</Link>
          <Link href="/status">Product status</Link>
        </div>
        <div className="footer-links">
          <p>Project</p>
          <a href={productTruth.release.repository}>Source</a>
          <a href={`${productTruth.release.repository}/blob/main/SECURITY.md`}>Security</a>
          <a href={`${productTruth.release.repository}/blob/main/CONTRIBUTING.md`}>Contribute</a>
        </div>
      </div>
      <div className="site-container flex flex-col gap-2 border-t border-white/15 py-4 font-mono text-[0.65rem] uppercase tracking-[0.08em] text-white/45 sm:flex-row sm:items-center sm:justify-between">
        <span>{productTruth.release.license} · {productTruth.release.contributionTerms}</span>
        <span>Truth snapshot · {productTruth.sourceUpdatedAt}</span>
      </div>
    </footer>
  );
}
