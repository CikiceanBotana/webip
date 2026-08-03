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
 * Reads the report, writes nothing, prints a ranked plan.
 *
 * Run: npm run analyze -- [path/to/findings.json]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { severityRank } from '../src/core/finding.js';
import { SEVERITIES, type Finding, type RunReport, type Severity } from '../src/core/types.js';

/** Weight used to rank sites. Roughly "how much would a user notice". */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  serious: 5,
  moderate: 2,
  minor: 1,
  info: 0,
};

/** A rule aggregated across the whole network. */
interface RuleRollup {
  key: string;
  tool: string;
  rule: string;
  severity: Severity;
  title: string;
  sites: Set<string>;
  pages: Set<string>;
  occurrences: number;
}

function rollupByRule(findings: readonly Finding[]): RuleRollup[] {
  const map = new Map<string, RuleRollup>();

  for (const f of findings) {
    const key = `${f.tool}/${f.rule}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        key,
        tool: f.tool,
        rule: f.rule,
        severity: f.severity,
        title: f.title,
        sites: new Set(),
        pages: new Set(),
        occurrences: 0,
      };
      map.set(key, entry);
    }
    entry.sites.add(f.site);
    entry.pages.add(f.url);
    entry.occurrences += f.count;
    // Keep the most severe classification and its wording.
    if (severityRank(f.severity) < severityRank(entry.severity)) {
      entry.severity = f.severity;
      entry.title = f.title;
    }
  }

  return [...map.values()];
}

function bySeverityThenReach(a: RuleRollup, b: RuleRollup): number {
  return severityRank(a.severity) - severityRank(b.severity) || b.sites.size - a.sites.size;
}

function printRules(rows: readonly RuleRollup[], limit: number, totalSites: number): void {
  for (const row of rows.slice(0, limit)) {
    const reach = ((row.sites.size / totalSites) * 100).toFixed(0);
    console.log(
      `    [${row.severity.padEnd(8)}] ${row.key.slice(0, 46).padEnd(46)} ` +
        `${String(row.sites.size).padStart(4)} sites (${reach.padStart(3)}%)  ` +
        `${String(row.occurrences).padStart(6)}×`,
    );
    console.log(`                 ${row.title.slice(0, 104)}`);
  }
  if (rows.length > limit) console.log(`    … and ${rows.length - limit} more`);
}

async function main(): Promise<void> {
  const file = process.argv[2] ?? 'out/pilot/findings.json';
  const report = JSON.parse(await readFile(path.resolve(file), 'utf8')) as RunReport;

  const findings = report.findings;
  const allSites = new Set(findings.map((f) => f.site));
  const totalSites = allSites.size;
  const rollups = rollupByRule(findings);

  const line = '─'.repeat(96);
  console.log(`\n${line}`);
  console.log('  FIX PLAN');
  console.log(
    `  ${findings.length} findings · ${rollups.length} distinct rules · ${totalSites} sites with findings`,
  );
  console.log(line);

  // A rule on a third or more of the network cannot be a coincidence of
  // content; it is baked into the template every tenant renders.
  const platformThreshold = Math.max(2, Math.ceil(totalSites * 0.33));
  const platform = rollups.filter((r) => r.sites.size >= platformThreshold).sort(bySeverityThenReach);
  const tenant = rollups.filter((r) => r.sites.size <= 2).sort(bySeverityThenReach);
  const middle = rollups
    .filter((r) => r.sites.size < platformThreshold && r.sites.size > 2)
    .sort(bySeverityThenReach);

  console.log(`\n  ▸ PLATFORM-WIDE  (on ≥${platformThreshold} of ${totalSites} sites — fix once, fixes everyone)`);
  if (platform.length === 0) console.log('    none');
  else printRules(platform, 20, totalSites);

  console.log(`\n  ▸ WIDESPREAD  (3..${platformThreshold - 1} sites — shared component or a common page type)`);
  if (middle.length === 0) console.log('    none');
  else printRules(middle, 12, totalSites);

  console.log('\n  ▸ TENANT-SPECIFIC  (1–2 sites — that tenant\'s own content)');
  if (tenant.length === 0) console.log('    none');
  else printRules(tenant, 12, totalSites);

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

  console.log(`\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
