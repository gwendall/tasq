import type { InspectorIndex } from "@tasq-run/schema";
import type { CommitmentInspection } from "@tasq-run/core";

function escapeHtml(value: unknown): string {
  return String(value)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split('"').join("&quot;")
    .split("'").join("&#39;");
}

function time(value: number | null | undefined): string {
  return value == null ? "None" : new Date(value).toISOString();
}

function compactId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function jsonDetails(label: string, value: unknown): string {
  return `<details class="payload"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(
    JSON.stringify(value, null, 2),
  )}</pre></details>`;
}

function status(value: string): string {
  return `<span class="status" data-status="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function identifier(value: string): string {
  return `<code title="${escapeHtml(value)}">${escapeHtml(value)}</code>`;
}

function empty(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

function shell(title: string, workspaceId: string | null, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)} | Tasq inspector</title>
  <link rel="stylesheet" href="/assets/inspector.css">
</head>
<body>
  <a class="skip-link" href="#content">Skip to inspection</a>
  <header class="site-header">
    <a class="brand" href="/" aria-label="Tasq inspector home">tasq <span>inspector</span></a>
    ${workspaceId ? `<p class="workspace">Workspace ${identifier(workspaceId)}</p>` : ""}
    <p class="read-only">Local read-only surface</p>
  </header>
  ${body}
</body>
</html>`;
}

function indexItem(item: InspectorIndex["items"][number]): string {
  const signals = item.signals;
  return `<li class="commitment-row">
    <article>
      <div class="commitment-main">
        <div class="row-heading">
          ${status(item.status)}
          <span class="revision">revision ${item.revision}</span>
        </div>
        <h2><a href="/commitments/${encodeURIComponent(item.commitmentId)}">${escapeHtml(item.title)}</a></h2>
        <p class="identity" title="${escapeHtml(item.commitmentId)}">${escapeHtml(compactId(item.commitmentId))}</p>
      </div>
      <dl class="signal-grid" aria-label="Coordination signals">
        <div><dt>Waiting</dt><dd>${signals.waiting}<span> / ${signals.waits}</span></dd></div>
        <div><dt>Unresolved effects</dt><dd>${signals.unresolvedEffects}<span> / ${signals.effects}</span></dd></div>
        <div><dt>Authority decisions</dt><dd>${signals.authorityDecisions}</dd></div>
        <div><dt>Receipts</dt><dd>${signals.receipts}</dd></div>
      </dl>
      <div class="row-meta">
        <span>Priority ${item.priority ?? "none"}</span>
        <span>Due ${escapeHtml(time(item.dueAt))}</span>
        <span>Updated ${escapeHtml(time(item.updatedAt))}</span>
      </div>
    </article>
  </li>`;
}

