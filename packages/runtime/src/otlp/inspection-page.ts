import { otlpPaths } from "./config.js";
import type { InspectionSession, InspectionView } from "./inspection-view.js";

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

const numberFormat = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  timeZoneName: "short",
});

function stamp(timestamp: number): string {
  return escapeHtml(dateFormat.format(new Date(timestamp)));
}

function tokens(value: string | undefined): string {
  return value === undefined ? "&mdash;" : escapeHtml(numberFormat.format(BigInt(value)));
}

function serviceLabel(session: InspectionSession): string {
  return session.service === "claude-code" ? "Claude Code" : session.service;
}

function sessionHref(session: InspectionSession): string {
  return `${otlpPaths.inspector}?session=${encodeURIComponent(session.key)}`;
}

function shortId(nativeSessionId: string | undefined): string {
  if (nativeSessionId === undefined) return "Uncorrelated evidence";
  return nativeSessionId.length > 14 ? `${nativeSessionId.slice(0, 14)}…` : nativeSessionId;
}

const styles = `
  :root {
    color-scheme: dark;
    --bg: #111113;
    --panel: #18181b;
    --rule: #303036;
    --accent: #e4b648;
    --accent-dim: rgba(228, 182, 72, 0.09);
    --text: #eff2f6;
    --muted: #a1a1aa;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .page { max-width: 1280px; margin: 0 auto; padding: 32px; }
  .skip {
    position: absolute; left: -9999px; top: 0;
    background: var(--accent); color: #111113; padding: 8px 12px;
  }
  .skip:focus { left: 8px; z-index: 10; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, button:focus-visible, summary:focus-visible, .table-scroll:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  code, .mono { font-family: var(--mono); font-size: 0.86em; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }

  .masthead {
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid var(--rule); padding-bottom: 14px;
  }
  .masthead .brand {
    font-family: var(--mono); font-size: 12px; letter-spacing: 0.14em;
    color: var(--muted); text-transform: uppercase;
  }
  .badge {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;
    color: var(--accent); border: 1px solid var(--rule);
    border-left: 2px solid var(--accent); padding: 4px 10px;
  }
  h1 { font-size: 32px; font-weight: 650; margin: 26px 0 4px; text-wrap: balance; }
  h2 { font-size: 17px; font-weight: 600; margin: 0 0 12px; text-wrap: balance; }
  .subtitle { color: var(--muted); margin: 0; }
  .toolbar {
    display: flex; align-items: center; gap: 16px;
    margin: 18px 0 26px; flex-wrap: wrap;
  }
  .toolbar .spacer { flex: 1; }
  .snapshot { color: var(--muted); font-size: 13px; }
  .button {
    font: inherit; font-size: 13px; cursor: pointer;
    color: var(--text); background: var(--panel);
    border: 1px solid var(--rule); border-radius: 4px; padding: 7px 14px;
  }
  .button:hover { border-color: var(--accent); color: var(--accent); }

  .measurements {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 0;
    border: 1px solid var(--rule); border-radius: 4px;
    background: var(--panel); margin-bottom: 10px;
  }
  .measurement { padding: 16px 18px; border-left: 1px solid var(--rule); }
  .measurement:first-child { border-left: 0; }
  .measurement .value { font-family: var(--mono); font-size: 24px; font-variant-numeric: tabular-nums; }
  .measurement .label {
    font-size: 11px; letter-spacing: 0.12em; color: var(--muted);
    text-transform: uppercase; margin-top: 4px;
  }
  .window-note { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
  .window-note .warn { color: var(--accent); }

  .layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 24px; align-items: start; }
  .layout > * { min-width: 0; }
  .rail { border-top: 1px solid var(--rule); padding-top: 14px; }
  .rail h2 {
    font-size: 11px; letter-spacing: 0.12em; color: var(--muted);
    text-transform: uppercase; margin-bottom: 10px;
  }
  .rail ul { list-style: none; margin: 0; padding: 0; }
  .rail li a {
    display: block; padding: 10px 12px; margin-bottom: 4px;
    border-left: 2px solid transparent; border-radius: 0 4px 4px 0;
    color: var(--text); text-decoration: none;
  }
  .rail li a:hover { background: var(--panel); }
  .rail li a[aria-current="page"] {
    border-left-color: var(--accent); background: var(--accent-dim);
  }
  .rail .svc { font-weight: 600; font-size: 14px; }
  .rail .sid, .rail .meta {
    font-family: var(--mono); font-size: 11.5px; color: var(--muted);
    overflow-wrap: anywhere;
  }
  .rail .privacy {
    margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--rule);
    font-size: 12px; color: var(--muted);
  }

  section.detail {
    background: var(--panel); border: 1px solid var(--rule);
    border-radius: 4px; padding: 20px 22px; margin-bottom: 24px;
  }
  .detail-head { border-bottom: 1px solid var(--rule); padding-bottom: 16px; margin-bottom: 0; }
  .detail-head .kind {
    font-size: 11px; letter-spacing: 0.12em; color: var(--muted); text-transform: uppercase;
  }
  .detail-head h2 { font-size: 22px; margin: 6px 0 4px; }
  .detail-head .meta { color: var(--muted); font-size: 13px; }
  .detail-head code { overflow-wrap: anywhere; }
  .tags { margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
  .tag {
    font-family: var(--mono); font-size: 11.5px; color: var(--text);
    border: 1px solid var(--rule); border-radius: 4px; padding: 2px 8px;
    max-width: 100%; min-width: 0; overflow-wrap: anywhere;
  }

  table.tokens { width: 100%; min-width: 520px; border-collapse: collapse; font-size: 13.5px; }
  table.tokens caption {
    text-align: left; color: var(--muted); font-size: 12.5px;
    padding-bottom: 10px; caption-side: top;
  }
  table.tokens th, table.tokens td {
    text-align: left; padding: 8px 10px;
    border-top: 1px solid var(--rule); vertical-align: top;
  }
  table.tokens thead th {
    border-top: 0; font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); font-weight: 600;
  }
  table.tokens td.n { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  table.tokens td.model { overflow-wrap: anywhere; }
  .src { color: var(--muted); font-size: 12px; margin-top: 8px; }
  .table-scroll { min-width: 0; overflow-x: auto; }

  ul.timeline { list-style: none; margin: 0; padding: 0; content-visibility: auto; }
  ul.timeline li {
    display: grid; grid-template-columns: 150px 70px minmax(0, 1fr);
    gap: 12px; padding: 9px 0; border-top: 1px solid var(--rule);
    font-size: 13.5px;
  }
  ul.timeline li:first-child { border-top: 0; }
  ul.timeline .t { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  ul.timeline .sig {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  ul.timeline .sig.traces { color: var(--accent); }
  ul.timeline .sig.logs { color: var(--text); }
  ul.timeline .what { min-width: 0; }
  ul.timeline .what .lbl { overflow-wrap: anywhere; }
  ul.timeline .what .sub { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
  ul.timeline details { margin-top: 4px; font-size: 12px; }
  ul.timeline summary { cursor: pointer; color: var(--muted); width: fit-content; }
  ul.timeline summary:hover { color: var(--accent); }
  ul.timeline code { overflow-wrap: anywhere; color: var(--muted); display: block; }
  .truncated { color: var(--muted); font-size: 12.5px; margin: 10px 0 0; }

  dl.diag { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 18px; margin: 0; }
  dl.diag dt {
    font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
    color: var(--muted);
  }
  dl.diag dd {
    margin: 3px 0 0; font-family: var(--mono); font-size: 14px;
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }
  .diag-note { color: var(--muted); font-size: 12.5px; margin: 14px 0 0; }

  .empty {
    border: 1px solid var(--rule); border-radius: 4px; background: var(--panel);
    padding: 60px 24px; text-align: center;
  }
  .empty h2 { font-size: 20px; margin-bottom: 8px; }
  .empty p { color: var(--muted); max-width: 46ch; margin: 0 auto; }

  @media (max-width: 760px) {
    .page { padding: 16px; }
    h1 { font-size: 26px; }
    .measurements { grid-template-columns: 1fr 1fr; }
    .measurement:nth-child(3) { border-left: 0; }
    .measurement:nth-child(n+3) { border-top: 1px solid var(--rule); }
    .layout { grid-template-columns: minmax(0, 1fr); }
    .rail ul { display: flex; flex-wrap: wrap; gap: 4px; }
    .rail li a { border-left: 0; border: 1px solid var(--rule); border-radius: 4px; }
    .rail li a[aria-current="page"] { border-color: var(--accent); }
    ul.timeline li { grid-template-columns: 1fr; gap: 3px; }
    dl.diag { grid-template-columns: 1fr 1fr; }
  }
`;

