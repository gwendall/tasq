import { Copy } from "lucide-react";

export function CodeWindow({ title = "terminal", children }: { title?: string; children: string }) {
  return (
    <div className="overflow-hidden border border-[var(--line-strong)] bg-[#171815] text-[#f4f1e8] shadow-[5px_5px_0_var(--line)]">
      <div className="flex h-10 items-center justify-between border-b border-white/15 px-3 font-mono text-[0.65rem] uppercase tracking-[0.1em] text-white/45">
        <span className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-[var(--signal)]" />
          {title}
        </span>
        <Copy aria-hidden="true" className="size-3.5" />
      </div>
      <pre className="overflow-x-auto p-4 text-[0.75rem] leading-6 sm:p-5 sm:text-[0.8rem]"><code>{children}</code></pre>
    </div>
  );
}