export function renderInspectorIndex(snapshot: InspectorIndex): string {
  const statuses = ["open", "in_progress", "blocked", "done", "cancelled"];
  const query = snapshot.filter.query ?? "";
  const options = [
    `<option value="">All statuses</option>`,
    ...statuses.map((value) => `<option value="${value}"${snapshot.filter.status === value ? " selected" : ""}>${value}</option>`),
  ].join("");
  const result = snapshot.items.length === 0
    ? empty(query || snapshot.filter.status ? "No commitments match this filter." : "No commitments exist in this workspace.")
    : `<ol class="commitment-list">${snapshot.items.map(indexItem).join("")}</ol>`;
  const truncation = snapshot.truncated
    ? `<p class="notice">Showing ${snapshot.items.length} of ${snapshot.matched}. Narrow the filter to inspect omitted commitments.</p>`
    : `<p class="result-count">${snapshot.matched} commitment${snapshot.matched === 1 ? "" : "s"}</p>`;

  return shell("Commitments", snapshot.workspaceId, `<main id="content" class="layout index-layout">
    <section class="intro" aria-labelledby="page-title">
      <p class="kicker">Canonical coordination state</p>
      <h1 id="page-title">Find the graph that needs inspection.</h1>
      <p>Choose a commitment, then audit waits, effects, authority, receipts and ordered events in one read.</p>
    </section>
    <form class="filters" method="get" action="/inspector" role="search">
      <div class="field grow">
        <label for="query">Title contains</label>
        <input id="query" name="q" value="${escapeHtml(query)}" maxlength="200" autocomplete="off">
      </div>
      <div class="field">
        <label for="status">Status</label>
        <select id="status" name="status">${options}</select>
      </div>
      <div class="field limit-field">
        <label for="limit">Limit</label>
        <input id="limit" name="limit" value="${snapshot.filter.limit}" inputmode="numeric" pattern="[0-9]+">
      </div>
      <button type="submit">Apply filter</button>
    </form>
    <section class="results" aria-labelledby="results-title">
      <div class="section-heading">
        <h2 id="results-title">Commitments</h2>
        ${truncation}
      </div>
      ${result}
    </section>
    <footer class="snapshot-footer">
      <span>Snapshot ${escapeHtml(time(snapshot.inspectedAt))}</span>
      <a href="/api/index${query || snapshot.filter.status ? `?${new URLSearchParams({
        ...(query ? { q: query } : {}),
        ...(snapshot.filter.status ? { status: snapshot.filter.status } : {}),
        limit: String(snapshot.filter.limit),
      }).toString()}` : ""}">Canonical index JSON</a>
    </footer>
  </main>`);
}

