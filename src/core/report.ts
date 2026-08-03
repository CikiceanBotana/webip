/**
 * Reporting.
 *
 * Three outputs from one findings array:
 *   findings.json  the machine record, complete and unabridged
 *   report.html    a self-contained page a human can actually read
 *   console        a ranked summary for the terminal
 *
 * Nothing here decides what is a defect; it only presents what the lanes found.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assessIntegrity, summariseByTool } from './coverage.js';
import {
  countByAudience,
  countByCategory,
  countBySeverity,
  countByTool,
  countOccurrences,
  groupBySite,
  sortFindings,
} from './finding.js';
import { rollupIssues } from './issues.js';
import {
  SEVERITIES,
  type Finding,
  type IssueScope,
  type PageCoverage,
  type RunReport,
  type Severity,
} from './types.js';

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#b91c1c',
  serious: '#c2410c',
  moderate: '#a16207',
  minor: '#0369a1',
  info: '#57534e',
};

/** Scope answers "fix once, or fix per tenant?". */
const SCOPE_COLOR: Record<IssueScope, string> = {
  platform: '#6d28d9',
  widespread: '#0f766e',
  tenant: '#57534e',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Terminal summary. Deliberately compact: the detail lives in the files. */
export function printSummary(report: RunReport, limit = 25): void {
  const line = '─'.repeat(78);
  const { stats } = report;

  console.log(`\n${line}`);
  console.log('  webip scan complete');
  console.log(
    `  ${stats.sitesScanned} sites · ${stats.pagesFastLane} pages fast lane · ${stats.pagesBrowserLane} pages browser lane · ${Math.round(report.durationMs / 1000)}s`,
  );
  console.log(line);

  console.log('\n  BY SEVERITY');
  for (const severity of SEVERITIES) {
    const count = stats.bySeverity[severity];
    if (count > 0) console.log(`    ${severity.padEnd(10)} ${String(count).padStart(6)}`);
  }

  console.log('\n  WHO IS AFFECTED (occurrences)');
  for (const [audience, count] of Object.entries(stats.byAudience).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${audience.padEnd(16)} ${String(count).padStart(6)}`);
  }

  console.log('\n  BY CATEGORY');
  for (const [category, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${category.padEnd(16)} ${String(count).padStart(6)}`);
  }

  console.log('\n  BY TOOL');
  for (const [tool, count] of Object.entries(stats.byTool).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${tool.padEnd(20)} ${String(count).padStart(6)}`);
  }

  // The rollup already ranked every defect by severity and reach; printing it
  // rather than recomputing it keeps the console and the JSON in agreement.
  console.log('\n  TOP ISSUES');
  for (const issue of report.issues.slice(0, limit)) {
    console.log(
      `    [${issue.severity.padEnd(8)}] ${issue.scope.padEnd(10)} ${issue.key.slice(0, 40).padEnd(40)} ` +
        `${String(issue.sitesAffected).padStart(4)} site(s)  ${String(issue.occurrences).padStart(6)}×`,
    );
  }

  // Coverage is printed even when it is boring, because the one run where it is
  // not boring is the run that would otherwise be reported as a clean site.
  console.log('\n  COVERAGE (pages where each tool completed)');
  for (const [tool, cov] of Object.entries(report.coverage.byTool).sort(
    (a, b) => b[1].ran - a[1].ran,
  )) {
    const attempted = cov.ran + cov.errored;
    const rate = attempted > 0 ? Math.round((cov.ran / attempted) * 100) : 100;
    console.log(
      `    ${tool.padEnd(20)} ${String(cov.ran).padStart(5)} ok · ${String(cov.errored).padStart(4)} failed · ` +
        `${String(cov.skipped).padStart(4)} skipped  (${rate}% completed)`,
    );
  }

  if (!report.integrity.ok || report.integrity.warnings.length > 0) {
    console.log(
      `\n  ${report.integrity.ok ? 'INCOMPLETE RUN' : 'RUN NOT TRUSTWORTHY -- DO NOT REPORT FROM THIS DATA'}`,
    );
    for (const warning of report.integrity.warnings) console.log(`    ${warning}`);
  }

  if (report.errors.length > 0) {
    console.log(`\n  SCAN ERRORS: ${report.errors.length} (see findings.json)`);
    for (const err of report.errors.slice(0, 5)) console.log(`    ${err.slice(0, 110)}`);
  }

  console.log(`\n${line}\n`);
}

/** How many occurrences to list inline per finding in the HTML. */
const INSTANCES_SHOWN = 10;

/** One occurrence: where it is, what was measured, what was expected. */
function renderInstance(instance: Finding['instances'][number]): string {
  const where =
    instance.selector ??
    instance.target ??
    (instance.line !== undefined ? `line ${instance.line}` : '');
  const position =
    instance.selector !== undefined && instance.line !== undefined ? `:${instance.line}` : '';
  const measured =
    instance.measured !== undefined
      ? `<span class="meas">${escapeHtml(instance.measured)}${
          instance.expected !== undefined ? ` → needs ${escapeHtml(instance.expected)}` : ''
        }</span>`
      : '';

  return `
        <li>
          ${where ? `<code>${escapeHtml(String(where).slice(0, 150))}${position}</code>` : ''}
          ${measured}
          ${instance.message ? `<div class="imsg">${escapeHtml(instance.message)}</div>` : ''}
          ${instance.snippet ? `<div class="isnip"><code>${escapeHtml(instance.snippet)}</code></div>` : ''}
        </li>`;
}

function renderFindingRow(f: Finding): string {
  const shown = f.instances.slice(0, INSTANCES_SHOWN);
  const hidden = f.count - shown.length;

  return `
    <tr>
      <td><span class="sev" style="background:${SEVERITY_COLOR[f.severity]}">${f.severity}</span></td>
      <td class="tool">${escapeHtml(f.tool)}<div class="cat">${escapeHtml(f.category)}</div></td>
      <td><code>${escapeHtml(f.rule)}</code>${f.count > 1 ? ` <span class="mult">×${f.count}</span>` : ''}</td>
      <td>
        <div class="title">${escapeHtml(f.title)}</div>
        ${f.detail ? `<div class="detail">${escapeHtml(f.detail)}</div>` : ''}
        ${f.remedy ? `<div class="fix"><strong>Fix:</strong> ${escapeHtml(f.remedy)}</div>` : ''}
        ${
          f.standards && f.standards.length > 0
            ? `<div class="std">${f.standards.map((s) => `<span>${escapeHtml(s)}</span>`).join('')}</div>`
            : ''
        }
        ${shown.length > 0 ? `<ul class="inst">${shown.map(renderInstance).join('')}</ul>` : ''}
        ${hidden > 0 ? `<div class="more">+ ${hidden} more occurrence(s) on this page</div>` : ''}
        ${f.helpUrl ? `<a class="help" href="${escapeHtml(f.helpUrl)}" target="_blank" rel="noopener">docs</a>` : ''}
      </td>
      <td class="url"><a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(
        f.url.replace(f.site, '') || '/',
      )}</a></td>
    </tr>`;
}

export function renderHtml(report: RunReport): string {
  const bySite = groupBySite(sortFindings(report.findings));

  const siteSections = [...bySite.entries()]
    .map(([site, findings]) => {
      const counts = countBySeverity(findings);
      const badges = SEVERITIES.filter((s) => counts[s] > 0)
        .map(
          (s) =>
            `<span class="sev" style="background:${SEVERITY_COLOR[s]}">${counts[s]} ${s}</span>`,
        )
        .join(' ');
      return `
  <details class="site">
    <summary>
      <span class="host">${escapeHtml(site.replace(/^https?:\/\//, ''))}</span>
      <span class="badges">${badges}</span>
      <span class="total">${findings.length} findings</span>
    </summary>
    <table>
      <thead><tr><th>Severity</th><th>Tool</th><th>Rule</th><th>Issue</th><th>Page</th></tr></thead>
      <tbody>${findings.map(renderFindingRow).join('')}</tbody>
    </table>
  </details>`;
    })
    .join('\n');

  const sev = report.stats.bySeverity;
  const tiles = SEVERITIES.map(
    (s) => `
    <div class="tile">
      <div class="tile-n" style="color:${SEVERITY_COLOR[s]}">${sev[s]}</div>
      <div class="tile-l">${s}</div>
    </div>`,
  ).join('');

  // A run whose tools mostly failed must say so at the top, not bury it. Zero
  // findings from a dead tool looks exactly like a clean site otherwise.
  const banner =
    report.integrity.ok && report.integrity.warnings.length === 0
      ? ''
      : `
  <div class="banner ${report.integrity.ok ? 'warn' : 'bad'}">
    <strong>${
      report.integrity.ok
        ? 'This run is incomplete.'
        : 'This run cannot be trusted. Do not report from it.'
    }</strong>
    <ul>${report.integrity.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
  </div>`;

  const issueSections = report.issues
    .map((issue) => {
      const examples = issue.examples
        .map((example) => {
          const where = example.selector ?? example.target ?? '';
          const measured =
            example.measured !== undefined
              ? `<span class="meas">${escapeHtml(example.measured)}${
                  example.expected !== undefined ? ` → needs ${escapeHtml(example.expected)}` : ''
                }</span>`
              : '';
          return `
          <li>
            <a href="${escapeHtml(example.url)}" target="_blank" rel="noopener">${escapeHtml(
              example.url,
            )}</a>
            ${where ? `<div><code>${escapeHtml(String(where).slice(0, 150))}</code>${measured}</div>` : measured}
          </li>`;
        })
        .join('');

      return `
  <details class="issue">
    <summary>
      <span class="sev" style="background:${SEVERITY_COLOR[issue.severity]}">${issue.severity}</span>
      <span class="scope" style="background:${SCOPE_COLOR[issue.scope]}">${issue.scope}</span>
      <span class="host">${escapeHtml(issue.title)}</span>
      <span class="reach">${issue.sitesAffected} site(s) · ${issue.occurrences}×</span>
    </summary>
    <div class="issue-body">
      <h4>What is wrong</h4>
      <p>${escapeHtml(issue.whatIsWrong)}</p>
      <h4>How to fix it</h4>
      <p>${escapeHtml(issue.howToFix)}</p>
      ${
        issue.standards && issue.standards.length > 0
          ? `<div class="std">${issue.standards.map((s) => `<span>${escapeHtml(s)}</span>`).join('')}</div>`
          : ''
      }
      <h4>Where (${issue.pagesAffected} page(s) affected)</h4>
      <ul class="ex">${examples}</ul>
      <div class="detail">Rule <code>${escapeHtml(issue.key)}</code>${
        issue.helpUrl
          ? ` · <a href="${escapeHtml(issue.helpUrl)}" target="_blank" rel="noopener">docs</a>`
          : ''
      }</div>
    </div>
  </details>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>webip scan report</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --card:#fafaf9; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0c0a09; --fg:#e7e5e4; --muted:#a8a29e; --line:#292524; --card:#1c1917; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing:-.01em; }
  .meta { color: var(--muted); font-size: .875rem; margin-bottom: 1.5rem; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:.75rem; margin-bottom:2rem; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:.85rem 1rem; }
  .tile-n { font-size:1.65rem; font-weight:650; line-height:1.1; font-variant-numeric:tabular-nums; }
  .tile-l { color:var(--muted); font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; }
  details.site { border:1px solid var(--line); border-radius:10px; margin-bottom:.6rem; background:var(--card); }
  summary { cursor:pointer; padding:.8rem 1rem; display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }
  summary::-webkit-details-marker { display:none; }
  summary::before { content:"▸"; color:var(--muted); }
  details[open] summary::before { content:"▾"; }
  .host { font-weight:600; }
  .badges { display:flex; gap:.3rem; flex-wrap:wrap; }
  .total { margin-left:auto; color:var(--muted); font-size:.8rem; }
  .sev { color:#fff; border-radius:999px; padding:.1rem .5rem; font-size:.7rem; font-weight:600;
         text-transform:uppercase; letter-spacing:.03em; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; font-size:.85rem; }
  th { text-align:left; color:var(--muted); font-weight:600; font-size:.7rem; text-transform:uppercase;
       letter-spacing:.05em; padding:.5rem .75rem; border-top:1px solid var(--line); }
  td { padding:.6rem .75rem; border-top:1px solid var(--line); vertical-align:top; }
  td.tool { color:var(--muted); white-space:nowrap; }
  .title { font-weight:500; }
  .detail { color:var(--muted); font-size:.8rem; margin-top:.2rem; }
  .loc { margin-top:.3rem; }
  .loc code, td code { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
                       background:rgba(120,113,108,.12); padding:.1rem .3rem; border-radius:4px;
                       word-break:break-all; }
  .mult { color:var(--muted); font-size:.75rem; }
  .help { font-size:.75rem; }
  td.url { max-width:220px; word-break:break-all; }
  a { color:inherit; }
  .cat { color:var(--muted); font-size:.68rem; text-transform:uppercase; letter-spacing:.04em; }
  .fix { margin-top:.35rem; font-size:.8rem; }
  .fix strong { font-weight:600; }
  .std { display:flex; gap:.3rem; flex-wrap:wrap; margin-top:.35rem; }
  .std span { font-size:.68rem; color:var(--muted); border:1px solid var(--line);
              border-radius:999px; padding:.05rem .45rem; white-space:nowrap; }
  ul.inst { margin:.45rem 0 0; padding-left:1.1rem; }
  ul.inst li { margin-bottom:.35rem; }
  .meas { font-size:.75rem; color:var(--muted); margin-left:.4rem; white-space:nowrap; }
  .imsg { color:var(--muted); font-size:.78rem; margin-top:.1rem; }
  .isnip { margin-top:.15rem; }
  .more { color:var(--muted); font-size:.75rem; margin-top:.3rem; font-style:italic; }
  .banner { border-radius:10px; padding:.85rem 1rem; margin-bottom:1.5rem;
            border:1px solid; font-size:.875rem; }
  .banner.bad { border-color:#b91c1c; background:rgba(185,28,28,.09); }
  .banner.warn { border-color:#a16207; background:rgba(161,98,7,.09); }
  .banner ul { margin:.4rem 0 0; padding-left:1.1rem; }
  details.issue { border:1px solid var(--line); border-radius:10px; margin-bottom:.5rem;
                  background:var(--card); }
  .scope { font-size:.65rem; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
           border-radius:999px; padding:.1rem .5rem; color:#fff; white-space:nowrap; }
  .reach { margin-left:auto; color:var(--muted); font-size:.8rem; white-space:nowrap; }
  .issue-body { padding:0 1rem 1rem; }
  .issue-body h4 { margin:.7rem 0 .25rem; font-size:.7rem; text-transform:uppercase;
                   letter-spacing:.05em; color:var(--muted); font-weight:600; }
  .issue-body p { margin:0; }
  .ex { list-style:none; margin:.3rem 0 0; padding:0; }
  .ex li { padding:.35rem 0; border-top:1px solid var(--line); font-size:.82rem; }
  h2 { font-size:1.1rem; margin:2rem 0 .75rem; letter-spacing:-.01em; }
</style>
</head>
<body>
<div class="wrap">
  <h1>webip scan report</h1>
  <div class="meta">
    ${escapeHtml(report.startedAt)} · ${report.stats.sitesScanned} sites ·
    ${report.stats.pagesFastLane} pages fast lane · ${report.stats.pagesBrowserLane} pages browser lane ·
    ${Math.round(report.durationMs / 1000)}s · ${report.stats.findingsTotal} findings
    (${report.stats.occurrencesTotal} occurrences)
  </div>
  ${banner}
  <div class="tiles">${tiles}</div>
  <h2>Issues &mdash; ${report.issues.length} distinct defects</h2>
  ${issueSections}
  <h2>Findings by site</h2>
  ${siteSections}
</div>
</body>
</html>`;
}

/** Writes findings.json and report.html; returns their paths. */
export async function writeReport(
  report: RunReport,
  outDir: string,
): Promise<{ json: string; html: string }> {
  await mkdir(outDir, { recursive: true });

  const json = path.join(outDir, 'findings.json');
  const html = path.join(outDir, 'report.html');

  await Promise.all([
    writeFile(json, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(html, renderHtml(report), 'utf8'),
  ]);

  return { json, html };
}

/**
 * Assembles the consolidated report: the single JSON that answers
 * "what exactly is wrong with this website".
 *
 * Four layers, deliberately ordered from conclusion to raw evidence:
 *   integrity  can this run be trusted at all
 *   stats      the shape of the result
 *   issues     each defect once, explained, with its fix and its reach
 *   findings   every occurrence, pinned to a URL and a selector
 *   coverage   proof of what actually ran, so silence is never ambiguous
 */
export function buildReport(input: {
  startedAt: Date;
  finishedAt: Date;
  config: RunReport['config'];
  findings: Finding[];
  errors: string[];
  coverage: PageCoverage[];
  sitesScanned: number;
  pagesFastLane: number;
  pagesBrowserLane: number;
}): RunReport {
  const findings = sortFindings(input.findings);
  return {
    schema: 'webip/2',
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    config: input.config,
    integrity: assessIntegrity(input.coverage),
    stats: {
      sitesScanned: input.sitesScanned,
      pagesFastLane: input.pagesFastLane,
      pagesBrowserLane: input.pagesBrowserLane,
      findingsTotal: findings.length,
      occurrencesTotal: countOccurrences(findings),
      bySeverity: countBySeverity(findings),
      byCategory: countByCategory(findings),
      byAudience: countByAudience(findings),
      byTool: countByTool(findings),
    },
    issues: rollupIssues(findings, input.sitesScanned),
    findings,
    coverage: {
      byTool: summariseByTool(input.coverage),
      pages: input.coverage,
    },
    errors: input.errors,
  };
}