function renderNav(view: InspectionView): string {
  const items = view.sessions.map((session) => {
    const current = session === view.selected ? ' aria-current="page"' : "";
    const title = session.nativeSessionId ?? session.key;
    return `<li><a href="${escapeHtml(sessionHref(session))}"${current} title="${escapeHtml(title)}">`
      + `<span class="svc">${escapeHtml(serviceLabel(session))}${session.version ? ` <span class="meta">${escapeHtml(session.version)}</span>` : ""}</span><br>`
      + `<span class="sid">${escapeHtml(shortId(session.nativeSessionId))}</span><br>`
      + `<span class="meta">${stamp(session.lastReceivedAt)} &middot; <span class="num">${escapeHtml(session.observationCount)}</span></span>`
      + `</a></li>`;
  }).join("\n");
  return `<nav class="rail" aria-label="Observed sessions">
    <h2>Observed Sessions</h2>
    <ul>${items}</ul>
    <p class="privacy">Metadata only. Prompt, response and tool content are not retained.<br>${escapeHtml(view.retentionMs / 3_600_000)}h max window.</p>
  </nav>`;
}

function renderRequestEvents(session: InspectionSession): string {
  const rows = session.requestEvents.map((event) => `<tr>
      <td class="model">${escapeHtml(event.model)}</td>
      <td class="n">${tokens(event.input)}</td>
      <td class="n">${tokens(event.cacheCreation)}</td>
      <td class="n">${tokens(event.cacheRead)}</td>
      <td class="n">${tokens(event.output)}</td>
    </tr>`).join("\n");
  const body = session.requestEvents.length === 0
    ? `<p class="src">No supported API request events in this window.</p>`
    : `<div class="table-scroll" role="region" aria-label="Token buckets" tabindex="0"><table class="tokens">
      <caption>Per-event token buckets. Logs only; no cross-signal totals.</caption>
      <thead><tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Cache Write</th><th scope="col">Cache Read</th><th scope="col">Output</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="src">${escapeHtml(session.requestEvents.length)} event rows &middot; provider-reported event</p>`;
  return `<section class="detail" aria-labelledby="api-events">
    <h2 id="api-events">Reported API Events</h2>
    ${body}
  </section>`;
}

