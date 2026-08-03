/**
 * scripts/analyze.ts -- turn a findings.json into a fix plan.
 *
 * The scan answers "what is broken". On a network of 357 sites generated from
 * one platform template, that is the wrong unit of work. The useful question is
 * "is this broken ONCE or 357 times?", because those need completely different
 * responses:
 *
 *   PLATFORM   a rule firing across most tenants is one bug in the shared
 *              template. One fix, whole network.
 *   TENANT     a rule firing on one or two sites is that tenant's own content
 *              or configuration.
 *
 * The rollup itself lives in src/core/issues.ts and is already baked into the
 * report, so this script presents it rather than recomputing it -- the console
 * and the JSON can never disagree.
 *
 * Accepts either the consolidated findings.json or the stream.jsonl
 * write-ahead log left behind by a run that was killed before it finished.
 *
 * Run: npm run analyze -- [path/to/findings.json | path/to/stream.jsonl]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { collapse, countOccurrences, severityRank } from '../src/core/finding.js';
import { rollupIssues } from '../src/core/issues.js';
import { parseStream } from '../src/core/stream.js';
import {
  SEVERITIES,
  type Finding,
  type Issue,
  type RunReport,
  type Severity,
} from '../src/core/types.js';

/** Weight used to rank sites. Roughly "how much would a user notice". */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  serious: 5,
  moderate: 2,
  minor: 1,
  info: 0,
};

interface Loaded {
  findings: Finding[];
  issues: Issue[];
  totalSites: number;
  recovered: boolean;
}

/**
 * Reads either output. A killed run leaves only the JSONL, and recovering a
 * partial answer beats reporting nothing at all.
 */
async function load(file: string): Promise<Loaded> {
  const raw = await readFile(path.resolve(file), 'utf8');

  if (file.endsWith('.jsonl')) {
    const { findings } = parseStream(raw);
    const collapsed = collapse(findings);
    const totalSites = new Set(collapsed.map((f) => f.site)).size;
    return {
      findings: collapsed,
      issues: rollupIssues(collapsed, totalSites),
      totalSites,
      recovered: true,
    };
  }

  const report = JSON.parse(raw) as RunReport;
  const totalSites =
    report.stats?.sitesScanned ?? new Set(report.findings.map((f) => f.site)).size;
  return {
    findings: report.findings,
    // Reports written before the rollup existed have no issues array.
    issues: report.issues ?? rollupIssues(report.findings, totalSites),
    totalSites,
    recovered: false,
  };
}

function printIssues(issues: readonly Issue[], limit: number, totalSites: number): void {
  if (issues.length === 0) {
    console.log('    none');
    return;
  }
  for (const issue of issues.slice(0, limit)) {
    const reach = ((issue.sitesAffected / Math.max(totalSites, 1)) * 100).toFixed(0);
    console.log(
      `    [${issue.severity.padEnd(8)}] ${issue.key.slice(0, 46).padEnd(46)} ` +
        `${String(issue.sitesAffected).padStart(4)} sites (${reach.padStart(3)}%)  ` +
        `${String(issue.occurrences).padStart(6)}\u00d7`,
    );
    console.log(`                 ${issue.whatIsWrong.slice(0, 104)}`);
    console.log(`                 FIX: ${issue.howToFix.slice(0, 99)}`);
    const example = issue.examples[0];
    if (example) {
      const where = example.selector ?? example.target ?? '';
      console.log(
        `                 e.g. ${example.url.slice(0, 68)}${where ? `  ${String(where).slice(0, 40)}` : ''}`,
      );
    }
  }
  if (issues.length > limit) console.log(`    \u2026 and ${issues.length - limit} more`);
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'out/pilot/findings.json';
  const { findings, issues, totalSites, recovered } = await load(file);

  const line = '\u2500'.repeat(96);
  console.log(`\n${line}`);
  console.log('  FIX PLAN');
  if (recovered) {
    console.log('  RECOVERED FROM A PARTIAL RUN -- this is everything the write-ahead log held.');
  }
  console.log(
    `  ${findings.length} findings \u00b7 ${countOccurrences(findings)} occurrences \u00b7 ` +
      `${issues.length} distinct issues \u00b7 ${totalSites} sites`,
  );
  console.log(line);

  const platform = issues.filter((i) => i.scope === 'platform');
  const widespread = issues.filter((i) => i.scope === 'widespread');
  const tenant = issues.filter((i) => i.scope === 'tenant');

  console.log('\n  \u25b8 PLATFORM-WIDE  (most of the network \u2014 fix once in the template, fixes everyone)');
  printIssues(platform, 20, totalSites);

  console.log('\n  \u25b8 WIDESPREAD  (a shared component or one common page type)');
  printIssues(widespread, 12, totalSites);

  console.log("\n  \u25b8 TENANT-SPECIFIC  (1\u20132 sites \u2014 that tenant's own content)");
  printIssues(tenant, 12, totalSites);

  // --- worst sites ---------------------------------------------------------
  const siteScores = new Map<string, { score: number; counts: Record<Severity, number> }>();
  for (const f of findings) {
    let entry = siteScores.get(f.site);
    if (!entry) {
      entry = {
        score: 0,
        counts: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>,
      };
      siteScores.set(f.site, entry);
    }
    entry.score += SEVERITY_WEIGHT[f.severity] * f.count;
    entry.counts[f.severity] += f.count;
  }

  console.log('\n  ▸ WORST SITES  (weighted: critical×10 serious×5 moderate×2 minor×1)');
  const worst = [...siteScores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 15);
  for (const [site, entry] of worst) {
    const host = site.replace(/^https?:\/\//, '');
    console.log(
      `    ${String(entry.score).padStart(6)}  ${host.slice(0, 44).padEnd(44)} ` +
        `crit ${entry.counts.critical}  serious ${entry.counts.serious}  moderate ${entry.counts.moderate}`,
    );
  }

  // --- the single highest-leverage list ------------------------------------
  console.log('\n  \u25b8 START HERE  (severity \u00d7 reach)');
  const ranked = [...issues].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.sitesAffected * SEVERITY_WEIGHT[b.severity] -
        a.sitesAffected * SEVERITY_WEIGHT[a.severity],
  );
  for (const [index, issue] of ranked.slice(0, 8).entries()) {
    console.log(`    ${index + 1}. ${issue.title.slice(0, 88)}`);
    console.log(
      `       ${issue.severity} \u00b7 ${issue.scope} \u00b7 ${issue.sitesAffected} site(s) \u00b7 ${issue.occurrences} occurrence(s)`,
    );
    console.log(`       ${issue.howToFix.slice(0, 92)}`);
  }

  console.log(`\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