function definitionRows(rows: Array<[string, unknown]>): string {
  return `<dl class="definition-list">${rows.map(([label, value]) =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${value == null ? "None" : escapeHtml(value)}</dd></div>`
  ).join("")}</dl>`;
}

function waitsSection(snapshot: CommitmentInspection): string {
  if (snapshot.conditions.length === 0) return empty("No wait conditions are attached to this commitment.");
  const observationById = new Map(snapshot.observations.map((item) => [item.id, item]));
  return `<ol class="record-stack">${snapshot.conditions.map((condition) => {
    const reconciliations = snapshot.reconciliations.filter((item) => item.conditionId === condition.id);
    return `<li class="record">
      <header><div><p class="record-kind">Wait condition</p><h3>${identifier(condition.id)}</h3></div>${status(condition.status)}</header>
      ${definitionRows([
        ["Type", `${condition.type.uri}@${condition.type.schemaVersion}`],
        ["Evaluator", `${condition.evaluator.uri}@${condition.evaluator.version}`],
        ["Not before", time(condition.notBefore)],
        ["Deadline", time(condition.deadlineAt)],
      ])}
      ${jsonDetails("Parameters", condition.parameters)}
      <div class="nested-records">
        <h4>Reconciliations</h4>
        ${reconciliations.length === 0 ? empty("No observation has been reconciled with this condition.") : reconciliations.map((item) => {
          const observation = observationById.get(item.observationId);
          return `<article class="nested-record">
            <div class="nested-heading"><strong>${escapeHtml(item.decision)} / ${escapeHtml(item.effect)}</strong><time>${escapeHtml(time(item.reconciledAt))}</time></div>
            <p>${escapeHtml(item.explanation)}</p>
            ${definitionRows([
              ["Reconciliation", item.id],
              ["Observation", item.observationId],
              ["Observation type", observation ? `${observation.type.uri}@${observation.type.schemaVersion}` : "Unavailable"],
              ["Reason", item.reasonCode],
            ])}
            ${observation ? jsonDetails("Observation payload", observation.payload) : ""}
          </article>`;
        }).join("")}
      </div>
    </li>`;
  }).join("")}</ol>`;
}

function effectsSection(snapshot: CommitmentInspection): string {
  if (snapshot.effects.length === 0) return empty("No external effect has been proposed for this commitment.");
  return `<ol class="record-stack">${snapshot.effects.map((effect) => {
    const approvals = snapshot.effectApprovals.filter((item) => item.effectId === effect.id);
    const receipts = snapshot.effectReceipts.filter((item) => item.effectId === effect.id);
    return `<li class="record effect-record">
      <header><div><p class="record-kind">External effect</p><h3>${identifier(effect.id)}</h3></div>${status(effect.status)}</header>
      ${definitionRows([
        ["Type", `${effect.type.uri}@${effect.type.schemaVersion}`],
        ["Request digest", effect.requestDigest],
        ["Connector", `${effect.connector.operationUri}@${effect.connector.operationVersion}`],
        ["Revision", effect.revision],
      ])}
      ${jsonDetails("Canonical request", effect.request)}
      <div class="split-records">
        <section><h4>Authority history</h4>
          ${approvals.length === 0 ? empty("No authority decision exists.") : approvals.map((approval) =>
            `<article class="nested-record"><div class="nested-heading"><strong>${escapeHtml(approval.decision)}</strong><time>${escapeHtml(time(approval.decidedAt))}</time></div>
              ${definitionRows([
                ["Approval", approval.id],
                ["Approver", approval.approverPrincipalId],
                ["Verification", `${approval.verificationLevel}:${approval.verificationMethod}`],
                ["Expires", time(approval.expiresAt)],
              ])}
              ${jsonDetails("Scope and limits", { scope: approval.scope, limits: approval.limits })}
            </article>`).join("")}
        </section>
        <section><h4>Provider receipts</h4>
          ${receipts.length === 0 ? empty("No provider receipt exists.") : receipts.map((receipt) =>
            `<article class="nested-record"><div class="nested-heading"><strong>${escapeHtml(receipt.outcome)}</strong><time>${escapeHtml(time(receipt.recordedAt))}</time></div>
              ${definitionRows([
                ["Receipt", receipt.id],
                ["External receipt", receipt.externalReceiptId],
                ["Digest", receipt.receiptDigest],
                ["Evidence", receipt.evidenceId],
              ])}
              ${jsonDetails("Verified report", receipt.report)}
            </article>`).join("")}
        </section>
      </div>
    </li>`;
  }).join("")}</ol>`;
}

function executionSection(snapshot: CommitmentInspection): string {
  const groups: Array<[string, Array<Record<string, unknown>>, string]> = [
    ["Claims", snapshot.claims, "No claim history."],
    ["Attempts", snapshot.attempts, "No execution attempts."],
    ["Evidence", snapshot.evidence, "No evidence records."],
    ["Resolution contracts", snapshot.resolutionContracts, "No completion resolution contract."],
    ["Evidence trust", snapshot.evidenceTrustRecords, "No evidence trust records."],
    ["Completion proposals", snapshot.completionProposals, "No completion proposals."],
    ["Completion challenges", snapshot.completionChallenges, "No completion challenges."],
    ["Validation decisions", snapshot.validationDecisions, "No validation decisions."],
    ["Completion records", snapshot.completionRecords, "No completion records."],
  ];
  return `<div class="execution-grid">${groups.map(([label, records, message]) =>
    `<section><h3>${escapeHtml(label)} <span>${records.length}</span></h3>${records.length === 0 ? empty(message) :
      `<ol>${records.map((record) => `<li>${identifier(String(record.id ?? "unknown"))}${
        record.status ? status(String(record.status)) : ""
      }${jsonDetails("Record details", record)}</li>`).join("")}</ol>`}</section>`
  ).join("")}</div>`;
}

function contextSection(snapshot: CommitmentInspection): string {
  if (snapshot.externalContextLinks.length === 0) {
    return empty("No reusable external context pointer is attached.");
  }
  return `<ol class="context-list">${snapshot.externalContextLinks.map((link) => `<li>
    <div><strong>${escapeHtml(link.target.resourceType)}</strong> ${status(link.state)}</div>
    ${definitionRows([
      ["System", link.target.system],
      ["External ID", link.target.externalId],
      ["Binding", link.binding],
      ["Version", link.target.version],
      ["Digest", link.target.digest],
      ["Recorded", time(link.createdAt)],
    ])}
  </li>`).join("")}</ol>`;
}

function auditSection(snapshot: CommitmentInspection): string {
  if (snapshot.events.length === 0) return empty("No task-scoped audit events.");
  return `<div class="table-scroll"><table>
    <caption>Ordered task-scoped events</caption>
    <thead><tr><th scope="col">Sequence</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">Recorded</th><th scope="col">Payload</th></tr></thead>
    <tbody>${snapshot.events.map((event) => `<tr>
      <td class="number">${event.sequence}</td>
      <td><strong>${escapeHtml(event.eventType)}</strong><br>${identifier(event.id)}</td>
      <td>${escapeHtml(event.actorAlias)}</td>
      <td><time>${escapeHtml(time(event.createdAt))}</time></td>
      <td>${jsonDetails("Inspect payload", event.payload)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

export function renderCommitmentPage(snapshot: CommitmentInspection): string {
  const commitment = snapshot.commitment;
  return shell(commitment.title, snapshot.workspaceId, `<main id="content" class="layout detail-layout">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="/inspector">Commitments</a><span>/</span><span aria-current="page">Inspection</span></nav>
    <header class="detail-header">
      <div>
        <div class="row-heading">${status(commitment.status)}<span class="revision">revision ${commitment.revision}</span></div>
        <h1>${escapeHtml(commitment.title)}</h1>
        <p class="full-id">${identifier(commitment.id)}</p>
        ${commitment.description ? `<p class="description">${escapeHtml(commitment.description)}</p>` : ""}
      </div>
      <dl class="header-facts">
        <div><dt>Completion policy</dt><dd>${escapeHtml(commitment.completionPolicy)}</dd></div>
        <div><dt>Priority</dt><dd>${commitment.priority ?? "None"}</dd></div>
        <div><dt>Due</dt><dd>${escapeHtml(time(commitment.dueAt))}</dd></div>
        <div><dt>Updated</dt><dd>${escapeHtml(time(commitment.updatedAt))}</dd></div>
      </dl>
    </header>
    <nav class="section-nav" aria-label="Inspection sections">
      <a href="#waits">Waits and facts <span>${snapshot.conditions.length}</span></a>
      <a href="#effects">Effects and authority <span>${snapshot.effects.length}</span></a>
      <a href="#execution">Execution and proof <span>${snapshot.attempts.length}</span></a>
      <a href="#context">External context <span>${snapshot.externalContextLinks.length}</span></a>
      <a href="#audit">Audit <span>${snapshot.events.length}</span></a>
    </nav>
    <section id="waits" class="detail-section"><div class="section-heading"><h2>Waits and facts</h2><p>Condition, observation and reconciliation stay distinct.</p></div>${waitsSection(snapshot)}</section>
    <section id="effects" class="detail-section"><div class="section-heading"><h2>Effects and authority</h2><p>Intent, permission and provider outcome are separate records.</p></div>${effectsSection(snapshot)}</section>
    <section id="execution" class="detail-section"><div class="section-heading"><h2>Execution and proof</h2><p>A successful attempt does not complete the commitment.</p></div>${executionSection(snapshot)}</section>
    <section id="context" class="detail-section"><div class="section-heading"><h2>External context</h2><p>Pointers are actor-provided data. They grant no access or authority.</p></div>${contextSection(snapshot)}</section>
    <section id="audit" class="detail-section"><div class="section-heading"><h2>Ordered audit</h2><p>Resume after event sequence ${snapshot.resumeCursor.afterEventSequence}.</p></div>${auditSection(snapshot)}</section>
    <footer class="snapshot-footer">
      <span>Snapshot ${escapeHtml(time(snapshot.inspectedAt))}</span>
      <a href="/api/commitments/${encodeURIComponent(commitment.id)}">Canonical graph JSON</a>
    </footer>
  </main>`);
}

export function renderInspectorError(statusCode: number, message: string): string {
  return shell(`Error ${statusCode}`, null, `<main id="content" class="layout error-layout">
    <p class="kicker">Inspector response ${statusCode}</p>
    <h1>This read could not be completed.</h1>
    <p>${escapeHtml(message)}</p>
    <a class="button-link" href="/">Return to commitments</a>
  </main>`);
}

export const INSPECTOR_CSS = `
:root {
  color-scheme: light dark;
  --canvas: #f6f8fa;
  --surface: #fbfcfd;
  --surface-muted: #eef1f4;
  --border: #d0d7de;
  --border-strong: #afb8c1;
  --text: #1f2328;
  --muted: #59636e;
  --accent: #0969da;
  --accent-contrast: #f7f9fb;
  --focus: #0969da;
  --success: #1a7f37;
  --warning: #9a6700;
  --danger: #cf222e;
  --radius: 8px;
  --mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0d1117;
    --surface: #161b22;
    --surface-muted: #21262d;
    --border: #30363d;
    --border-strong: #484f58;
    --text: #e6edf3;
    --muted: #9da7b1;
    --accent: #58a6ff;
    --accent-contrast: #0d1117;
    --focus: #58a6ff;
    --success: #3fb950;
    --warning: #d29922;
    --danger: #f85149;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: auto; }
body { margin: 0; min-width: 320px; background: var(--canvas); color: var(--text); font: 15px/1.55 var(--sans); }
a { color: var(--accent); text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible {
  outline: 3px solid var(--focus); outline-offset: 2px;
}
code, pre, .identity, .full-id, .number { font-family: var(--mono); }
code { overflow-wrap: anywhere; }
h1, h2, h3, h4, p { margin-top: 0; }
h1 { max-width: 24ch; font-size: clamp(2rem, 4vw, 3.4rem); line-height: 1.05; letter-spacing: -0.04em; }
h2 { font-size: 1.35rem; letter-spacing: -0.015em; }
h3 { margin: 0; font-size: 1rem; }
.skip-link { position: fixed; left: 12px; top: 12px; transform: translateY(-180%); padding: 10px 14px; background: var(--accent); color: var(--accent-contrast); border-radius: var(--radius); z-index: 2; }
.skip-link:focus { transform: translateY(0); }
.site-header { min-height: 64px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 24px; padding: 12px clamp(18px, 4vw, 56px); border-bottom: 1px solid var(--border); background: var(--surface); }
.brand { color: var(--text); font: 700 1rem/1 var(--mono); text-decoration: none; }
.brand span { color: var(--muted); font-weight: 500; }
.workspace, .read-only { margin: 0; color: var(--muted); font-size: .82rem; }
.read-only { text-align: right; }
.layout { width: min(1400px, calc(100% - 36px)); margin: 0 auto; }
.index-layout { padding: clamp(48px, 8vw, 104px) 0 36px; }
.intro { max-width: 760px; margin-bottom: 42px; }
.intro > p:last-child, .description { max-width: 68ch; color: var(--muted); font-size: 1.05rem; }
.kicker, .record-kind { margin-bottom: 10px; color: var(--muted); font: 700 .72rem/1.2 var(--mono); letter-spacing: .09em; text-transform: uppercase; }
.filters { display: grid; grid-template-columns: minmax(220px, 1fr) 190px 92px auto; gap: 14px; align-items: end; padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.field { display: grid; gap: 6px; }
label { color: var(--muted); font-size: .78rem; font-weight: 650; }
input, select, button { min-height: 42px; border: 1px solid var(--border-strong); border-radius: var(--radius); font: inherit; }
input, select { width: 100%; padding: 8px 11px; background: var(--canvas); color: var(--text); }
button, .button-link { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 8px 18px; background: var(--accent); color: var(--accent-contrast); border-color: var(--accent); font-weight: 700; text-decoration: none; cursor: pointer; }
button:active, .button-link:active { transform: translateY(1px); }
.results { margin-top: 40px; }
.section-heading { display: flex; justify-content: space-between; gap: 24px; align-items: baseline; margin-bottom: 16px; }
.section-heading h2, .section-heading p { margin: 0; }
.section-heading p, .result-count, .notice { color: var(--muted); font-size: .84rem; }
.notice { color: var(--warning); }
.commitment-list, .record-stack, .context-list, .execution-grid ol { padding: 0; margin: 0; list-style: none; }
.commitment-row { border-top: 1px solid var(--border); }
.commitment-row:last-child { border-bottom: 1px solid var(--border); }
.commitment-row article { display: grid; grid-template-columns: minmax(260px, 1.4fr) minmax(360px, 1fr); gap: 18px 36px; padding: 24px 0; }
.commitment-main h2 { margin: 7px 0 5px; font-size: 1.18rem; }
.commitment-main h2 a { color: var(--text); }
.row-heading { display: flex; align-items: center; gap: 10px; }
.revision, .identity, .row-meta, .full-id { color: var(--muted); font-size: .76rem; }
.identity { margin: 0; }
.status { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 8px; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--muted); font: 700 .69rem/1 var(--mono); text-transform: uppercase; }
.status[data-status="open"], .status[data-status="active"], .status[data-status="approved"], .status[data-status="committed"], .status[data-status="satisfied"] { color: var(--success); border-color: color-mix(in srgb, var(--success) 55%, var(--border)); }
.status[data-status="blocked"], .status[data-status="waiting"], .status[data-status="indeterminate"], .status[data-status="proposed"], .status[data-status="authorized"] { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 55%, var(--border)); }
.status[data-status="cancelled"], .status[data-status="failed"], .status[data-status="denied"], .status[data-status="revoked"], .status[data-status="detached"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, var(--border)); }
.signal-grid { display: grid; grid-template-columns: repeat(4, minmax(74px, 1fr)); gap: 1px; margin: 0; background: var(--border); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.signal-grid div { padding: 10px; background: var(--surface); }
.signal-grid dt { color: var(--muted); font-size: .68rem; line-height: 1.25; }
.signal-grid dd { margin: 4px 0 0; font: 700 1.15rem/1 var(--mono); }
.signal-grid dd span { color: var(--muted); font-size: .72rem; font-weight: 500; }
.row-meta { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px 24px; }
.snapshot-footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 36px; padding: 20px 0 0; border-top: 1px solid var(--border); color: var(--muted); font-size: .78rem; }
.empty { margin: 0; padding: 20px; background: var(--surface-muted); border-radius: var(--radius); color: var(--muted); }
.detail-layout { padding: 28px 0 40px; }
.breadcrumb { display: flex; gap: 9px; margin-bottom: 44px; color: var(--muted); font-size: .82rem; }
.detail-header { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(280px, .7fr); gap: 44px; align-items: end; padding-bottom: 34px; }
.detail-header h1 { margin: 12px 0; }
.full-id { margin-bottom: 18px; }
.header-facts { display: grid; grid-template-columns: 1fr 1fr; margin: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.header-facts div { min-height: 78px; padding: 13px; background: var(--surface); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.header-facts div:nth-child(2n) { border-right: 0; }
.header-facts div:nth-last-child(-n+2) { border-bottom: 0; }
.header-facts dt, .definition-list dt { color: var(--muted); font-size: .7rem; }
.header-facts dd { margin: 5px 0 0; font: 650 .82rem/1.35 var(--mono); overflow-wrap: anywhere; }
.section-nav { display: grid; grid-template-columns: repeat(5, 1fr); margin-bottom: 54px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.section-nav a { display: flex; justify-content: space-between; gap: 8px; padding: 12px; border-right: 1px solid var(--border); color: var(--text); background: var(--surface); font-size: .78rem; text-decoration: none; }
.section-nav a:last-child { border-right: 0; }
.section-nav a:hover { background: var(--surface-muted); }
.section-nav span, .execution-grid h3 span { color: var(--muted); font-family: var(--mono); }
.detail-section { scroll-margin-top: 18px; padding: 38px 0 54px; border-top: 1px solid var(--border-strong); }
.record-stack { display: grid; gap: 20px; }
.record { padding: clamp(18px, 3vw, 28px); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.record > header { display: flex; justify-content: space-between; gap: 18px; align-items: start; margin-bottom: 20px; }
.record-kind { margin-bottom: 7px; }
.definition-list { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 0 0 16px; }
.definition-list div { min-width: 0; padding: 10px 0; }
.definition-list dd { margin: 4px 0 0; font: 600 .75rem/1.4 var(--mono); overflow-wrap: anywhere; }
.payload { margin-top: 10px; }
.payload summary { width: fit-content; color: var(--accent); cursor: pointer; font-size: .78rem; }
.payload pre { max-height: 360px; overflow: auto; margin: 10px 0 0; padding: 14px; background: var(--canvas); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: .72rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.nested-records { margin-top: 24px; }
.nested-records h4, .split-records h4 { margin-bottom: 12px; font-size: .82rem; }
.nested-record { margin-top: 10px; padding: 14px; background: var(--surface-muted); border-radius: var(--radius); }
.nested-heading { display: flex; justify-content: space-between; gap: 14px; margin-bottom: 9px; }
.nested-heading time { color: var(--muted); font: .68rem/1.4 var(--mono); }
.nested-record > p { color: var(--muted); }
.nested-record .definition-list { grid-template-columns: 1fr 1fr; margin-bottom: 0; }
.split-records { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 24px; }
.execution-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.execution-grid > section { min-width: 0; padding: 18px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.execution-grid h3 { display: flex; justify-content: space-between; }
.execution-grid li { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.execution-grid li:last-child { border-bottom: 0; }
.execution-grid li .payload { flex-basis: 100%; }
.context-list { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.context-list > li { padding: 18px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.context-list > li > div:first-child { display: flex; justify-content: space-between; gap: 12px; }
.context-list .definition-list { grid-template-columns: 1fr 1fr; margin: 12px 0 0; }
.table-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }
table { width: 100%; min-width: 880px; border-collapse: collapse; background: var(--surface); }
caption { padding: 12px 14px; color: var(--muted); text-align: left; font-size: .72rem; }
th, td { padding: 12px 14px; border-top: 1px solid var(--border); text-align: left; vertical-align: top; }
th { color: var(--muted); font-size: .68rem; }
td { font-size: .76rem; }
td .payload { margin: 0; }
.error-layout { max-width: 720px; padding: 12vh 0; }
.error-layout p:not(.kicker) { max-width: 62ch; color: var(--muted); }
.button-link { margin-top: 14px; border-radius: var(--radius); }
@media (max-width: 900px) {
  .site-header { grid-template-columns: 1fr auto; }
  .workspace { grid-column: 1 / -1; grid-row: 2; }
  .read-only { grid-column: 2; grid-row: 1; }
  .filters { grid-template-columns: 1fr 1fr; }
  .filters .grow { grid-column: 1 / -1; }
  .commitment-row article, .detail-header { grid-template-columns: 1fr; }
  .section-nav { grid-template-columns: 1fr 1fr; }
  .section-nav a { border-bottom: 1px solid var(--border); }
  .definition-list { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 640px) {
  .site-header { padding: 12px 18px; }
  .layout { width: min(100% - 28px, 1400px); }
  .index-layout { padding-top: 42px; }
  .filters, .signal-grid, .split-records, .execution-grid, .context-list { grid-template-columns: 1fr; }
  .filters .grow { grid-column: auto; }
  .signal-grid { gap: 0; }
  .signal-grid div { border-bottom: 1px solid var(--border); }
  .signal-grid div:last-child { border-bottom: 0; }
  .section-heading, .snapshot-footer { align-items: start; flex-direction: column; }
  .section-nav { grid-template-columns: 1fr; }
  .section-nav a { border-right: 0; }
  .detail-header { gap: 28px; }
  .header-facts, .definition-list, .nested-record .definition-list, .context-list .definition-list { grid-template-columns: 1fr; }
  .header-facts div { border-right: 0; }
  .header-facts div:nth-last-child(-n+2) { border-bottom: 1px solid var(--border); }
  .header-facts div:last-child { border-bottom: 0; }
  .nested-heading { flex-direction: column; }
}
`;
