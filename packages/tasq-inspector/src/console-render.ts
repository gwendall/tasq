import type {
  ConsoleHealth,
  ConsoleListenerDescriptor,
  ConsoleOverview,
  ConsolePage,
  ConsoleSection,
} from "@tasq-run/schema";

export interface ConsoleDocument {
  overview: ConsoleOverview;
  health: ConsoleHealth;
  page: ConsolePage;
  liveCursor: string;
  runtime?: ConsoleListenerDescriptor | null;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&#39;");
}

function iso(value: number | null | undefined): string {
  return value == null ? "None" : new Date(value).toISOString();
}

function badge(value: string): string {
  return `<span class="state-badge" data-state="${escapeHtml(value)}">${escapeHtml(value.replaceAll("_", " "))}</span>`;
}

function cell(label: string, value: string, className = ""): string {
  return `<td data-label="${escapeHtml(label)}"${className ? ` class="${className}"` : ""}>${value}</td>`;
}

function table(headers: string[], rows: string, emptyMessage: string): string {
  if (!rows) return `<div class="empty-state"><h3>No records in this view</h3><p>${escapeHtml(emptyMessage)}</p></div>`;
  return `<div class="data-table"><table>
    <thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function filterAttributes(text: string, state: string): string {
  return `data-filter-row data-filter-text="${escapeHtml(text.toLowerCase())}" data-filter-state="${escapeHtml(state)}"`;
}

function renderPage(page: ConsolePage): { content: string; states: string[] } {
  if (page.section === "work") {
    const rows = page.items.map((item) => `<tr ${filterAttributes(`${item.title} ${item.id} ${item.status}`, item.status)}>
      ${cell("Commitment", `<a class="record-link" href="/commitments/${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a><code>${escapeHtml(item.id)}</code>`)}
      ${cell("Status", badge(item.status))}
      ${cell("Priority", escapeHtml(item.priority ?? "None"), "numeric")}
      ${cell("Due", `<time>${escapeHtml(iso(item.dueAt))}</time>`)}
      ${cell("Updated", `<time>${escapeHtml(iso(item.updatedAt))}</time>`)}
    </tr>`).join("");
    return { content: table(["Commitment", "Status", "Priority", "Due", "Updated"], rows, "No active commitments are present in this bounded page."), states: page.items.map((item) => item.status) };
  }
  if (page.section === "actors") {
    const rows = page.items.map((item) => `<tr ${filterAttributes(`${item.displayName} ${item.localAlias ?? ""} ${item.kind} ${item.status}`, item.status)}>
      ${cell("Actor", `<strong>${escapeHtml(item.displayName)}</strong><code>${escapeHtml(item.id)}</code>`)}
      ${cell("Kind", escapeHtml(item.kind))}
      ${cell("Local alias", escapeHtml(item.localAlias ?? "None"))}
      ${cell("Status", badge(item.status))}
      ${cell("Revision", escapeHtml(item.revision), "numeric")}
    </tr>`).join("");
    return { content: table(["Actor", "Kind", "Local alias", "Status", "Revision"], rows, "No actors are registered in this workspace."), states: page.items.map((item) => item.status) };
  }
  if (page.section === "claims") {
    const rows = page.items.map((item) => `<tr ${filterAttributes(`${item.commitmentTitle} ${item.actor} ${item.temporalStatus}`, item.temporalStatus)}>
      ${cell("Commitment", `<a class="record-link" href="/commitments/${encodeURIComponent(item.commitmentId)}">${escapeHtml(item.commitmentTitle)}</a><code>${escapeHtml(item.commitmentId)}</code>`)}
      ${cell("Holder", `<strong>${escapeHtml(item.actor)}</strong><code>${escapeHtml(item.principalId ?? "unbound")}</code>`)}
      ${cell("Lease", badge(item.temporalStatus))}
      ${cell("Fence", escapeHtml(item.fence), "numeric")}
      ${cell("Expires", `<time>${escapeHtml(iso(item.expiresAt))}</time>`)}
    </tr>`).join("");
    return { content: table(["Commitment", "Holder", "Lease", "Fence", "Expires"], rows, "No unreleased task claims are present."), states: page.items.map((item) => item.temporalStatus) };
  }
  if (page.section === "resources") {
    const rows = page.items.map((item) => `<tr ${filterAttributes(`${item.resourceKey} ${item.holderActor} ${item.temporalStatus}`, item.temporalStatus)}>
      ${cell("Resource", `<strong>${escapeHtml(item.resourceKey)}</strong><code>${escapeHtml(item.id)}</code>`)}
      ${cell("Holder", `<strong>${escapeHtml(item.holderActor)}</strong><code>${escapeHtml(item.holderPrincipalId)}</code>`)}
      ${cell("Lease", badge(item.temporalStatus))}
      ${cell("Fence", escapeHtml(item.fence), "numeric")}
      ${cell("Expires", `<time>${escapeHtml(iso(item.expiresAt))}</time>`)}
    </tr>`).join("");
    return { content: table(["Resource", "Holder", "Lease", "Fence", "Expires"], rows, "No unreleased resource leases are present."), states: page.items.map((item) => item.temporalStatus) };
  }
  if (page.section === "waits") {
    const rows = page.items.map((item) => {
      const state = item.overdue ? "overdue" : item.status;
      return `<tr ${filterAttributes(`${item.commitmentTitle} ${item.kind} ${state}`, state)}>
        ${cell("Commitment", `<a class="record-link" href="/commitments/${encodeURIComponent(item.commitmentId)}">${escapeHtml(item.commitmentTitle)}</a><code>${escapeHtml(item.commitmentId)}</code>`)}
        ${cell("Condition", `<strong>${escapeHtml(item.kind)}</strong><code>${escapeHtml(item.id)}</code>`)}
        ${cell("Status", badge(state))}
        ${cell("Not before", `<time>${escapeHtml(iso(item.notBefore))}</time>`)}
        ${cell("Deadline", `<time>${escapeHtml(iso(item.deadlineAt))}</time>`)}
      </tr>`;
    }).join("");
    return { content: table(["Commitment", "Condition", "Status", "Not before", "Deadline"], rows, "No active waits are present."), states: page.items.map((item) => item.overdue ? "overdue" : item.status) };
  }
  if (page.section === "effects") {
    const rows = page.items.map((item) => `<tr ${filterAttributes(`${item.commitmentTitle} ${item.effectTypeUri} ${item.status}`, item.status)}>
      ${cell("Commitment", `<a class="record-link" href="/commitments/${encodeURIComponent(item.commitmentId)}">${escapeHtml(item.commitmentTitle)}</a><code>${escapeHtml(item.commitmentId)}</code>`)}
      ${cell("Effect", `<strong>${escapeHtml(item.effectTypeUri)}</strong><code>${escapeHtml(item.id)}</code>`)}
      ${cell("Status", badge(item.status))}
      ${cell("Request digest", `<code>${escapeHtml(item.requestDigest)}</code>`)}
      ${cell("Updated", `<time>${escapeHtml(iso(item.updatedAt))}</time>`)}
    </tr>`).join("");
    return { content: table(["Commitment", "Effect", "Status", "Request digest", "Updated"], rows, "No unresolved effects are present."), states: page.items.map((item) => item.status) };
  }

  const events = page.items.map((item) => `<li ${filterAttributes(`${item.eventType} ${item.entityType} ${item.entityId} ${item.actor}`, item.eventType)}>
    <div class="timeline-sequence" aria-label="Event sequence ${item.sequence}">${item.sequence}</div>
    <article>
      <header><strong>${escapeHtml(item.eventType)}</strong><time>${escapeHtml(iso(item.createdAt))}</time></header>
      <p>${escapeHtml(item.entityType)} <code>${escapeHtml(item.entityId)}</code></p>
      <dl><div><dt>Actor</dt><dd>${escapeHtml(item.actor)}</dd></div><div><dt>Principal</dt><dd><code>${escapeHtml(item.principalId ?? "unbound")}</code></dd></div></dl>
      <p class="redaction-note">Payload omitted by operator index redaction.</p>
    </article>
  </li>`).join("");
  const content = events
    ? `<ol class="audit-timeline">${events}</ol>`
    : `<div class="empty-state"><h3>No audit events</h3><p>No workspace event is present in this bounded page.</p></div>`;
  return { content, states: [...new Set(page.items.map((item) => item.eventType))] };
}

const SECTION_LABELS: Record<ConsoleSection, string> = {
  work: "Work",
  actors: "Actors",
  claims: "Claims",
  resources: "Resources",
  waits: "Waits",
  effects: "Effects",
  audit: "Audit",
};

function metric(label: string, value: number, detail: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd><p>${escapeHtml(detail)}</p></div>`;
}

