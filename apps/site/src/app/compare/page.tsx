import type { Metadata } from "next";
import { ArrowUpRight, Boxes, GitBranch, ListChecks, Network, ShieldCheck } from "lucide-react";

import comparison from "../../../../../docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json";

export const metadata: Metadata = {
  title: "Compare multi-agent coordination",
  description:
    "A sourced comparison of Tasq, Claude Code, GitHub Copilot, Codex, Cursor, MCP and A2A when several agents work the same backlog.",
};

const categories = [
  {
    icon: GitBranch,
    title: "Execution isolation",
    body: "Worktrees, branches and VMs stop agents sharing one checkout. They do not decide who owns one backlog commitment.",
  },
  {
    icon: Network,
    title: "Vendor orchestration",
    body: "A lead can split work among its own subagents. The coordination state normally belongs to that parent workflow.",
  },
  {
    icon: ListChecks,
    title: "Durable coordination",
    body: "Independent runtimes need a shared claim, attempt, evidence and decision history that survives any one session.",
  },
] as const;

const sourceById = new Map(comparison.sources.map((source) => [source.id, source]));

export default function ComparePage() {
  return (
    <main id="main-content">
      <section className="border-b border-[var(--line-strong)] bg-[var(--ink)] text-[var(--paper)]">
        <div className="site-container py-16 sm:py-24">
          <p className="eyebrow text-white/45"><Boxes className="size-3.5" /> Multi-agent comparison · checked {comparison.checkedAt}</p>
          <h1 className="mt-6 max-w-5xl text-[clamp(3.2rem,7vw,6.4rem)] font-semibold leading-[0.91] tracking-[-0.07em]">
            Parallel is not the same as coordinated.
          </h1>
          <p className="mt-8 max-w-3xl text-lg leading-8 text-white/60">
            Several products can run agents at once. The useful question is what happens when those agents reach for the same commitment — and who can prove what happened afterward.
          </p>
          <div className="mt-9 inline-flex max-w-3xl items-start gap-3 border border-white/20 bg-white/[0.04] p-4 text-sm leading-6 text-white/65">
            <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-[var(--signal)]" />
            <p>
              Published boundary: <strong className="text-white">Tasq {comparison.tasqClaimBoundary.version}</strong> ships Local for consumers sharing one user-owned ledger on one machine and a separately operated Server for authenticated remote coordination. Managed Cloud is unavailable.
            </p>
          </div>
        </div>
      </section>

      <section className="site-container section-space">
        <div className="grid gap-px border border-[var(--line-strong)] bg-[var(--line-strong)] md:grid-cols-3">
          {categories.map(({ icon: Icon, title, body }) => (
            <article className="bg-[var(--paper)] p-6 sm:p-7" key={title}>
              <Icon aria-hidden="true" className="size-6" strokeWidth={1.5} />
              <h2 className="mt-8 text-2xl font-semibold tracking-[-0.04em]">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">{body}</p>
            </article>
          ))}
        </div>

        <section className="mt-20">
          <div className="section-intro">
            <div><p className="eyebrow">Same backlog test</p><h2>Seven systems.<br />Three boundaries.</h2></div>
            <p>Every row is limited to first-party documentation or a normative protocol specification. An inference label means the classification is ours, not the vendor&apos;s wording.</p>
          </div>
          <div className="mt-10 overflow-x-auto border border-[var(--line-strong)]">
            <table className="product-table">
              <thead><tr><th>System</th><th>Parallel behavior</th><th>Collision boundary</th><th>Completion boundary</th></tr></thead>
              <tbody>
                {comparison.systems.map((system) => (
                  <tr key={system.id}>
                    <td className="min-w-52 align-top">
                      <strong>{system.name}</strong>
                      {system.inference ? <span className="mt-2 block w-fit border border-[var(--line-strong)] px-2 py-1 font-mono text-[0.625rem] uppercase tracking-[0.08em]">Inference</span> : null}
                    </td>
                    <td className="min-w-72 align-top">{system.parallelBehavior}</td>
                    <td className="min-w-72 align-top">{system.collisionBoundary}</td>
                    <td className="min-w-72 align-top">{system.completionBoundary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-20 grid gap-8 lg:grid-cols-[0.7fr_1.3fr]">
          <div>
            <p className="eyebrow">Defensible seam</p>
            <h2 className="mt-4 text-4xl font-semibold leading-[1.02] tracking-[-0.055em]">Tasq is the coordination record, not the agent runner.</h2>
            <p className="mt-5 text-sm leading-7 text-[var(--ink-muted)]">Claude agent teams are the closest overlap and already demonstrate atomic claiming inside one vendor team. Tasq is useful when the runtimes are independent and their coordination truth must outlive them.</p>
          </div>
          <div className="border border-[var(--line-strong)] bg-[var(--paper-strong)] p-6 sm:p-8">
            <div className="grid gap-3 font-mono text-sm sm:grid-cols-5 sm:items-center sm:text-center">
              {["commitment", "expiring claim", "attempt", "evidence", "decision"].map((step, index) => (
                <div className="flex items-center gap-3 sm:block" key={step}>
                  <span className="inline-grid size-7 shrink-0 place-items-center border border-[var(--ink)] bg-[var(--signal)] text-[0.625rem] font-bold">{index + 1}</span>
                  <strong className="sm:mt-3 sm:block">{step}</strong>
                </div>
              ))}
            </div>
            <div className="mt-8 border-t border-[var(--line-strong)] pt-6">
              <p className="font-semibold">What Tasq does not do</p>
              <ul className="mt-4 grid gap-2 text-sm leading-6 text-[var(--ink-muted)]">
                <li>It does not make Git edits conflict-free.</li>
                <li>Local remains same-machine; remote coordination requires a separately operated Server.</li>
                <li>It does not replace issue/PR review or vendor-native orchestration.</li>
                <li>An MCP or A2A execution completing never completes a Tasq commitment implicitly.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="mt-20">
          <div className="flex flex-col justify-between gap-5 border-b border-[var(--line-strong)] pb-5 sm:flex-row sm:items-end">
            <div><p className="eyebrow">Claim-level provenance</p><h2 className="mt-3 text-3xl font-semibold tracking-[-0.045em]">Read the sources, not our confidence.</h2></div>
            <a className="inline-flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.06em] hover:underline" href="https://github.com/gwendall/tasq/blob/main/docs/contracts/TQ-621_MULTI_AGENT_COMPARISON.json">Machine-readable matrix <ArrowUpRight className="size-3.5" /></a>
          </div>
          <div className="grid gap-4 pt-8 md:grid-cols-2">
            {comparison.systems.map((system) => (
              <article className="border border-[var(--line)] p-5" key={`${system.id}-sources`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-semibold">{system.name}</h3>
                  <span className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-[var(--ink-faint)]">{system.availability.replaceAll("_", " ")}</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">{system.scopeBoundary}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {system.sourceIds.map((sourceId) => {
                    const source = sourceById.get(sourceId);
                    if (!source) return null;
                    return <a className="inline-flex items-center gap-1.5 border border-[var(--line-strong)] px-2.5 py-1.5 font-mono text-[0.6875rem] hover:bg-[var(--signal-soft)]" href={source.url} key={source.id}>{source.owner}: {source.title}<ArrowUpRight className="size-3" /></a>;
                  })}
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
