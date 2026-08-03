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

import {
  countBySeverity,
  countByTool,
  groupBySite,
  severityRank,
  sortFindings,
} from './finding.js';
import { SEVERITIES, type Finding, type RunReport, type Severity } from './types.js';

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#b91c1c',
  serious: '#c2410c',
  moderate: '#a16207',
  minor: '#0369a1',
  info: '#57534e',
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

  console.log('\n  BY TOOL');
  for (const [tool, count] of Object.entries(stats.byTool).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${tool.padEnd(20)} ${String(count).padStart(6)}`);
  }

  // Which issues affect the most pages across the whole network? On a templated
  // platform like this one, a rule hitting 300 pages is one bug in one template.
  const byRule = new Map<string, { count: number; severity: Severity; title: string; sites: Set<string> }>();
  for (const f of report.findings) {
    const key = `${f.tool}/${f.rule}`;
    const entry = byRule.get(key);
    if (entry) {
      entry.count += f.count;
      entry.sites.add(f.site);
      if (severityRank(f.severity) < severityRank(entry.severity)) entry.severity = f.severity;
    } else {
      byRule.set(key, { count: f.count, severity: f.severity, title: f.title, sites: new Set([f.site]) });
    }
  }

  console.log('\n  TOP ISSUES (by pages affected)');
  const ranked = [...byRule.entries()]
    .sort(
      (a, b) =>
        severityRank(a[1].severity) - severityRank(b[1].severity) || b[1].count - a[1].count,
    )
    .slice(0, limit);

  for (const [rule, entry] of ranked) {
    console.log(
      `    [${entry.severity.padEnd(8)}] ${rule.slice(0, 44).padEnd(44)} ${String(entry.count).padStart(5)}×  ${entry.sites.size} site(s)`,
    );
  }

  if (report.errors.length > 0) {
    console.log(`\n  SCAN ERRORS: ${report.errors.length} (see findings.json)`);
    for (const err of report.errors.slice(0, 5)) console.log(`    ${err.slice(0, 110)}`);
  }

  console.log(`\n${line}\n`);
}

function renderFindingRow(f: Finding): string {
  const location = f.location?.selector ?? f.location?.snippet ?? '';
  const line = f.location?.line !== undefined ? `:${f.location.line}` : '';
  return `
    <tr>
      <td><span class="sev" style="background:${SEVERITY_COLOR[f.severity]}">${f.severity}</span></td>
      <td class="tool">${escapeHtml(f.tool)}</td>
      <td><code>${escapeHtml(f.rule)}</code>${f.count > 1 ? ` <span class="mult">×${f.count}</span>` : ''}</td>
      <td>
        <div class="title">${escapeHtml(f.title)}</div>
        ${f.detail ? `<div class="detail">${escapeHtml(f.detail)}</div>` : ''}
        ${location ? `<div class="loc"><code>${escapeHtml(location.slice(0, 160))}${line}</code></div>` : ''}
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
</style>
</head>
<body>
<div class="wrap">
  <h1>webip scan report</h1>
  <div class="meta">
    ${escapeHtml(report.startedAt)} · ${report.stats.sitesScanned} sites ·
    ${report.stats.pagesFastLane} pages fast lane · ${report.stats.pagesBrowserLane} pages browser lane ·
    ${Math.round(report.durationMs / 1000)}s · ${report.stats.findingsTotal} findings
  </div>
  <div class="tiles">${tiles}</div>
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

/** Assembles the final report object from raw findings. */
export function buildReport(input: {
  startedAt: Date;
  finishedAt: Date;
  config: RunReport['config'];
  findings: Finding[];
  errors: string[];
  sitesScanned: number;
  pagesFastLane: number;
  pagesBrowserLane: number;
}): RunReport {
  const findings = sortFindings(input.findings);
  return {
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    config: input.config,
    stats: {
      sitesScanned: input.sitesScanned,
      pagesFastLane: input.pagesFastLane,
      pagesBrowserLane: input.pagesBrowserLane,
      findingsTotal: findings.length,
      bySeverity: countBySeverity(findings),
      byTool: countByTool(findings),
    },
    findings,
    errors: input.errors,
  };
}