function sum(values: Record<string, number>, excluded: string[] = []): number {
  return Object.entries(values).filter(([key]) => !excluded.includes(key)).reduce((total, [, value]) => total + value, 0);
}

export function renderConsole(document: ConsoleDocument): string {
  const { overview, health, page, liveCursor, runtime } = document;
  const pageView = renderPage(page);
  const uniqueStates = [...new Set(pageView.states)].sort();
  const activeWork = sum(overview.counts.commitments, ["done", "cancelled"]);
  const unresolvedEffects = ["proposed", "authorized", "executing", "indeterminate"]
    .reduce((total, state) => total + (overview.counts.effects[state] ?? 0), 0);
  const attention = overview.attention.length === 0
    ? `<p class="attention-clear">No bounded attention signals at this snapshot.</p>`
    : `<ul>${overview.attention.map((item) => `<li>${escapeHtml(item.replaceAll("_", " "))}</li>`).join("")}</ul>`;
  const next = page.hasMore && page.nextCursor
    ? `<a class="secondary-action" href="/?view=${page.section}&cursor=${encodeURIComponent(page.nextCursor)}">Load next canonical page</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Tasq Console | ${escapeHtml(overview.workspaceId)}</title>
  <link rel="stylesheet" href="/assets/console.css">
  <script src="/assets/console.js" defer></script>
</head>
<body data-live-cursor="${escapeHtml(liveCursor)}">
  <a class="skip-link" href="#main-content">Skip to workspace data</a>
  <header class="console-header">
    <a class="brand" href="/" aria-label="Tasq Console home">tasq <span>console</span></a>
    <p class="workspace-label"><span>Workspace</span><code>${escapeHtml(overview.workspaceId)}</code></p>
    <div class="connection-group">
      <span id="live-status" class="live-status" data-state="connecting" role="status" aria-live="polite">Connecting</span>
      <button id="refresh-view" class="quiet-action" type="button" hidden>Refresh canonical view</button>
    </div>
  </header>
  <div class="console-layout">
    <aside class="sidebar" aria-label="Console navigation">
      <nav>${Object.entries(SECTION_LABELS).map(([section, label]) =>
        `<a href="/?view=${section}"${page.section === section ? ` aria-current="page"` : ""}>${label}</a>`
      ).join("")}</nav>
      <div class="sidebar-boundary">
        <strong>Local and read-only</strong>
        <p>This browser surface cannot mutate the ledger.</p>
      </div>
    </aside>
    <main id="main-content" class="console-main">
      <header class="page-header">
        <div><p class="context-label">Canonical workspace snapshot</p><h1>Workspace overview</h1></div>
        <p>Inspected at <time>${escapeHtml(iso(overview.inspectedAt))}</time></p>
      </header>
      <section class="attention-panel" data-attention="${overview.attention.length > 0}" aria-labelledby="attention-title">
        <div><h2 id="attention-title">Attention</h2><p>Bounded operational signals, not a full integrity check.</p></div>
        ${attention}
      </section>
      <dl class="metric-strip" aria-label="Workspace metrics">
        ${metric("Active work", activeWork, "non-terminal commitments")}
        ${metric("Enabled actors", overview.counts.actors.enabled, `${overview.counts.actors.disabled} disabled`)}
        ${metric("Held claims", overview.counts.claims.active + overview.counts.claims.expiredHeld, `${overview.counts.claims.expiredHeld} expired`)}
        ${metric("Resource leases", overview.counts.resources.active + overview.counts.resources.expiredHeld, `${overview.counts.resources.expiredHeld} expired`)}
        ${metric("Active waits", overview.counts.waits.waiting, `${overview.counts.waits.overdue} overdue`)}
        ${metric("Unresolved effects", unresolvedEffects, `${overview.counts.effects.indeterminate ?? 0} indeterminate`)}
      </dl>
      <section class="records-section" aria-labelledby="records-title">
        <header class="records-header">
          <div><h2 id="records-title">${SECTION_LABELS[page.section]}</h2><p>${page.returned} records loaded from a page of at most ${page.requestedLimit}.</p></div>
          ${next}
        </header>
        <div class="filter-bar" role="search" aria-label="Filter loaded records">
          <div><label for="record-query">Filter this loaded page</label><input id="record-query" type="search" autocomplete="off" placeholder="Search visible fields"></div>
          <div><label for="record-state">State</label><select id="record-state"><option value="">All states</option>${uniqueStates.map((state) => `<option value="${escapeHtml(state)}">${escapeHtml(state.replaceAll("_", " "))}</option>`).join("")}</select></div>
          <p id="filter-result" role="status" aria-live="polite">Showing ${page.returned} of ${page.returned} loaded records.</p>
        </div>
        <div id="record-results">${pageView.content}</div>
      </section>
      <section class="integrity-panel" aria-labelledby="integrity-title">
        <div><h2 id="integrity-title">Integrity boundary</h2><p>The Console reports bounded signals only. Full verification is always explicit.</p></div>
        <code>${health.fullIntegrity.argv.map(escapeHtml).join(" ")}</code>
      </section>
      <section class="support-panel" aria-labelledby="support-title">
        <div><h2 id="support-title">Redacted support bundle</h2><p>Preview the exact local JSON before enabling its download.</p></div>
        <div class="support-actions">
          <button id="preview-support" type="button">Preview bundle</button>
          <a id="download-support" class="secondary-action" download="tasq-support-bundle.json" hidden>Download reviewed JSON</a>
        </div>
        <p id="support-error" class="inline-error" role="alert" hidden></p>
        <div id="support-preview" class="support-preview" hidden>
          <p>Event payloads, provider bodies, effect requests, secret bindings and record metadata are omitted.</p>
          <pre tabindex="0"></pre>
        </div>
        <noscript><p><a href="/api/console/support-bundle">Open the redacted JSON preview</a>. JavaScript is required only to enable reviewed download.</p></noscript>
      </section>
      <footer class="console-footer">
        ${runtime ? `<span>Tasq Local ${escapeHtml(runtime.productVersion)}</span>` : ""}
        <span>Event cursor ${health.cursors.eventSequence}</span>
        ${runtime ? `<a href="/api/console/runtime">Listener identity</a>` : ""}
        <a href="/api/console/overview">Overview JSON</a>
        <a href="/inspector">Legacy commitment index</a>
      </footer>
    </main>
  </div>
</body>
</html>`;
}
