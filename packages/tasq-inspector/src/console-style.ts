export const CONSOLE_CSS = `
:root {
  color-scheme: light dark;
  --canvas: #f6f8fa;
  --surface: #fbfcfe;
  --surface-subtle: #eef2f6;
  --surface-raised: #f9fbfc;
  --border: #c8d1dc;
  --border-strong: #8c99a8;
  --text: #17212b;
  --muted: #526170;
  --accent: #075fb8;
  --accent-hover: #064f98;
  --accent-contrast: #f8fbff;
  --success: #17713a;
  --warning: #8a5900;
  --danger: #b4232f;
  --focus: #0969da;
  --radius: 8px;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0b1118;
    --surface: #111a24;
    --surface-subtle: #192532;
    --surface-raised: #141f2b;
    --border: #344353;
    --border-strong: #617185;
    --text: #e8eef5;
    --muted: #a2afbd;
    --accent: #6eb5ff;
    --accent-hover: #91c7ff;
    --accent-contrast: #07111c;
    --success: #5bcd7e;
    --warning: #f0b84d;
    --danger: #ff7b86;
    --focus: #7dc0ff;
  }
}
* { box-sizing: border-box; }
html { min-width: 320px; }
body { margin: 0; background: var(--canvas); color: var(--text); font: 15px/1.55 var(--sans); }
button, input, select { font: inherit; }
button, a, input, select { touch-action: manipulation; }
a { color: var(--accent); text-underline-offset: 3px; }
a:hover { color: var(--accent-hover); }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, pre:focus-visible {
  outline: 3px solid var(--focus); outline-offset: 2px;
}
button { cursor: pointer; }
button:active, .secondary-action:active { transform: translateY(1px); }
[hidden] { display: none !important; }
code, time, .numeric, .metric-strip dd, .timeline-sequence { font-family: var(--mono); font-variant-numeric: tabular-nums; }
code { overflow-wrap: anywhere; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: clamp(1.75rem, 3vw, 2.6rem); line-height: 1.1; letter-spacing: -.035em; }
h2 { margin-bottom: 4px; font-size: 1.05rem; letter-spacing: -.01em; }
h3 { margin-bottom: 4px; font-size: .95rem; }
.skip-link { position: fixed; top: 10px; left: 12px; z-index: 20; transform: translateY(-160%); padding: 10px 14px; border-radius: var(--radius); background: var(--accent); color: var(--accent-contrast); font-weight: 700; }
.skip-link:focus { transform: translateY(0); }
.console-header { position: sticky; top: 0; z-index: 10; min-height: 64px; display: grid; grid-template-columns: 220px minmax(0, 1fr) auto; align-items: center; gap: 24px; padding: 10px 24px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(12px); }
.brand { color: var(--text); font: 700 1rem/1 var(--mono); text-decoration: none; }
.brand span { color: var(--muted); font-weight: 500; }
.workspace-label { min-width: 0; display: flex; align-items: center; gap: 10px; margin: 0; color: var(--muted); font-size: .78rem; }
.workspace-label code { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.connection-group { display: flex; align-items: center; justify-content: end; gap: 10px; }
.live-status { display: inline-flex; min-height: 32px; align-items: center; padding: 4px 9px; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--muted); font-size: .75rem; font-weight: 700; }
.live-status[data-state="connected"] { color: var(--success); border-color: color-mix(in srgb, var(--success) 60%, var(--border)); }
.live-status[data-state="stale"], .live-status[data-state="catching-up"] { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 60%, var(--border)); }
.live-status[data-state="disconnected"], .live-status[data-state="gap"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 60%, var(--border)); }
.quiet-action { min-height: 36px; padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); font-size: .76rem; font-weight: 650; }
.console-layout { width: min(1600px, 100%); min-height: calc(100dvh - 64px); margin: 0 auto; display: grid; grid-template-columns: 220px minmax(0, 1fr); }
.sidebar { padding: 22px 16px; border-right: 1px solid var(--border); background: var(--surface-raised); }
.sidebar nav { display: grid; gap: 4px; }
.sidebar nav a { min-height: 44px; display: flex; align-items: center; padding: 9px 12px; border-radius: var(--radius); color: var(--muted); font-weight: 650; text-decoration: none; }
.sidebar nav a:hover { background: var(--surface-subtle); color: var(--text); }
.sidebar nav a[aria-current="page"] { background: color-mix(in srgb, var(--accent) 13%, var(--surface)); color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
.sidebar-boundary { margin-top: 28px; padding: 14px 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: .76rem; }
.sidebar-boundary strong { color: var(--text); }
.sidebar-boundary p { margin: 5px 0 0; }
.console-main { min-width: 0; width: min(1280px, 100%); padding: 36px clamp(20px, 4vw, 56px) 28px; }
.page-header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 26px; }
.page-header > p { margin: 0; color: var(--muted); font-size: .75rem; }
.context-label { margin-bottom: 6px; color: var(--muted); font-size: .75rem; font-weight: 700; }
.attention-panel { display: grid; grid-template-columns: minmax(240px, .7fr) minmax(300px, 1.3fr); gap: 24px; align-items: start; padding: 18px 20px; border: 1px solid var(--border); border-left: 4px solid var(--success); border-radius: var(--radius); background: var(--surface); }
.attention-panel[data-attention="true"] { border-left-color: var(--warning); }
.attention-panel p { margin-bottom: 0; color: var(--muted); font-size: .82rem; }
.attention-panel ul { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; list-style: none; }
.attention-panel li { padding: 5px 8px; border: 1px solid color-mix(in srgb, var(--warning) 60%, var(--border)); border-radius: var(--radius); color: var(--warning); font-size: .75rem; font-weight: 700; }
.attention-clear { color: var(--success) !important; font-weight: 700; }
.metric-strip { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin: 22px 0 34px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.metric-strip div { min-width: 0; padding: 14px; border-right: 1px solid var(--border); }
.metric-strip div:last-child { border-right: 0; }
.metric-strip dt { color: var(--muted); font-size: .7rem; }
.metric-strip dd { margin: 7px 0 4px; font-size: 1.45rem; font-weight: 700; line-height: 1; }
.metric-strip p { margin: 0; color: var(--muted); font-size: .72rem; }
.records-section { min-width: 0; }
.records-header { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 14px; }
.records-header p { margin: 0; color: var(--muted); font-size: .78rem; }
.secondary-action { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; padding: 8px 13px; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text); background: var(--surface); font-size: .78rem; font-weight: 700; text-decoration: none; white-space: nowrap; }
.filter-bar { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(150px, 220px) auto; gap: 12px; align-items: end; padding: 14px; border: 1px solid var(--border); border-bottom: 0; border-radius: var(--radius) var(--radius) 0 0; background: var(--surface-subtle); }
.filter-bar > div { display: grid; gap: 5px; }
.filter-bar label { color: var(--muted); font-size: .7rem; font-weight: 700; }
.filter-bar input, .filter-bar select { width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); color: var(--text); }
.filter-bar p { margin: 0 0 11px; color: var(--muted); font-size: .72rem; white-space: nowrap; }
.data-table { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); background: var(--surface); }
.data-table table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.data-table th, .data-table td { padding: 12px 13px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.data-table th { color: var(--muted); background: var(--surface-raised); font-size: .72rem; font-weight: 700; }
.data-table td { font-size: .76rem; }
.data-table th:first-child { width: 30%; }
.data-table tr:last-child td { border-bottom: 0; }
.data-table tbody tr:hover { background: color-mix(in srgb, var(--accent) 5%, var(--surface)); }
.data-table strong, .record-link { display: block; margin-bottom: 4px; color: var(--text); font-size: .82rem; font-weight: 700; }
.data-table code { display: block; color: var(--muted); font-size: .7rem; }
.state-badge { display: inline-flex; min-height: 24px; align-items: center; padding: 3px 7px; border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--muted); font: 700 .68rem/1.2 var(--mono); text-transform: uppercase; }
.state-badge[data-state="active"], .state-badge[data-state="enabled"], .state-badge[data-state="open"], .state-badge[data-state="satisfied"], .state-badge[data-state="committed"] { color: var(--success); border-color: color-mix(in srgb, var(--success) 60%, var(--border)); }
.state-badge[data-state="expired"], .state-badge[data-state="overdue"], .state-badge[data-state="waiting"], .state-badge[data-state="blocked"], .state-badge[data-state="proposed"], .state-badge[data-state="authorized"], .state-badge[data-state="indeterminate"] { color: var(--warning); border-color: color-mix(in srgb, var(--warning) 60%, var(--border)); }
.state-badge[data-state="disabled"], .state-badge[data-state="failed"], .state-badge[data-state="cancelled"], .state-badge[data-state="denied"], .state-badge[data-state="revoked"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 60%, var(--border)); }
.empty-state { padding: 34px 20px; border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); background: var(--surface); text-align: center; }
.empty-state p { margin-bottom: 0; color: var(--muted); }
.audit-timeline { margin: 0; padding: 4px 0; list-style: none; border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); background: var(--surface); }
.audit-timeline > li { position: relative; display: grid; grid-template-columns: 66px minmax(0, 1fr); gap: 14px; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.audit-timeline > li:last-child { border-bottom: 0; }
.timeline-sequence { align-self: start; color: var(--muted); font-size: .72rem; }
.audit-timeline article header { display: flex; justify-content: space-between; gap: 16px; }
.audit-timeline article header time { color: var(--muted); font-size: .72rem; }
.audit-timeline article p { margin: 7px 0; color: var(--muted); font-size: .75rem; }
.audit-timeline dl { display: flex; flex-wrap: wrap; gap: 10px 28px; margin: 10px 0 0; }
.audit-timeline dl div { display: flex; gap: 7px; }
.audit-timeline dt { color: var(--muted); font-size: .7rem; }
.audit-timeline dd { margin: 0; font-size: .7rem; }
.redaction-note { font-style: italic; }
.integrity-panel, .support-panel { display: grid; grid-template-columns: minmax(240px, .8fr) minmax(320px, 1.2fr); gap: 24px; align-items: start; margin-top: 28px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.integrity-panel p, .support-panel p { margin-bottom: 0; color: var(--muted); font-size: .8rem; }
.integrity-panel > code { display: block; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--canvas); font-size: .74rem; }
.support-actions { display: flex; flex-wrap: wrap; gap: 10px; }
.support-actions button { min-height: 44px; padding: 8px 14px; border: 1px solid var(--accent); border-radius: var(--radius); background: var(--accent); color: var(--accent-contrast); font-weight: 700; }
.support-preview, .inline-error { grid-column: 1 / -1; }
.support-preview { min-width: 0; }
.support-preview pre { max-height: 440px; overflow: auto; margin: 12px 0 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--canvas); color: var(--text); font: .7rem/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.inline-error { margin: 0; padding: 10px 12px; border-left: 4px solid var(--danger); background: color-mix(in srgb, var(--danger) 9%, var(--surface)); color: var(--danger) !important; }
.console-footer { display: flex; flex-wrap: wrap; gap: 10px 24px; margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--border); color: var(--muted); font-size: .72rem; }
@media (max-width: 1100px) {
  .metric-strip { grid-template-columns: repeat(3, 1fr); }
  .metric-strip div { border-bottom: 1px solid var(--border); }
  .metric-strip div:nth-child(3n) { border-right: 0; }
  .metric-strip div:nth-last-child(-n+3) { border-bottom: 0; }
}
@media (max-width: 820px) {
  .console-header { grid-template-columns: 1fr auto; padding: 10px 16px; }
  .workspace-label { grid-column: 1 / -1; grid-row: 2; }
  .console-layout { grid-template-columns: 1fr; }
  .sidebar { padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--border); }
  .sidebar nav { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .sidebar nav a { justify-content: center; text-align: center; }
  .sidebar nav a[aria-current="page"] { box-shadow: inset 0 -3px 0 var(--accent); }
  .sidebar-boundary { display: none; }
  .console-main { padding-top: 26px; }
  .attention-panel, .integrity-panel, .support-panel { grid-template-columns: 1fr; }
  .support-preview, .inline-error { grid-column: auto; }
  .filter-bar { grid-template-columns: 1fr 180px; }
  .filter-bar p { grid-column: 1 / -1; margin: 0; }
}
@media (max-width: 640px) {
  body { font-size: 16px; }
  .console-header { position: static; }
  .connection-group { gap: 6px; }
  .quiet-action { max-width: 132px; white-space: normal; line-height: 1.2; }
  .sidebar nav { grid-template-columns: repeat(2, 1fr); }
  .console-main { padding: 24px 14px; }
  .page-header, .records-header { align-items: start; flex-direction: column; }
  .attention-panel { gap: 14px; }
  .metric-strip { grid-template-columns: repeat(2, 1fr); }
  .metric-strip div:nth-child(3n) { border-right: 1px solid var(--border); }
  .metric-strip div:nth-child(2n) { border-right: 0; }
  .metric-strip div:nth-last-child(-n+3) { border-bottom: 1px solid var(--border); }
  .metric-strip div:nth-last-child(-n+2) { border-bottom: 0; }
  .filter-bar { grid-template-columns: 1fr; border-bottom: 1px solid var(--border); border-radius: var(--radius); }
  .filter-bar p { grid-column: auto; }
  .data-table { margin-top: 12px; border-radius: var(--radius); }
  .data-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .data-table table, .data-table tbody, .data-table tr, .data-table td { display: block; width: 100%; }
  .data-table tr { padding: 8px 12px; border-bottom: 1px solid var(--border); }
  .data-table tr:last-child { border-bottom: 0; }
  .data-table td { display: grid; grid-template-columns: minmax(92px, .38fr) minmax(0, 1fr); gap: 10px; padding: 8px 0; border: 0; font-size: .8rem; }
  .data-table td::before { content: attr(data-label); color: var(--muted); font-size: .7rem; font-weight: 700; }
  .audit-timeline { margin-top: 12px; border-radius: var(--radius); }
  .audit-timeline > li { grid-template-columns: 1fr; gap: 5px; padding: 14px; }
  .audit-timeline article header { align-items: start; flex-direction: column; gap: 5px; }
  .integrity-panel, .support-panel { gap: 14px; }
  .support-actions { display: grid; }
  .secondary-action, .support-actions button { width: 100%; white-space: normal; text-align: center; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
}
@media (prefers-reduced-transparency: reduce) {
  .console-header { background: var(--surface); backdrop-filter: none; }
}
`;
