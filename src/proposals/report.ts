/**
 * Static HTML report for `skvm proposals report`.
 *
 * Single self-contained HTML file — inlined CSS + vanilla JS, no external
 * assets, no build step. The file can be opened locally or shared as-is
 * (e.g. dropped in a PR description). No server process required.
 *
 * Inputs: a list of loaded proposals. For each proposal we run the diff
 * helper (git-backed) once at generate-time so the HTML carries pre-rendered
 * diffs and the reader's browser never needs to fetch anything.
 */

import type { LoadedProposal } from "./storage.ts"
import { summarizeProposal } from "./summary.ts"
import type { ProposalSummaryView, RoundLine } from "./summary.ts"
import { diffProposalRound } from "./diff.ts"
import { proposalDirFromId } from "./storage.ts"

// ---------------------------------------------------------------------------
// HTML escape
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// ---------------------------------------------------------------------------
// Color math — same thresholds as CLI
// ---------------------------------------------------------------------------

function deltaClass(delta: number | null): string {
  if (delta == null) return "d-na"
  if (delta >= 0.05) return "d-good"
  if (delta <= -0.02) return "d-bad"
  return "d-flat"
}

function deltaText(delta: number | null): string {
  if (delta == null) return "——"
  const sign = delta >= 0 ? "+" : ""
  return `${sign}${delta.toFixed(3)}`
}

function scoreText(s: number | null): string {
  return s == null ? "——" : s.toFixed(3)
}

// ---------------------------------------------------------------------------
// Per-proposal data bundle
// ---------------------------------------------------------------------------

interface ProposalBundle {
  p: LoadedProposal
  summary: ProposalSummaryView
  diff: string | null
  diffReason: string | null
}

async function loadBundles(proposals: LoadedProposal[]): Promise<ProposalBundle[]> {
  const bundles: ProposalBundle[] = []
  for (const p of proposals) {
    const summary = summarizeProposal(p)
    let diff: string | null = null
    let diffReason: string | null = null
    const bestRound = p.meta.bestRound
    if (bestRound > 0) {
      const result = await diffProposalRound(proposalDirFromId(p.id), bestRound)
      if (result.ok) diff = result.unified
      else diffReason = result.reason
    } else {
      diffReason = "best round is baseline — no skill changes to diff"
    }
    bundles.push({ p, summary, diff, diffReason })
  }
  return bundles
}

// ---------------------------------------------------------------------------
// SVG sparkline — train score vs round
// ---------------------------------------------------------------------------

function renderSparkline(rounds: RoundLine[]): string {
  const pts = rounds
    .map((r) => ({ round: r.round, score: r.trainScore }))
    .filter((p): p is { round: number; score: number } => p.score != null)
  if (pts.length < 2) {
    return `<div class="spark-empty">(not enough scored rounds)</div>`
  }
  const W = 240
  const H = 60
  const pad = 6
  const minS = Math.min(...pts.map((p) => p.score))
  const maxS = Math.max(...pts.map((p) => p.score))
  const rangeS = maxS - minS || 0.001
  const minR = pts[0]!.round
  const maxR = pts[pts.length - 1]!.round
  const rangeR = maxR - minR || 1

  const xy = pts.map((p) => {
    const x = pad + ((p.round - minR) / rangeR) * (W - 2 * pad)
    const y = H - pad - ((p.score - minS) / rangeS) * (H - 2 * pad)
    return { x, y, score: p.score, round: p.round }
  })
  const path = xy.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  const dots = xy
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" title="round ${p.round}: ${p.score.toFixed(3)}"></circle>`)
    .join("")
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${path}"></path>${dots}</svg>`
}

// ---------------------------------------------------------------------------
// Diff colorizer — wraps lines with classes for red/green backgrounds
// ---------------------------------------------------------------------------

