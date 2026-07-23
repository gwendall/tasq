import { Copy } from "lucide-react";

export function CodeWindow({ title = "terminal", children }: { title?: string; children: string }) {
  return (
    <div className="overflow-hidden border border-[var(--line-strong)] bg-[#171815] text-[#f4f1e8] shadow-[3px_3px_0_var(--line)]">
      <div className="flex h-11 items-center justify-between border-b border-white/15 px-4 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-white/45">
        <span className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-[var(--signal)]" />
          {title}
        </span>
        <Copy aria-hidden="true" className="size-3.5" />
      </div>
      <pre className="overflow-x-auto p-5 text-[0.8125rem] leading-6 sm:p-6"><code>{children}</code></pre>
    </div>
  );
}
