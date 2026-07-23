import Link from "next/link";

import { docPages } from "@/lib/docs";

const groups = [
  { label: "Learn", slugs: ["getting-started", "architecture"] },
  { label: "Use", slugs: ["agents", "mcp", "humans"] },
  { label: "Build & operate", slugs: ["sdk", "operators", "support"] },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main-content" className="site-container grid min-h-[calc(100vh-4rem)] grid-cols-[minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="min-w-0 border-b border-[var(--line)] py-7 lg:border-r lg:border-b-0 lg:pr-7">
        <nav aria-label="Documentation" className="sticky top-24 grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-1">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="mb-2 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-[var(--ink-faint)]">{group.label}</p>
              <div className="grid gap-0.5">
                {group.slugs.map((slug) => {
                  const page = docPages.find((entry) => entry.slug === slug);
                  if (!page) return null;
                  return <Link className="docs-nav-link" href={`/docs/${slug}`} key={slug}>{page.title.split(".")[0]}</Link>;
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">{children}</div>
    </main>
  );
}
