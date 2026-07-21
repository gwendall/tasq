import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Braces, Check, FileCheck2, LockKeyhole, PackageOpen, X } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { productTruth, titleWords, words } from "@/lib/product-truth";

export const metadata: Metadata = {
  title: "Product status",
  description: "Machine-derived Tasq product, surface, release and roadmap truth.",
};

export default function StatusPage() {
  return (
    <main id="main-content">
      <section className="border-b border-[var(--line-strong)] bg-[var(--paper-strong)]">
        <div className="site-container py-16 sm:py-24">
          <p className="eyebrow"><FileCheck2 className="size-3.5" /> Versioned product truth</p>
          <h1 className="mt-5 max-w-4xl text-5xl font-semibold leading-[0.95] tracking-[-0.065em] sm:text-7xl">No roadmap item gets to pretend it shipped.</h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-[var(--ink-muted)]">
            This page is generated from three repository contracts. Support, distribution and entrypoint claims cannot be edited here independently.
          </p>
        </div>
      </section>

      <section className="site-container section-space">
        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="border border-[var(--line-strong)] p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><p className="eyebrow">Release channel</p><h2 className="mt-3 text-3xl font-semibold tracking-[-0.045em]">Not published</h2></div>
              <StatusBadge support="implemented_candidate_not_published" />
            </div>
            <p className="mt-5 max-w-xl text-sm leading-6 text-[var(--ink-muted)]">
              The source repository, deterministic artifacts and lifecycle candidates exist. npm scope ownership and trusted publishing still require external registry authority.
            </p>
            <div className="mt-7 grid gap-px border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
              {Object.entries(productTruth.release.gates).map(([gate, passed]) => (
                <div className="flex items-center gap-2 bg-[var(--paper)] p-3 font-mono text-[0.68rem] uppercase tracking-[0.05em]" key={gate}>
                  {passed ? <Check className="size-3.5 text-[var(--ready)]" /> : <X className="size-3.5 text-[var(--blocked)]" />}
                  {words(gate)}
                </div>
              ))}
            </div>
          </div>
          <div className="border border-[var(--line-strong)] bg-[var(--ink)] p-6 text-[var(--paper)] sm:p-8">
            <PackageOpen className="size-7 text-[var(--signal)]" strokeWidth={1.5} />
            <p className="mt-8 font-mono text-[0.62rem] uppercase tracking-[0.12em] text-white/40">First release boundary</p>
            <p className="mt-3 text-2xl font-semibold tracking-[-0.035em]">{productTruth.release.publicPackages.length} public packages</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {productTruth.release.publicPackages.map((name) => <span className="border border-white/15 px-2 py-1 font-mono text-[0.68rem] text-white/60" key={name}>{name}</span>)}
            </div>
          </div>
        </div>

        <section className="mt-16">
          <div className="section-intro"><div><p className="eyebrow">Surfaces</p><h2>Every way in.<br />Every boundary visible.</h2></div><p>Agents consume machine contracts. Humans use CLI, projections and Console. Remote consumers have no supported path until Server exists.</p></div>
          <div className="mt-10 overflow-x-auto border border-[var(--line-strong)]">
            <table className="product-table">
              <thead><tr><th>Surface</th><th>Status</th><th>Transport</th><th>Entrypoint</th><th>Writes</th></tr></thead>
              <tbody>{productTruth.surfaces.map((surface) => (
                <tr key={surface.id}>
                  <td><strong>{titleWords(surface.id)}</strong></td>
                  <td><StatusBadge support={surface.support} /></td>
                  <td className="font-mono text-xs">{words(surface.transport)}</td>
                  <td className="max-w-sm font-mono text-xs text-[var(--ink-faint)]">{surface.entrypoint ?? "none"}</td>
                  <td>{surface.mutations ? "yes" : "no"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        <section className="mt-16">
          <div className="flex items-end justify-between gap-5 border-b border-[var(--line-strong)] pb-5"><div><p className="eyebrow">Repository contracts</p><h2 className="mt-3 text-3xl font-semibold tracking-[-0.045em]">Trace every displayed claim.</h2></div><LockKeyhole className="hidden size-7 text-[var(--ink-faint)] sm:block" /></div>
          <div className="divide-y divide-[var(--line)]">{productTruth.sourceContracts.map((source) => (
            <a href={`${productTruth.release.repository}/blob/main/${source.path}`} className="grid gap-2 py-4 text-sm hover:bg-[var(--paper-strong)] sm:grid-cols-[1fr_1fr_1.3fr] sm:px-3" key={source.path}>
              <strong>{source.path}</strong><span className="font-mono text-xs text-[var(--ink-faint)]">{source.contractVersion}</span><span className="truncate font-mono text-xs text-[var(--ink-faint)]">sha256:{source.sha256}</span>
            </a>
          ))}</div>
          <Button asChild variant="outline" size="sm" className="mt-5">
            <a href="/product-truth.json"><Braces className="size-3.5" /> Read the same truth as JSON</a>
          </Button>
          <Button asChild variant="outline" size="sm" className="mt-5 ml-2">
            <a href="/adopt.json"><Braces className="size-3.5" /> Agent adoption manifest</a>
          </Button>
        </section>

        <div className="mt-16 flex flex-col justify-between gap-5 border border-[var(--line-strong)] bg-[var(--signal-soft)] p-6 sm:flex-row sm:items-center">
          <div><p className="font-semibold">Need the reasoning behind these boundaries?</p><p className="mt-1 text-sm text-[var(--ink-muted)]">Read the product architecture before choosing an integration path.</p></div>
          <Button asChild variant="outline"><Link href="/docs/architecture">Read architecture <ArrowRight className="size-4" /></Link></Button>
        </div>
      </section>
    </main>
  );
}
