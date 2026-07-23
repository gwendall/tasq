import Link from "next/link";
import { ArrowRight, Bot, Download, PlugZap, ShieldCheck } from "lucide-react";

import { CodeWindow } from "@/components/code-window";
import { Button } from "@/components/ui/button";
import { publicCodeExamples } from "@/lib/examples";

const codexMcp = `codex mcp add tasq -- \\
  /absolute/path/to/tasq mcp \\
  --tenant robotics/team-a \\
  --actor codex:gwendall \\
  --capabilities read,propose,coordinate`;

const claudeMcp = `claude mcp add tasq --scope user -- \\
  /absolute/path/to/tasq mcp \\
  --tenant robotics/team-a \\
  --actor claude-code:gwendall \\
  --capabilities read,propose,coordinate`;

const genericMcp = `{
  "mcpServers": {
    "tasq": {
      "command": "/absolute/path/to/tasq",
      "args": [
        "mcp",
        "--tenant", "robotics/team-a",
        "--actor", "agent:gwendall",
        "--capabilities", "read,propose,coordinate"
      ]
    }
  }
}`;

export default function AgentsPage() {
  return (
    <main id="main-content">
      <section className="hero-grid border-b border-[var(--line-strong)]">
        <div className="site-container py-20 sm:py-28">
          <p className="eyebrow">Agent entrypoint</p>
          <h1 className="mt-7 max-w-5xl text-[clamp(3.2rem,7vw,6.5rem)] font-semibold leading-[0.9] tracking-[-0.068em]">
            Give any agent the <span className="text-outline">same work.</span>
          </h1>
          <p className="mt-8 max-w-3xl text-lg leading-8 text-[var(--ink-muted)] sm:text-xl">
            Codex, Claude Code and generic MCP hosts can join one explicit Local ledger. The host fixes the executable, space, actor and capability set before the model sees a tool.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="/SKILL.md"><Download className="size-4" /> Read SKILL.md</a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="/integration.json">Machine contract <ArrowRight className="size-4" /></a>
            </Button>
          </div>
        </div>
      </section>

      <section className="section-space border-b border-[var(--line-strong)]">
        <div className="site-container grid gap-10 lg:grid-cols-[0.78fr_1.22fr]">
          <div>
            <Bot className="size-7 text-[var(--signal-ink)]" />
            <h2 className="mt-6 text-4xl font-semibold tracking-[-0.05em]">Try the real package first.</h2>
            <p className="mt-5 text-base leading-7 text-[var(--ink-muted)]">
              Both runners execute the exact scoped package version without creating a persistent Tasq installation. The unrelated unscoped npm package is not Tasq.
            </p>
          </div>
          <CodeWindow title={publicCodeExamples.quickTry.title}>{publicCodeExamples.quickTry.display}</CodeWindow>
        </div>
      </section>

      <section className="section-space border-b border-[var(--line-strong)] bg-[var(--paper-strong)]">
        <div className="site-container">
          <div className="max-w-3xl">
            <PlugZap className="size-7 text-[var(--signal-ink)]" />
            <h2 className="mt-6 text-4xl font-semibold tracking-[-0.05em]">Copy the host recipe. Replace every explicit value.</h2>
            <p className="mt-5 text-base leading-7 text-[var(--ink-muted)]">
              These recipes start the same local stdio MCP server. Use an absolute executable path. A space name on two isolated stores does not create coordination.
            </p>
          </div>
          <div className="mt-10 grid gap-6 xl:grid-cols-3">
            <CodeWindow title="Codex">{codexMcp}</CodeWindow>
            <CodeWindow title="Claude Code">{claudeMcp}</CodeWindow>
            <CodeWindow title="Generic MCP JSON">{genericMcp}</CodeWindow>
          </div>
        </div>
      </section>

      <section className="section-space">
        <div className="site-container grid gap-10 lg:grid-cols-[0.78fr_1.22fr]">
          <div>
            <ShieldCheck className="size-7 text-[var(--signal-ink)]" />
            <h2 className="mt-6 text-4xl font-semibold tracking-[-0.05em]">A project file is a pointer, never permission.</h2>
          </div>
          <div className="grid gap-5 text-base leading-7 text-[var(--ink-muted)]">
            <p>
              The versioned rendezvous descriptor can name the Local store reference, space and agent instructions. It contains no token, credential or effect authority, and Tasq never activates it merely because it exists in the current directory.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline"><a href="/project-rendezvous.example.json">Example descriptor</a></Button>
              <Button asChild variant="ghost"><Link href="/docs/agents">Read the agent guide <ArrowRight className="size-4" /></Link></Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
