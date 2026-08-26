import Image from "next/image";
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
import { publicCodeExamples } from "@/lib/examples";
import { productTruth, titleWords } from "@/lib/product-truth";

const currentShapes = productTruth.productShapes;
const published = productTruth.release.published;
const releaseVersion = productTruth.release.version ?? "0.1.0";
const benefits = [
  {
    icon: Network,
    title: "Stop losing the thread",
    body: "Tasks, owners, attempts and evidence survive model changes, process crashes and handoffs.",
  },
  {
    icon: Fingerprint,
    title: "Make ownership explicit",
    body: "Claims expire and never overlap, so two workers cannot quietly act as the current owner of the same task.",
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
  ["Tasq", "Who owns what, and the proof it is done"],
] as const;

export default function HomePage() {
  return (
    <main id="main-content">
      <section className="hero-grid overflow-hidden border-b border-[var(--line-strong)]">
        <div className="site-container grid min-h-[660px] items-stretch lg:grid-cols-[1.08fr_0.92fr]">
          <div className="flex flex-col justify-center border-[var(--line)] py-16 sm:py-20 lg:border-r lg:pr-16">
            <div className="eyebrow">Local-first task tracking</div>
            <h1 className="mt-7 max-w-3xl text-[clamp(3.1rem,6.2vw,5.7rem)] font-semibold leading-[0.92] tracking-[-0.064em]">
              No duplicate work. <span className="text-outline">Agents stay aligned.</span>
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-[var(--ink-muted)] sm:text-xl">
              The project tracker you share with your agents. They claim work, prove it is done, and pick up where the last session died. You stay in the loop.
            </p>
            {published ? (
              <div className="mt-8 flex w-full max-w-full items-center gap-3 border border-[var(--line-strong)] bg-[var(--ink)] px-4 py-3 font-mono text-sm text-[var(--paper)] shadow-[4px_4px_0_var(--signal)] sm:max-w-md">
                <span aria-hidden="true" className="shrink-0 text-[var(--signal)]">$</span>
                <code className="min-w-0 overflow-x-auto whitespace-nowrap">{publicCodeExamples.demo.display}</code>
              </div>
            ) : null}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link href="/docs/getting-started">
                  {published ? "Install Tasq" : "Build Tasq"} <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={productTruth.release.repository}>
                  <GitBranch aria-hidden="true" className="size-4" /> Source
                </a>
              </Button>
            </div>
          </div>

          <div className="relative flex items-center py-14 sm:py-16 lg:pl-16">
            <div className="absolute inset-y-0 left-0 hidden w-px bg-[var(--line)] lg:block" />
            <div className="w-full">
              <div className="mb-3 flex items-center justify-between font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
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
                  <span className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-white/45">shared ledger</span>
                  <strong>tasq</strong>
                  <div className="mt-4 grid grid-cols-2 gap-px bg-white/15 text-[0.6875rem]">
                    {['task', 'claim', 'attempt', 'evidence'].map((item) => (
                      <span className="bg-[var(--ink)] px-2 py-1.5 font-mono text-white/65" key={item}>{item}</span>
                    ))}
                  </div>
                </div>
                <svg className="map-network" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <line className="map-path" x1="21" y1="17" x2="53" y2="54" />
                  <line className="map-path" x1="79" y1="21" x2="53" y2="54" />
                  <line className="map-path" x1="22" y1="81" x2="53" y2="54" />
                  <circle className="map-junction" cx="36" cy="34" r=".8" />
                  <circle className="map-junction" cx="67" cy="36" r=".8" />
                  <circle className="map-junction" cx="37" cy="68" r=".8" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b border-[var(--line-strong)] bg-[var(--ink)] text-[var(--paper)]">
        <div className="site-container grid gap-px bg-white/15 md:grid-cols-3">
          {benefits.map(({ icon: Icon, title, body }) => (
            <article className="bg-[var(--ink)] px-6 py-9 sm:px-8" key={title}>
              <div className="flex items-start">
                <Icon aria-hidden="true" className="size-6 text-[var(--signal)]" strokeWidth={1.6} />
              </div>
              <h2 className="mt-9 text-xl font-semibold tracking-[-0.035em]">{title}</h2>
              <p className="mt-3 text-sm leading-6 text-white/55">{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-b border-[var(--line-strong)] bg-[var(--signal-soft)]">
        <div className="site-container flex flex-col gap-2 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p>
            <strong>{published ? `Tasq Local ${releaseVersion} is available now.` : "Tasq Local builds from source today."}</strong>{" "}
            Local remains same-machine and one-store. A separately published Server image supports authenticated remote coordination; managed Cloud is not available.
          </p>
          <Link className="font-mono text-xs font-semibold uppercase tracking-[0.06em] underline underline-offset-4" href="/status">
            Verify product status
          </Link>
        </div>
      </section>

      <section className="section-space border-b border-[var(--line-strong)]">
        <div className="site-container">
          <div className="section-intro">
            <div>
              <h2>An agent said done.<br />Was it?</h2>
            </div>
            <p>
              Most task tools treat &ldquo;I ran the command&rdquo; and &ldquo;the work is finished&rdquo; as the same event. Tasq keeps them apart, so every handoff has something you can inspect.
            </p>
          </div>
          <div className="mt-12 grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="ledger-flow">
              {[
                ["01", "Task", "The outcome still owed"],
                ["02", "Claim", "Temporary right to work"],
                ["03", "Attempt", "One execution, not the goal"],
                ["04", "Evidence", "The receipt it actually happened"],
                ["05", "Decision", "Independent when policy requires"],
                ["06", "Done", "Explicit and auditable"],
              ].map(([number, title, body]) => (
                <div className="ledger-step" key={number}>
                  <span>{number}</span><strong>{title}</strong><p>{body}</p>
                </div>
              ))}
            </div>
            <CodeWindow title={publicCodeExamples.humanFlow.title}>{publicCodeExamples.humanFlow.display}</CodeWindow>
          </div>
        </div>
      </section>

      <section className="section-space border-b border-[var(--line-strong)]">
        <div className="site-container grid gap-px border border-[var(--line-strong)] bg-[var(--line-strong)] lg:grid-cols-2">
          <article className="min-w-0 bg-[var(--paper)] p-8 sm:p-10">
            <p className="eyebrow"><Users aria-hidden="true" className="size-3.5" /> For you</p>
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">
              A real tracker, not a scratchpad.
            </h2>
            <p className="mt-4 text-base leading-7 text-[var(--ink-muted)]">
              Areas, goals, projects and tasks. Due dates, recurrences and dependencies.
              {" "}<code className="font-mono text-sm">tasq next</code> tells you what to do now.
              One SQLite file you own, no account and no cloud.
            </p>
            <div className="mt-7">
              <CodeWindow title={publicCodeExamples.humanFlow.title}>{publicCodeExamples.humanFlow.display}</CodeWindow>
            </div>
          </article>
          <article className="min-w-0 bg-[var(--paper)] p-8 sm:p-10">
            <p className="eyebrow"><Bot aria-hidden="true" className="size-3.5" /> For your agents</p>
            <h2 className="mt-5 text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">
              One command to plug them in.
            </h2>
            <p className="mt-4 text-base leading-7 text-[var(--ink-muted)]">
              Claude Code, Codex or any MCP client reads the same ledger you do. They take
              work with an expiring claim, so two agents never start the same task and nobody
              closes work someone else is holding. Work they propose this way says up front
              what done looks like, and closes only against a receipt you can inspect.
            </p>
            <div className="mt-7">
              <CodeWindow title={publicCodeExamples.agentConnect.title}>{publicCodeExamples.agentConnect.display}</CodeWindow>
            </div>
          </article>
        </div>
      </section>

      <section className="section-space border-b border-[var(--line-strong)] bg-[var(--paper-strong)]">
        <div className="site-container">
          <div className="max-w-3xl">
            <h2 className="text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[0.98] tracking-[-0.058em]">
              See the shared state locally.
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[var(--ink-muted)]">
              The read-only Console shows tasks, claims, resources, evidence, resolution decisions and audit history from the same local ledger. It binds only to loopback.
            </p>
          </div>
          <div className="mt-10 overflow-hidden border border-[var(--line-strong)] bg-[var(--paper)] shadow-[5px_5px_0_var(--ink)]">
            <Image
              alt="The real Tasq Local Console showing a mature coordination workspace"
              className="h-auto w-full"
              height={1201}
              priority={false}
              src="/console-local.png"
              width={1600}
            />
          </div>
          <div className="mt-8 grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
            <CodeWindow title={publicCodeExamples.console.title}>{publicCodeExamples.console.display}</CodeWindow>
            <div className="border-l-2 border-[var(--signal)] bg-[var(--signal-soft)] p-6 text-sm leading-6">
              This is not tasq.run and it is not a hosted dashboard. Keep the listener on
              {" "}<code>127.0.0.1</code>; do not expose it through a generic reverse proxy.
            </div>
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
          <div className="boundary-stack mt-12">
            {boundaries.map(([title, detail], index) => (
              <div className={index === boundaries.length - 1 ? "is-core" : ""} key={title}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{title}</strong>
                <p>{detail}</p>
                {index === boundaries.length - 1 ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
              </div>
            ))}
          </div>
          <div className="mt-6 grid gap-4 font-mono text-[0.6875rem] uppercase tracking-[0.06em] text-[var(--ink-faint)] sm:grid-cols-3">
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
              <h2>Use what exists.<br />See what does not.</h2>
            </div>
            <p>
              Every status below comes from the versioned product matrix. A designed server never masquerades as a shipped endpoint.
            </p>
          </div>
          <figure
            className="mt-12 grid overflow-hidden border border-[var(--line-strong)] bg-[var(--ink)] shadow-[5px_5px_0_var(--signal)] lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]"
            data-public-demo="true"
          >
            <div className="flex items-center justify-center bg-[#1e1e2e] p-3 sm:p-6">
              <Image
                alt="Tasq public CLI demo: one agent claims a task, a second is refused, and the task closes only against a receipt"
                className="h-auto w-full max-w-[640px]"
                height={360}
                src="/tasq-demo.gif"
                unoptimized
                width={640}
              />
            </div>
            <figcaption className="flex flex-col justify-center border-t border-white/15 p-7 text-[var(--paper)] sm:p-9 lg:border-l lg:border-t-0">
              <h3 className="text-2xl font-semibold tracking-[-0.04em]">Watch two agents share one task.</h3>
              <p className="mt-4 text-sm leading-6 text-white/55">
                One agent takes the task, a second is refused by name and expiry, and it closes only once a receipt is attached. Everything runs in a throwaway home; your configured ledger stays untouched.
              </p>
              <code className="mt-6 overflow-x-auto whitespace-nowrap font-mono text-xs text-[var(--signal)]">
                npx --yes @tasq-run/cli@{releaseVersion} demo
              </code>
            </figcaption>
          </figure>
          <div className="mt-12 overflow-x-auto border border-[var(--line-strong)]">
            <table className="product-table">
              <thead><tr><th>Shape</th><th>Status</th><th>What it is</th><th>Entrypoints</th></tr></thead>
              <tbody>
                {currentShapes.map((shape) => (
                  <tr key={shape.id}>
                    <td><strong>Tasq {titleWords(shape.id)}</strong></td>
                    <td><StatusBadge support={shape.support} /></td>
                    <td>{shape.id === "core" ? "Embedded TypeScript kernel" : shape.id === "local" ? "CLI, stdio MCP and read-only Console" : shape.id === "server" ? "Authenticated self-hosted network product" : "Managed Tasq Server operation"}</td>
                    <td className="font-mono text-xs text-[var(--ink-faint)]">{shape.entrypoints.length ? shape.entrypoints.join(", ") : "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-5 flex flex-col justify-between gap-5 border-l-2 border-[var(--signal)] bg-[var(--signal-soft)] p-6 sm:flex-row sm:items-center">
            <p className="text-sm leading-6">
              <strong>Today:</strong>{" "}
              {published
                ? `Local ${releaseVersion} and the authenticated self-hosted Server are published alphas. Remote clients ship; managed Cloud is not available.`
                : "Generated release truth currently withholds package coordinates. Use the canonical source path from /adopt.json."}
            </p>
            <Button asChild variant="outline" size="sm"><Link href="/status">Inspect product truth <ArrowRight className="size-3.5" /></Link></Button>
          </div>
        </div>
      </section>

      <section className="section-space">
        <div className="site-container grid gap-10 border border-[var(--line-strong)] bg-[var(--ink)] px-7 py-10 text-[var(--paper)] shadow-[5px_5px_0_var(--signal)] sm:px-10 sm:py-12 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="eyebrow text-white/45"><TerminalSquare className="size-3.5" /> Start local</p>
            <h2 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.05] tracking-[-0.05em] sm:text-5xl">Give your agents something durable to agree on.</h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-white/55">
              {published
                ? "Install the protected alpha, create one workspace and connect the first independent actor."
                : "Build from the canonical source, create one workspace and connect the first independent actor."}
            </p>
          </div>
          <Button asChild size="lg" className="border-white bg-[var(--signal)] text-[var(--ink)] shadow-[3px_3px_0_white] hover:shadow-[3px_6px_0_white] active:shadow-[3px_2px_0_white]">
            <Link href="/docs/getting-started">{published ? "Install the public alpha" : "Read the local guide"} <ArrowRight className="size-4" /></Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