function renderTimeline(session: InspectionSession): string {
  const items = session.timeline.map((item) => {
    const ids = item.traceId || item.spanId
      ? `<details><summary>Trace IDs</summary>${item.traceId ? `<code>trace ${escapeHtml(item.traceId)}</code>` : ""}${item.spanId ? `<code>span ${escapeHtml(item.spanId)}</code>` : ""}</details>`
      : "";
    const sub: string[] = [];
    if (item.model) sub.push(escapeHtml(item.model));
    if (item.durationMs !== undefined) sub.push(`${escapeHtml(item.durationMs)} ms`);
    return `<li>
      <span class="t">${stamp(item.occurredAt)}</span>
      <span class="sig ${item.signal}">${item.signal === "traces" ? "Span" : "Event"}</span>
      <div class="what"><span class="lbl">${escapeHtml(item.label.replace(/_/g, " "))}</span>
      ${sub.length ? `<span class="sub">${sub.join(" &middot; ")}</span>` : ""}${ids}</div>
    </li>`;
  }).join("\n");
  const truncated = session.timelineCount > session.timeline.length
    ? `<p class="truncated">Showing the most recent ${escapeHtml(session.timeline.length)} of ${escapeHtml(session.timelineCount)} rows.</p>`
    : "";
  return `<section class="detail" aria-labelledby="timeline">
    <h2 id="timeline">Activity Timeline</h2>
    <p class="src">Events and spans; metric points stay in the observation count.</p>
    <ul class="timeline">${items}</ul>
    ${truncated}
  </section>`;
}

