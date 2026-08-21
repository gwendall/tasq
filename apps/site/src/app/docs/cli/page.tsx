import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, TerminalSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import cliReference from "@/generated/cli-reference.json";
import { productTruth } from "@/lib/product-truth";

export const metadata: Metadata = {
  title: "CLI reference",
  description:
    "Every Tasq command, generated from the shipped binary's own help so the page cannot drift from the tool.",
};

const serverPublished = productTruth.productShapes.find(({ id }) => id === "server")?.publiclyDistributed === true;
const UNSHIPPED_SECTIONS = serverPublished ? new Set<string>() : new Set(["REMOTE SERVER"]);

export default function CliReferencePage() {
  const version = productTruth.release.version;

  return (
    <main id="main-content">
      <section className="border-b border-[var(--line-strong)] bg-[var(--paper-strong)]">
        <div className="site-container py-16 sm:py-20">
          <p className="eyebrow"><TerminalSquare className="size-3.5" /> Reference</p>
          <h1 className="mt-5 max-w-4xl text-[clamp(2.6rem,5.5vw,4.6rem)] font-semibold leading-[0.98] tracking-[-0.06em]">
            Every command, straight from the binary.
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-[var(--ink-muted)]">
            Generated from the CLI&rsquo;s own help output{version ? ` in ${version}` : ""}. If a flag changes and this
            page does not, the build fails.
          </p>
          <div className="mt-8">
            <Button asChild variant="outline" size="sm">
              <Link href="/docs/getting-started">Start here instead <ArrowRight className="size-3.5" /></Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="site-container section-space">
        <nav aria-label="Command groups" className="mb-12 flex flex-wrap gap-2">
          {cliReference.map((section) => (
            <a
              className="border border-[var(--line-strong)] px-3 py-1.5 font-mono text-[0.6875rem] uppercase tracking-[0.06em] hover:bg-[var(--signal-soft)]"
              href={`#${slugify(section.heading)}`}
              key={section.heading}
            >
              {section.heading}
            </a>
          ))}
        </nav>

        <div className="flex flex-col gap-14">
          {cliReference.map((section) => (
            <section id={slugify(section.heading)} key={section.heading}>
              <div className="flex flex-wrap items-baseline gap-3 border-b border-[var(--line-strong)] pb-3">
                <h2 className="text-2xl font-semibold tracking-[-0.04em]">{section.heading}</h2>
                {UNSHIPPED_SECTIONS.has(section.heading) ? (
                  <span className="border border-[var(--blocked-line)] bg-[var(--blocked-soft)] px-2 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.06em] text-[var(--blocked)]">
                    present in the binary, product not shipped
                  </span>
                ) : null}
              </div>
              <dl className="divide-y divide-[var(--line)]">
                {section.entries.map((entry) => (
                  <div className="grid gap-1 py-4 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] sm:gap-6" key={entry.usage}>
                    <dt className="min-w-0 overflow-x-auto font-mono text-[0.8125rem] leading-6">
                      <code className="whitespace-pre">{entry.usage}</code>
                    </dt>
                    <dd className="text-sm leading-6 text-[var(--ink-muted)]">{entry.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <div className="mt-16 border-l-2 border-[var(--signal)] bg-[var(--signal-soft)] p-6 text-sm leading-6">
          Agents should not read this page. Run{" "}
          <code className="font-mono">tasq onboard --space &lt;id&gt; --actor &lt;label&gt; --json</code> and execute the
          returned recipes, which are versioned by the binary you actually have.
        </div>
      </section>
    </main>
  );
}

function slugify(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
