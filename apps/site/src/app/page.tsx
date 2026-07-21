import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Boxes,
  Braces,
  Check,
  Clock3,
  Fingerprint,
  GitBranch,
  Network,
  ShieldCheck,
  TerminalSquare,
  Users,
  X,
} from "lucide-react";

import { CodeWindow } from "@/components/code-window";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { productTruth, titleWords } from "@/lib/product-truth";

const currentShapes = productTruth.productShapes;
const benefits = [
  {
    icon: Network,
    title: "Stop losing the thread",
    body: "Commitments, owners, attempts and evidence survive model changes, process crashes and handoffs.",
  },
  {
    icon: Fingerprint,
    title: "Make ownership explicit",
    body: "Expiring claims and monotone fences prevent two workers from quietly acting as the current owner.",
  },
  {
    icon: ShieldCheck,
    title: "Keep authority separate",
    body: "An agent can propose, execute and report without silently granting itself permission or completion.",
  },
];

const boundaries = [
  ["Agent runtime", "Reasoning, tools, execution"],
  ["Policy", "Priority and domain decisions"],
  ["Connector", "Provider credentials and I/O"],
  ["Tasq kernel", "Durable coordination truth"],
] as const;

export default function HomePage() {
  return (
    <main id="main-content">
      <section className="hero-grid overflow-hidden border-b border-[var(--line-strong)]">
        <div className="site-container grid min-h-[680px] items-stretch lg:grid-cols-[1.08fr_0.92fr]">
          <div className="flex flex-col justify-center border-[var(--line)] py-20 lg:border-r lg:pr-14">
            <div className="eyebrow">
              <span className="size-2 bg-[var(--signal)]" />
              Universal coordination kernel
            </div>
            <h1 className="mt-7 max-w-3xl text-[clamp(3.3rem,8vw,7.1rem)] font-semibold leading-[0.86] tracking-[-0.075em]">
              The shared truth <span className="text-outline">between</span> agents.
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-[var(--ink-muted)] sm:text-xl">
              Tasq gives humans, agents and runtimes one durable ledger for what is owed, who owns it, what happened and what proves it is done.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link href="/docs/getting-started">
                  Build Tasq Local <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={productTruth.release.repository}>
                  <GitBranch aria-hidden="true" className="size-4" /> Source (private)
                </a>
              </Button>
            </div>
            <p className="mt-5 flex items-start gap-2 font-mono text-[0.7rem] leading-5 uppercase tracking-[0.07em] text-[var(--ink-faint)]">
              <Clock3 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              Repository access is private before launch. Package and lifecycle candidates are certified.
            </p>
          </div>

          <div className="relative flex items-center py-16 lg:pl-14">
            <div className="absolute inset-y-0 left-0 hidden w-px bg-[var(--line)] lg:block" />
            <div className="w-full">
              <div className="mb-3 flex items-center justify-between font-mono text-[0.65rem] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
                <span>coordination / live model</span>
                <span>local</span>
              </div>
              <div className="coordination-map" data-synthetic-demo="true" aria-label="Synthetic diagram: two agents and one human coordinate through the Tasq ledger">
                <div className="map-actor map-actor-a">
                  <Bot aria-hidden="true" />
                  <span>planner</span>
                </div>
                <div className="map-actor map-actor-b">
                  <Bot aria-hidden="true" />
                  <span>builder</span>
                </div>
                <div className="map-actor map-actor-c">
                  <Users aria-hidden="true" />
                  <span>human</span>
                </div>
                <div className="map-core">
                  <span className="font-mono text-[0.62rem] uppercase tracking-[0.12em] text-white/45">shared ledger</span>
                  <strong>tasq</strong>
                  <div className="mt-4 grid grid-cols-2 gap-px bg-white/15 text-[0.63rem]">
                    {['commitment', 'claim', 'attempt', 'evidence'].map((item) => (
                      <span className="bg-[var(--ink)] px-2 py-1.5 font-mono text-white/65" key={item}>{item}</span>
                    ))}
                  </div>
                </div>
                <span className="map-line map-line-a" />
                <span className="map-line map-line-b" />
                <span className="map-line map-line-c" />
                <span className="map-pulse map-pulse-a" />
                <span className="map-pulse map-pulse-b" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--line-strong)] bg-[var(--ink)] text-[var(--paper)]">
        <div className="site-container grid gap-px bg-white/15 md:grid-cols-3">
          {benefits.map(({ icon: Icon, title, body }, index) => (
            <article className="bg-[var(--ink)] px-6 py-9 sm:px-8" key={title}>
              <div className="flex items-start justify-between">
                <Icon aria-hidden="true" className="size-6 text-[var(--signal)]" strokeWidth={1.6} />
                <span className="font-mono text-[0.65rem] text-white/30">0{index + 1}</span>
              </div>
              <h2 className="mt-9 text-xl font-semibold tracking-[-0.035em]">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-white/55">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-space border-b border-[var(--line-strong)]">
        <div className="site-container">
          <div className="section-intro">
            <div>
              <p className="eyebrow">The irreducible loop</p>
              <h2>Execution happened.<br />Did the outcome?</h2>
            </div>
            <p>
              Most task protocols collapse intent, execution and completion. Tasq keeps them separate, so every handoff has an inspectable basis.
            </p>
          </div>
          <div className="mt-14 grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="ledger-flow">
              {[
                ["01", "Commitment", "The outcome still owed"],
                ["02", "Claim", "Temporary right to work"],
                ["03", "Attempt", "One execution, not the goal"],
                ["04", "Evidence", "The basis for a decision"],
                ["05", "Completion", "Explicit and auditable"],
              ].map(([number, title, body]) => (
                <div className="ledger-step" key={number}>
                  <span>{number}</span><strong>{title}</strong><p>{body}</p>
                </div>
              ))}
            </div>
            <CodeWindow title="agent bootstrap">
              {`$ tasq onboard \\\n+  --space robotics/team-a \\\n+  --actor agent:planner \\\n+  --json

{
  "contractVersion": "tasq.onboarding.v1",
  "workspace": "robotics/team-a",
  "capabilities": ["read", "propose", "coordinate"],
  "recipes": { "read": ["tasq", "context", "--json"] }
}`}
            </CodeWindow>
          </div>
        </div>
      </section>

      <section className="section-space border-b border-[var(--line-strong)] bg-[var(--paper-strong)]">
        <div className="site-container">
          <div className="section-intro">
            <div>
              <p className="eyebrow">Clean boundaries</p>
              <h2>Own the truth.<br />Not the whole stack.</h2>
            </div>
            <p>
              Tasq is deliberately headless. Your models, workflows and providers stay replaceable because Core owns only coordination state.
            </p>
          </div>
          <div className="boundary-stack mt-14">
            {boundaries.map(([title, detail], index) => (
              <div className={index === boundaries.length - 1 ? "is-core" : ""} key={title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{title}</strong>
                <p>{detail}</p>
                {index === boundaries.length - 1 ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-3 font-mono text-[0.68rem] uppercase tracking-[0.06em] text-[var(--ink-faint)] sm:grid-cols-3">
            <span className="boundary-note"><Braces /> No stored code</span>
            <span className="boundary-note"><Clock3 /> Injected clock</span>
            <span className="boundary-note"><Boxes /> No provider ontology</span>
          </div>
        </div>
      </section>

      <section className="section-space border-b border-[var(--line-strong)]">
        <div className="site-container">
          <div className="section-intro">
            <div>
              <p className="eyebrow">One product, four shapes</p>
              <h2>Use what exists.<br />See what does not.</h2>
            </div>
            <p>
              Every status below comes from the versioned product matrix. A designed server never masquerades as a shipped endpoint.
            </p>
          </div>
          <div className="mt-14 overflow-x-auto border border-[var(--line-strong)]">
            <table className="product-table">
              <thead><tr><th>Shape</th><th>Status</th><th>What it is</th><th>Entrypoints</th></tr></thead>
              <tbody>
                {currentShapes.map((shape) => (
                  <tr key={shape.id}>
                    <td><strong>Tasq {titleWords(shape.id)}</strong></td>
                    <td><StatusBadge support={shape.support} /></td>
                    <td>{shape.id === "core" ? "Embedded TypeScript kernel" : shape.id === "local" ? "CLI, stdio MCP and read-only Console" : shape.id === "server" ? "Authenticated self-hosted network product" : "Managed Tasq Server operation"}</td>
                    <td className="font-mono text-xs text-[var(--ink-faint)]">{shape.entrypoints.length ? shape.entrypoints.join(" · ") : "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-5 flex flex-col justify-between gap-4 border-l-4 border-[var(--signal)] bg-[var(--signal-soft)] p-5 sm:flex-row sm:items-center">
            <p className="text-sm leading-6"><strong>Today:</strong> Local behavior is certified, but the first protected release is still waiting on registry authority.</p>
            <Button asChild variant="outline" size="sm"><Link href="/status">Inspect product truth <ArrowRight className="size-3.5" /></Link></Button>
          </div>
        </div>
      </section>

      <section className="section-space">
        <div className="site-container grid gap-10 border border-[var(--line-strong)] bg-[var(--ink)] px-6 py-10 text-[var(--paper)] shadow-[7px_7px_0_var(--signal)] sm:px-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="eyebrow text-white/45"><TerminalSquare className="size-3.5" /> Start local</p>
            <h2 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.02] tracking-[-0.055em] sm:text-6xl">Give your agents something durable to agree on.</h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-white/55">Build from the canonical source, create one workspace and connect the first independent actor.</p>
          </div>
          <Button asChild size="lg" className="border-white bg-[var(--signal)] text-[var(--ink)] shadow-[4px_4px_0_white] hover:bg-white hover:shadow-[4px_4px_0_var(--signal)]">
            <Link href="/docs/getting-started">Read the local guide <ArrowRight className="size-4" /></Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
