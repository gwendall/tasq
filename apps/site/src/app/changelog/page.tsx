import type { Metadata } from "next";
import { ArrowRight, ScrollText } from "lucide-react";

import { Button } from "@/components/ui/button";
import changelog from "@/generated/changelog.json";
import { productTruth } from "@/lib/product-truth";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every published Tasq release, generated from the repository's own CHANGELOG.md.",
};

export default function ChangelogPage() {
  const repository = productTruth.release.repository;

  return (
    <main id="main-content">
      <section className="border-b border-[var(--line-strong)] bg-[var(--paper-strong)]">
        <div className="site-container py-16 sm:py-20">
          <p className="eyebrow"><ScrollText className="size-3.5" /> Release history</p>
          <h1 className="mt-5 max-w-4xl text-[clamp(2.6rem,5.5vw,4.6rem)] font-semibold leading-[0.98] tracking-[-0.06em]">
            What changed, and when.
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-[var(--ink-muted)]">
            Generated from the repository&rsquo;s own <code className="font-mono text-base">CHANGELOG.md</code>. Each
            released entry links to its GitHub release, which carries the exact artifacts, checksums and attestations.
          </p>
        </div>
      </section>

      <section className="site-container section-space">
        <div className="flex flex-col gap-14">
          {changelog.map((release) => {
            const unreleased = release.date === null;
            return (
              <article key={release.version}>
                <div className="flex flex-wrap items-baseline gap-3 border-b border-[var(--line-strong)] pb-3">
                  <h2 className="text-2xl font-semibold tracking-[-0.04em]">{release.version}</h2>
                  {release.date ? (
                    <span className="font-mono text-xs text-[var(--ink-faint)]">{release.date}</span>
                  ) : (
                    <span className="border border-[var(--line-strong)] px-2 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.06em] text-[var(--ink-muted)]">
                      not released
                    </span>
                  )}
                </div>

                {unreleased ? (
                  <p className="mt-4 max-w-2xl text-sm leading-6 text-[var(--ink-muted)]">
                    Merged on the main branch and not part of any published package or download.
                  </p>
                ) : null}

                <div className="mt-6 flex flex-col gap-6">
                  {release.groups.map((group) => (
                    <div key={group.kind}>
                      <h3 className="font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
                        {group.kind}
                      </h3>
                      <ul className="mt-3 flex flex-col gap-2.5">
                        {group.items.map((item) => (
                          <li className="max-w-3xl border-l-2 border-[var(--line)] pl-4 text-sm leading-6" key={item}>
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>

                {release.date ? (
                  <div className="mt-6">
                    <Button asChild variant="outline" size="sm">
                      <a href={`${repository}/releases/tag/${release.version}`}>
                        Artifacts and attestations <ArrowRight className="size-3.5" />
                      </a>
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