function renderDiff(raw: string): string {
  const lines = raw.split("\n")
  const out: string[] = []
  for (const line of lines) {
    let cls = ""
    if (line.startsWith("+++") || line.startsWith("---")) cls = "d-file"
    else if (line.startsWith("@@")) cls = "d-hunk"
    else if (line.startsWith("diff --git")) cls = "d-githeader"
    else if (line.startsWith("+")) cls = "d-add"
    else if (line.startsWith("-")) cls = "d-del"
    out.push(`<span class="${cls}">${esc(line)}</span>`)
  }
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Main-table row (collapsed)
// ---------------------------------------------------------------------------

function renderMainRow(b: ProposalBundle, idx: number): string {
  const { p, summary } = b
  const delta = summary.trainDelta
  const searchable = `${p.meta.harness} ${p.meta.targetModel} ${p.meta.skillName} ${p.meta.status}`.toLowerCase()
  return `
<tr class="main-row" data-idx="${idx}"
  data-status="${esc(p.meta.status)}"
  data-harness="${esc(p.meta.harness)}"
  data-model="${esc(p.meta.targetModel)}"
  data-skill="${esc(p.meta.skillName)}"
  data-delta="${delta ?? ""}"
  data-best="${p.meta.bestRound}"
  data-rounds="${p.meta.roundCount}"
  data-search="${esc(searchable)}"
  onclick="toggleDetail(${idx})">
  <td><span class="status st-${esc(p.meta.status)}">${esc(p.meta.status)}</span></td>
  <td>${esc(p.meta.harness)}</td>
  <td>${esc(p.meta.targetModel)}</td>
  <td>${esc(p.meta.skillName)}</td>
  <td class="num">r-${p.meta.bestRound}</td>
  <td class="num ${deltaClass(delta)}">${deltaText(delta)}</td>
  <td class="num">${p.meta.bestRound}/${p.meta.roundCount}</td>
  <td class="ts">${esc(p.meta.timestamp)}</td>
</tr>`
}

// ---------------------------------------------------------------------------
// Detail panel (expanded)
// ---------------------------------------------------------------------------

function renderDetail(b: ProposalBundle, idx: number): string {
  const { p, summary, diff, diffReason } = b
  const hasTest = summary.rounds.some((r) => r.testScore != null)

  const roundsHeader = hasTest
    ? `<tr><th>round</th><th class="num">train</th><th class="num">test</th><th class="num">Δ</th><th class="num">pass</th><th class="num">cost</th><th>changed</th></tr>`
    : `<tr><th>round</th><th class="num">train</th><th class="num">Δ</th><th class="num">pass</th><th class="num">cost</th><th>changed</th></tr>`

  const roundRows = summary.rounds
    .map((r) => {
      const label = r.isBest
        ? `<span class="best">r-${r.round}★</span>`
        : r.isBaseline
          ? `<span class="baseline">r-${r.round}</span>`
          : `r-${r.round}`
      const files = r.changedFiles.map((f) => `<code>${esc(f)}</code>`).join(" ")
      const delta = r.isBaseline ? "——" : deltaText(r.deltaVsBaseline)
      const dCls = r.isBaseline ? "d-na" : deltaClass(r.deltaVsBaseline)
      if (hasTest) {
        return `<tr><td>${label}</td><td class="num">${scoreText(r.trainScore)}</td><td class="num">${scoreText(r.testScore)}</td><td class="num ${dCls}">${delta}</td><td class="num">${r.trainPassed}/${r.trainTotal}</td><td class="num">$${r.costTotalUsd.toFixed(3)}</td><td>${files}</td></tr>`
      }
      return `<tr><td>${label}</td><td class="num">${scoreText(r.trainScore)}</td><td class="num ${dCls}">${delta}</td><td class="num">${r.trainPassed}/${r.trainTotal}</td><td class="num">$${r.costTotalUsd.toFixed(3)}</td><td>${files}</td></tr>`
    })
    .join("")

  const perTaskRows = summary.perTaskDeltas.length === 0
    ? `<tr><td colspan="4" class="dim">no per-task data</td></tr>`
    : summary.perTaskDeltas
        .map(
          (d) =>
            `<tr><td>${esc(d.taskId)}</td><td class="num">${scoreText(d.baseline)}</td><td class="num">${scoreText(d.best)}</td><td class="num ${deltaClass(d.delta)}">${deltaText(d.delta)}</td></tr>`,
        )
        .join("")

  const rootCause = summary.bestRoundRootCause
    ? `<div class="section"><h4>best round root cause</h4><p class="root-cause">${esc(summary.bestRoundRootCause)}</p></div>`
    : ""

  const diffBlock = diff
    ? `<details class="diff-details"><summary>diff (original → round-${p.meta.bestRound})</summary><pre class="diff">${renderDiff(diff)}</pre></details>`
    : `<div class="dim diff-none">${esc(diffReason ?? "(no diff available)")}</div>`

  return `
<tr class="detail-row" id="detail-${idx}" style="display:none">
  <td colspan="8">
    <div class="detail-grid">
      <div class="detail-left">
        <h4>rounds</h4>
        <table class="inner-table">${roundsHeader}${roundRows}</table>
        <h4>per-task at best round</h4>
        <table class="inner-table"><tr><th>task</th><th class="num">baseline</th><th class="num">best</th><th class="num">Δ</th></tr>${perTaskRows}</table>
      </div>
      <div class="detail-right">
        <h4>score by round</h4>
        ${renderSparkline(summary.rounds)}
        <div class="cost-box">
          <div>total cost: <strong>$${summary.totalCostUsd.toFixed(3)}</strong></div>
          <div class="dim">optimizer: $${summary.totalOptimizerCostUsd.toFixed(3)}</div>
        </div>
        <div class="meta-box">
          <div><span class="dim">optimizer-model:</span> ${esc(p.meta.optimizerModel)}</div>
          <div><span class="dim">source:</span> ${esc(p.meta.source)}</div>
          <div><span class="dim">id:</span> <code>${esc(p.id)}</code></div>
        </div>
      </div>
    </div>
    ${rootCause}
    <div class="section">
      <h4>changes</h4>
      ${diffBlock}
    </div>
  </td>
</tr>`
}

// ---------------------------------------------------------------------------
// Heatmaps — (skill × model) Δ matrix and (model × skill) Δ matrix
// ---------------------------------------------------------------------------

interface HeatCell {
  rowKey: string
  colKey: string
  delta: number | null
}

function buildMatrix(bundles: ProposalBundle[], rowBy: "skill" | "model"): HeatCell[] {
  const cells: HeatCell[] = []
  for (const b of bundles) {
    const rowKey = rowBy === "skill" ? b.p.meta.skillName : b.p.meta.targetModel
    const colKey = rowBy === "skill" ? b.p.meta.targetModel : b.p.meta.skillName
    cells.push({ rowKey, colKey, delta: b.summary.trainDelta })
  }
  return cells
}

function renderHeatmap(bundles: ProposalBundle[], rowBy: "skill" | "model", title: string): string {
  const cells = buildMatrix(bundles, rowBy)
  const rowKeys = Array.from(new Set(cells.map((c) => c.rowKey))).sort()
  const colKeys = Array.from(new Set(cells.map((c) => c.colKey))).sort()
  if (rowKeys.length === 0 || colKeys.length === 0) return ""

  const map = new Map<string, number[]>()
  for (const c of cells) {
    const key = `${c.rowKey}||${c.colKey}`
    if (c.delta == null) continue
    const arr = map.get(key) ?? []
    arr.push(c.delta)
    map.set(key, arr)
  }

  const header = `<tr><th>${esc(rowBy === "skill" ? "skill ↓ / model →" : "model ↓ / skill →")}</th>${colKeys.map((k) => `<th class="heat-col">${esc(k)}</th>`).join("")}</tr>`
  const rows = rowKeys
    .map((rk) => {
      const cells = colKeys
        .map((ck) => {
          const arr = map.get(`${rk}||${ck}`)
          if (!arr || arr.length === 0) return `<td class="heat-empty">·</td>`
          const avg = arr.reduce((a, b) => a + b, 0) / arr.length
          return `<td class="heat-cell ${deltaClass(avg)}" title="${arr.length} proposal(s), avg Δ ${deltaText(avg)}">${deltaText(avg)}</td>`
        })
        .join("")
      return `<tr><th class="heat-row">${esc(rk)}</th>${cells}</tr>`
    })
    .join("")
  return `<section class="heatmap"><h3>${esc(title)}</h3><div class="heatmap-scroll"><table class="heat">${header}${rows}</table></div></section>`
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function renderDashboard(bundles: ProposalBundle[]): string {
  const total = bundles.length
  const byStatus = new Map<string, number>()
  for (const b of bundles) {
    byStatus.set(b.p.meta.status, (byStatus.get(b.p.meta.status) ?? 0) + 1)
  }
  const deltas = bundles.map((b) => b.summary.trainDelta).filter((d): d is number => d != null)
  const avgDelta = deltas.length === 0 ? null : deltas.reduce((a, b) => a + b, 0) / deltas.length
  const wins = deltas.filter((d) => d >= 0.05).length
  const losses = deltas.filter((d) => d <= -0.02).length
  const flat = deltas.length - wins - losses
  const totalCost = bundles.reduce((s, b) => s + b.summary.totalCostUsd, 0)
  const optCost = bundles.reduce((s, b) => s + b.summary.totalOptimizerCostUsd, 0)

  const statusBadges = Array.from(byStatus.entries())
    .map(([k, v]) => `<span class="badge st-${esc(k)}">${esc(k)}: ${v}</span>`)
    .join(" ")

  return `
<section class="dashboard">
  <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">proposals</div></div>
  <div class="stat"><div class="stat-num ${deltaClass(avgDelta)}">${deltaText(avgDelta)}</div><div class="stat-label">avg Δ train</div></div>
  <div class="stat"><div class="stat-num d-good">${wins}</div><div class="stat-label">wins (≥+0.05)</div></div>
  <div class="stat"><div class="stat-num d-bad">${losses}</div><div class="stat-label">losses (≤−0.02)</div></div>
  <div class="stat"><div class="stat-num d-flat">${flat}</div><div class="stat-label">flat</div></div>
  <div class="stat"><div class="stat-num">$${totalCost.toFixed(2)}</div><div class="stat-label">total cost</div><div class="stat-sub">(optimizer $${optCost.toFixed(2)})</div></div>
  <div class="stat-badges">${statusBadges}</div>
</section>`
}

// ---------------------------------------------------------------------------
// Top-level assembly
// ---------------------------------------------------------------------------

const CSS = `
:root {
  --bg: #0f1117;
  --fg: #e6e8eb;
  --dim: #7a8290;
  --panel: #161a22;
  --border: #262c38;
  --accent: #4c9eff;
  --good: #3dd68c;
  --bad: #ff5c6b;
  --flat: #e8c547;
  --good-bg: rgba(61, 214, 140, 0.14);
  --bad-bg: rgba(255, 92, 107, 0.14);
  --flat-bg: rgba(232, 197, 71, 0.10);
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fafbfc;
    --fg: #1a1d23;
    --dim: #6a7280;
    --panel: #ffffff;
    --border: #e1e4e8;
    --accent: #0969da;
    --good: #116329;
    --bad: #a40e26;
    --flat: #7d4e00;
    --good-bg: rgba(17, 99, 41, 0.08);
    --bad-bg: rgba(164, 14, 38, 0.08);
    --flat-bg: rgba(125, 78, 0, 0.08);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 13px/1.5 -apple-system, "SF Mono", "Menlo", "Consolas", monospace;
  background: var(--bg);
  color: var(--fg);
  padding: 20px;
}
h1 { font-size: 18px; margin: 0 0 4px; }
h3 { font-size: 14px; margin: 24px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h4 { font-size: 12px; margin: 12px 0 6px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
.dim { color: var(--dim); }
code { font-family: inherit; background: var(--border); padding: 1px 4px; border-radius: 3px; font-size: 11px; }
.sub { color: var(--dim); font-size: 12px; margin-bottom: 16px; }

/* dashboard */
.dashboard { display: flex; flex-wrap: wrap; gap: 14px; margin: 16px 0 24px; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; min-width: 110px; }
.stat-num { font-size: 22px; font-weight: 600; }
.stat-label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
.stat-sub { font-size: 10px; color: var(--dim); margin-top: 2px; }
.stat-badges { display: flex; flex-wrap: wrap; gap: 6px; align-self: center; margin-left: auto; }
.badge { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 3px 10px; font-size: 11px; }

/* filters */
.controls { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
.controls input[type="search"] {
  background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  border-radius: 4px; padding: 6px 10px; font: inherit; min-width: 260px;
}
.controls label { font-size: 12px; color: var(--dim); }
.controls select {
  background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  border-radius: 4px; padding: 5px 8px; font: inherit;
}

/* main table */
table.main {
  width: 100%; border-collapse: collapse; background: var(--panel);
  border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
}
table.main th, table.main td {
  padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border);
}
table.main th {
  background: var(--border); color: var(--dim); font-weight: 500; font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; user-select: none;
}
table.main th.num { text-align: right; }
table.main th:hover { color: var(--fg); }
table.main th::after { content: ""; }
table.main th.asc::after { content: " ▲"; color: var(--accent); }
table.main th.desc::after { content: " ▼"; color: var(--accent); }
tr.main-row { cursor: pointer; }
tr.main-row:hover { background: var(--border); }
tr.main-row.hidden { display: none; }
tr.main-row td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.ts { color: var(--dim); font-size: 11px; }

.status { padding: 2px 8px; border-radius: 10px; font-size: 11px; }
.st-pending { background: var(--flat-bg); color: var(--flat); }
.st-accepted { background: var(--good-bg); color: var(--good); }
.st-rejected { background: var(--bad-bg); color: var(--bad); }
.st-infra-blocked { background: var(--border); color: var(--dim); }

/* delta colors */
.d-good { color: var(--good); background: var(--good-bg); }
.d-bad { color: var(--bad); background: var(--bad-bg); }
.d-flat { color: var(--flat); }
.d-na { color: var(--dim); }

/* detail */
tr.detail-row td { background: var(--bg); padding: 14px 18px; border-bottom: 2px solid var(--border); }
.detail-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; }
.inner-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 12px; }
.inner-table th, .inner-table td {
  padding: 4px 8px; text-align: left; border-bottom: 1px solid var(--border);
}
.inner-table th { color: var(--dim); font-weight: 500; text-transform: uppercase; letter-spacing: 0.3px; font-size: 11px; }
.inner-table th.num, .inner-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.inner-table .best { color: var(--good); font-weight: 600; }
.inner-table .baseline { color: var(--dim); }

.spark { display: block; margin: 4px 0; }
.spark path { fill: none; stroke: var(--accent); stroke-width: 2; }
.spark circle { fill: var(--accent); }
.spark-empty { color: var(--dim); font-size: 11px; padding: 10px 0; }

.cost-box, .meta-box {
  margin-top: 10px; padding: 8px 10px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 4px; font-size: 12px;
}
.cost-box strong { color: var(--fg); }
.meta-box > div { margin: 2px 0; }

.root-cause {
  background: var(--panel); border-left: 3px solid var(--accent);
  padding: 10px 14px; margin: 4px 0; border-radius: 0 4px 4px 0;
  white-space: pre-wrap;
}
.section { margin-top: 16px; }

/* diff */
.diff-details { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; }
.diff-details summary { padding: 8px 12px; cursor: pointer; color: var(--dim); font-size: 12px; }
.diff-details[open] summary { border-bottom: 1px solid var(--border); }
.diff {
  margin: 0; padding: 10px 14px; font: 11px/1.4 "SF Mono", "Menlo", monospace;
  overflow-x: auto; max-height: 500px;
}
.diff span { display: block; white-space: pre; }
.diff .d-add { background: var(--good-bg); color: var(--good); }
.diff .d-del { background: var(--bad-bg); color: var(--bad); }
.diff .d-hunk { color: var(--accent); }
.diff .d-file { color: var(--dim); font-weight: 600; }
.diff .d-githeader { color: var(--dim); }
.diff-none { padding: 10px 14px; background: var(--panel); border: 1px dashed var(--border); border-radius: 4px; font-size: 12px; }

/* heatmaps */
.heatmap-scroll { overflow-x: auto; }
table.heat { border-collapse: collapse; font-size: 11px; background: var(--panel); border: 1px solid var(--border); }
table.heat th, table.heat td { padding: 6px 10px; border: 1px solid var(--border); text-align: center; white-space: nowrap; }
table.heat th.heat-row { text-align: left; color: var(--dim); font-weight: 500; }
table.heat th.heat-col { color: var(--dim); font-weight: 500; writing-mode: horizontal-tb; }
table.heat td.heat-cell { font-variant-numeric: tabular-nums; }
table.heat td.heat-empty { color: var(--dim); }
`

const JS = `
function toggleDetail(idx) {
  const detail = document.getElementById("detail-" + idx);
  if (!detail) return;
  detail.style.display = detail.style.display === "none" ? "table-row" : "none";
}
(function () {
  const input = document.getElementById("filter");
  const rows = Array.from(document.querySelectorAll("tr.main-row"));
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    for (const r of rows) {
      const s = r.dataset.search || "";
      const match = !q || s.includes(q);
      r.classList.toggle("hidden", !match);
      const idx = r.dataset.idx;
      const detail = document.getElementById("detail-" + idx);
      if (detail && !match) detail.style.display = "none";
    }
  });

  const statusFilter = document.getElementById("status-filter");
  statusFilter.addEventListener("change", () => {
    const v = statusFilter.value;
    for (const r of rows) {
      const match = !v || r.dataset.status === v;
      r.classList.toggle("hidden-status", !match);
      r.classList.toggle("hidden", r.classList.contains("hidden-search") || !match);
      const idx = r.dataset.idx;
      const detail = document.getElementById("detail-" + idx);
      if (detail && !match) detail.style.display = "none";
    }
  });

  const headers = document.querySelectorAll("table.main th[data-sort]");
  let currentSort = { key: "recent", dir: "desc" };
  headers.forEach((h) => {
    h.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = h.dataset.sort;
      const dir = currentSort.key === key && currentSort.dir === "asc" ? "desc" : "asc";
      currentSort = { key, dir };
      headers.forEach((x) => x.classList.remove("asc", "desc"));
      h.classList.add(dir);
      const tbody = h.closest("table").querySelector("tbody");
      const pairs = [];
      const trs = Array.from(tbody.children);
      for (let i = 0; i < trs.length; i += 2) {
        pairs.push([trs[i], trs[i + 1]]);
      }
      pairs.sort((a, b) => {
        const av = a[0].dataset[key] ?? "";
        const bv = b[0].dataset[key] ?? "";
        const an = parseFloat(av);
        const bn = parseFloat(bv);
        const numeric = !isNaN(an) && !isNaN(bn);
        let cmp;
        if (numeric) cmp = an - bn;
        else cmp = String(av).localeCompare(String(bv));
        return dir === "asc" ? cmp : -cmp;
      });
      for (const [m, d] of pairs) {
        tbody.appendChild(m);
        if (d) tbody.appendChild(d);
      }
    });
  });
})();
`

export async function generateReport(proposals: LoadedProposal[]): Promise<string> {
  const bundles = await loadBundles(proposals)

  const statusValues = Array.from(new Set(bundles.map((b) => b.p.meta.status))).sort()
  const statusOptions = [`<option value="">all statuses</option>`]
    .concat(statusValues.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`))
    .join("")

  const mainRows: string[] = []
  for (let i = 0; i < bundles.length; i++) {
    mainRows.push(renderMainRow(bundles[i]!, i))
    mainRows.push(renderDetail(bundles[i]!, i))
  }

  const thead = `
<thead>
  <tr>
    <th data-sort="status">status</th>
    <th data-sort="harness">harness</th>
    <th data-sort="model">target-model</th>
    <th data-sort="skill">skill</th>
    <th data-sort="best" class="num">best</th>
    <th data-sort="delta" class="num desc">Δ train</th>
    <th data-sort="rounds" class="num">rounds</th>
    <th data-sort="ts">timestamp</th>
  </tr>
</thead>`

  const generatedAt = new Date().toISOString()

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SkVM proposals report</title>
<style>${CSS}</style>
</head>
<body>
<h1>SkVM proposals report</h1>
<div class="sub">generated ${esc(generatedAt)} · ${bundles.length} proposal(s)</div>
${renderDashboard(bundles)}
<div class="controls">
  <input type="search" id="filter" placeholder="filter by skill / model / harness...">
  <label>status:
    <select id="status-filter">${statusOptions}</select>
  </label>
</div>
<table class="main">
  ${thead}
  <tbody>
    ${mainRows.join("\n")}
  </tbody>
</table>
${renderHeatmap(bundles, "skill", "by skill — Δ train across target models")}
${renderHeatmap(bundles, "model", "by target model — Δ train across skills")}
<script>${JS}</script>
</body>
</html>`
}