function renderDiagnostics(view: InspectionView): string {
  const { health } = view;
  const cells: [string, string][] = [
    ["Spans accepted", String(health.accepted.traces)],
    ["Spans rejected", String(health.rejected.traces)],
    ["Events accepted", String(health.accepted.logs)],
    ["Events rejected", String(health.rejected.logs)],
    ["Points accepted", String(health.accepted.metrics)],
    ["Points rejected", String(health.rejected.metrics)],
    ["Invalid requests", String(health.invalidRequests)],
    ["Persistence failures", String(health.persistenceFailures)],
    ["Observations lost", String(health.persistenceLost)],
    ["Queued", String(health.queue.items)],
    ["Retention evictions", String(health.store.retentionEvicted)],
    ["Store bytes", numberFormat.format(health.store.bytes)],
  ];
  const entries = cells.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("\n");
  return `<section class="detail" aria-labelledby="diagnostics">
    <h2 id="diagnostics">Receiver Diagnostics (Since Restart)</h2>
    <dl class="diag">${entries}</dl>
    <p class="diag-note">The retained window survives a receiver restart; these counters reset. Inspection only, not billing.</p>
  </section>`;
}

function renderDetail(view: InspectionView): string {
  const session = view.selected;
  if (!session) {
    return `<div class="empty">
      <h2>Waiting for agent telemetry</h2>
      <p>This receiver accepts OTLP over HTTP on loopback. Once a local agent exports traces, logs or metrics, sanitized metadata appears here.</p>
    </div>`;
  }
  const head = `<section class="detail detail-head" aria-labelledby="session-title">
    <div class="kind">Observed evidence</div>
    <h2 id="session-title">${escapeHtml(serviceLabel(session))}${session.version ? ` <span class="meta">${escapeHtml(session.version)}</span>` : ""}</h2>
    <div class="meta">${session.nativeSessionId
      ? `<code>${escapeHtml(session.nativeSessionId)}</code>`
      : "Uncorrelated evidence"} &middot; last received ${stamp(session.lastReceivedAt)}</div>
    ${session.models.length ? `<div class="tags">${session.models.map((model) => `<span class="tag">${escapeHtml(model)}</span>`).join("")}</div>` : ""}
  </section>`;
  return head + renderRequestEvents(session) + renderTimeline(session) + renderDiagnostics(view);
}

export function renderInspectionPage(view: InspectionView): string {
  const measurements: [string, number][] = [
    ["Session groups", view.sessionCount],
    ["Spans", view.counts.traces],
    ["Events", view.counts.logs],
    ["Metric points", view.counts.metrics],
  ];
  const strip = measurements.map(([label, value]) => `<div class="measurement">
      <div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div>
    </div>`).join("\n");
  const notes = [`Showing ${escapeHtml(view.loadedCount)} retained observations`];
  if (view.bounded) notes.push(`<span class="warn">Store holds more rows than this window loads.</span>`);
  if (view.uncorrelatedGroupCount > 0) notes.push(`${escapeHtml(view.uncorrelatedGroupCount)} uncorrelated group${view.uncorrelatedGroupCount === 1 ? "" : "s"}`);
  const hiddenSession = view.selected
    ? `<input type="hidden" name="session" value="${escapeHtml(view.selected.key)}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#111113">
<meta name="color-scheme" content="dark">
<title>Agent Telemetry &mdash; Scout</title>
<style>${styles}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="page">
  <header class="masthead">
    <span class="brand">Scout / Local Observability</span>
    <span class="badge">Receiver online</span>
  </header>
  <h1>Agent Telemetry</h1>
  <p class="subtitle">A window into the agents on this machine.</p>
  <div class="toolbar">
    <form method="get" action="${escapeHtml(otlpPaths.inspector)}">${hiddenSession}<button class="button" type="submit">Refresh</button></form>
    <a href="${escapeHtml(`${otlpPaths.observations}?limit=500`)}">Raw JSON</a>
    <span class="spacer"></span>
    <span class="snapshot">Snapshot ${stamp(view.generatedAt)}</span>
  </div>
  <div class="measurements">${strip}</div>
  <p class="window-note">${notes.join(" &middot; ")}</p>
  <div class="layout">
    ${renderNav(view)}
    <main id="main">${renderDetail(view)}</main>
  </div>
</div>
</body>
</html>`;
}
