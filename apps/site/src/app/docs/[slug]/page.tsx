import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, Info } from "lucide-react";

import { CodeWindow } from "@/components/code-window";
import { Button } from "@/components/ui/button";
import { docPages, getDocPage } from "@/lib/docs";

export const dynamicParams = false;

export function generateStaticParams() {
  return docPages.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = getDocPage(slug);
  if (!page) return {};
  return { title: page.title, description: page.summary };
}

export default async function DocRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = getDocPage(slug);
  if (!page) notFound();
  const index = docPages.findIndex((entry) => entry.slug === slug);
  const previous = docPages[index - 1];
  const next = docPages[index + 1];

  return (
    <article className="docs-article mx-auto max-w-4xl px-0 py-12 lg:px-14 lg:py-16">
      <header className="border-b border-[var(--line-strong)] pb-10">
        <p className="eyebrow">{page.eyebrow}</p>
        <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.02] tracking-[-0.055em] sm:text-6xl">{page.title}</h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--ink-muted)]">{page.summary}</p>
      </header>

      <div className="divide-y divide-[var(--line)]">
        {page.sections.map((section) => (
          <section className="py-10" key={section.title}>
            <h2>{section.title}</h2>
            {section.body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {section.bullets ? (
              <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
            ) : null}
            {section.code ? <div className="mt-6"><CodeWindow title="example">{section.code}</CodeWindow></div> : null}
            {section.callout ? (
              <div className="docs-callout"><Info aria-hidden="true" /><p>{section.callout}</p></div>
            ) : null}
          </section>
        ))}
      </div>

      <nav aria-label="Documentation pagination" className="grid gap-3 border-t border-[var(--line-strong)] pt-8 sm:grid-cols-2">
        {previous ? (
          <Button asChild variant="outline" className="h-auto items-start justify-start px-4 py-3 text-left">
            <Link href={`/docs/${previous.slug}`}><ArrowLeft className="mt-0.5 size-4" /><span><small>Previous</small>{previous.eyebrow}</span></Link>
          </Button>
        ) : <span />}
        {next ? (
          <Button asChild variant="outline" className="h-auto items-start justify-end px-4 py-3 text-right">
            <Link href={`/docs/${next.slug}`}><span><small>Next</small>{next.eyebrow}</span><ArrowRight className="mt-0.5 size-4" /></Link>
          </Button>
        ) : null}
      </nav>
    </article>
  );
}
