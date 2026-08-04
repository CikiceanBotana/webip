/**
 * Extracts the worked examples used by `docs/CAPABILITIES.md` out of a real run.
 *
 * The documentation quotes JSON. Hand-copied JSON in a README rots the moment a
 * field is renamed and, worse, cannot be trusted: a reader has no way to tell an
 * illustrative sketch from something the tool actually emitted. So the examples
 * are not written by hand. They are lifted verbatim from `findings.json`, and
 * regenerating them is one command:
 *
 *   npm run examples -- out/showcase/findings.json
 *
 * Files are numbered, because the order is the argument. `00-headline.json` is
 * the answer to "what is wrong with my site"; everything after it is the
 * evidence for one line of that answer. An earlier version of this directory
 * shipped ten findings rows and no headline at all, which reproduced in
 * miniature the exact problem the headline exists to solve.
 *
 * Each entry below names a rule and why it is worth showing. If a rule stops
 * firing the script says so loudly rather than quietly shipping a shorter page:
 * a missing example means either the site was fixed or the check regressed, and
 * both are things a maintainer must be told about.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Finding, RunReport } from '../src/core/types.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = path.join(ROOT, 'docs/examples');

/** How many instances to keep per example. Enough to show the shape, not a data dump. */
const KEEP_INSTANCES = 3;

interface Wanted {
  /** Output file name, without extension. Numbered: the order is the argument. */
  file: string;
  /** `tool/rule` to look for; `*` matches any rule from that tool. */
  match: string;
  /** Why this example is in the documentation. */
  why: string;
  /** Prefer the finding with the most occurrences rather than the first. */
  preferBusiest?: boolean;
}

const WANTED: Wanted[] = [
  {
    file: '01-navigation-missing',
    match: 'layout/no-mobile-navigation',
    why: 'Proved by interaction: every candidate toggle was clicked and the links re-counted.',
  },
  {
    file: '02-navigation-cramped',
    match: 'layout/mobile-navigation-cramped',
    why: 'The nav survives 390px but was never adapted -- measured in wrapped lines and pixel gaps.',
  },
  {
    file: '03-contrast-over-image',
    match: 'contrast/contrast-over-image',
    why: 'The answer no static engine gives: text over a photo, a scrim and a translucent tint.',
    preferBusiest: true,
  },
  {
    file: '04-contrast-static',
    match: 'axe-core/color-contrast',
    why: 'The same defect on a solid background, where static analysis is exact and is trusted.',
  },
  {
    file: '05-layout-overflow',
    match: 'layout/horizontal-overflow-mobile',
    why: 'Demonstrated, not inferred: the probe scrolls the page and reads the offset back.',
  },
  {
    file: '06-screen-reader',
    match: 'ibm-equal-access/aria_navigation_label_unique',
    why: 'Assistive-tech finding, carrying the WCAG criterion decoded from the vendor ruleset.',
  },
  {
    file: '07-markup-invalid',
    match: 'nu-validator/*',
    why: 'Spec conformance from the W3C validator, classified developer-facing so it cannot rank above a visible defect.',
    preferBusiest: true,
  },
  {
    file: '08-seo-meta-description',
    match: 'lighthouse/meta-description',
    why: 'A page-level result: no element to point at, so the instance describes the document.',
  },
  {
    file: '09-branding-favicon',
    match: 'branding/favicon-missing',
    why: 'Site-level check, verified against the network rather than against the markup alone.',
  },
  {
    file: '10-performance-lcp',
    match: 'lighthouse/largest-contentful-paint',
    why: 'A measurement, ranked low because a number is not yet a defect.',
  },
];

/** Trims a finding to what documentation should show, keeping every field name intact. */
function forDocs(finding: Finding): Record<string, unknown> {
  const trimmed: Record<string, unknown> = { ...finding };
  const instances = finding.instances.slice(0, KEEP_INSTANCES);
  trimmed.instances = instances;

  const notes: string[] = [];
  if (finding.instances.length > instances.length) {
    notes.push(
      `instances trimmed to ${KEEP_INSTANCES} of ${finding.instances.length} for documentation; ` +
        `count (${finding.count}) is the untouched total from the run`,
    );
  }

  // A real run attaches a screenshot under out/, which is gitignored -- so the
  // path would be dead in a committed example. Drop it rather than ship a
  // reference that resolves to nothing, and say that it exists.
  if ('evidence' in trimmed) {
    delete trimmed.evidence;
    notes.push('a screenshot is attached in the `evidence` field of the real finding');
  }

  if (notes.length > 0) trimmed['_note'] = notes.join('; ');
  return trimmed;
}

function pick(findings: Finding[], want: Wanted): Finding | undefined {
  const [tool, rule] = want.match.split('/');
  const pool = findings.filter((f) => f.tool === tool && (rule === '*' || f.rule === rule));
  if (pool.length === 0) return undefined;
  if (want.preferBusiest) {
    return [...pool].sort((a, b) => b.instances.length - a.instances.length || b.count - a.count)[0];
  }
  return pool[0];
}

async function write(file: string, value: unknown): Promise<void> {
  await fs.writeFile(path.join(OUT_DIR, file), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  const input = process.argv[2] ?? 'out/showcase/findings.json';
  const report = JSON.parse(await fs.readFile(path.resolve(ROOT, input), 'utf8')) as RunReport;

  if (!report.integrity?.ok) {
    console.error(
      `\nREFUSING to generate examples: integrity.ok is false in ${input}.\n` +
        `A tool failed on everything it attempted, so its silence means "broken", not "clean".\n`,
    );
    process.exitCode = 2;
    return;
  }

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const index: Array<Record<string, unknown>> = [];
  const missing: string[] = [];

  // 00 is the answer: the whole headline, exactly as findings.json opens.
  await write('00-headline.json', {
    _note:
      'The first thing in findings.json. Each line folds every engine that reported the ' +
      'same defect, and `where` names the visible text so it can be found by reading the ' +
      'page rather than by querying the DOM. Everything below it in the file is evidence.',
    headline: report.headline,
    headlineOmitted: report.headlineOmitted,
  });
  index.push({
    file: '00-headline.json',
    rule: '(the answer layer)',
    severity: report.headline[0]?.severity ?? 'none',
    occurrences: report.headline.reduce((sum, item) => sum + item.occurrences, 0),
    why: 'What a visitor would notice, grouped by problem rather than by engine.',
  });
  console.log(
    `  ${'00-headline.json'.padEnd(28)} ${String(report.headline.length).padStart(2)} line(s), ` +
      `${report.headlineOmitted} omitted`,
  );

  for (const want of WANTED) {
    const finding = pick(report.findings, want);
    if (!finding) {
      missing.push(want.match);
      continue;
    }
    const file = `${want.file}.json`;
    await write(file, forDocs(finding));
    index.push({
      file,
      rule: `${finding.tool}/${finding.rule}`,
      category: finding.category,
      audience: finding.audience,
      severity: finding.severity,
      site: finding.site,
      occurrences: finding.count,
      why: want.why,
    });
    console.log(
      `  ${file.padEnd(28)} ${`${finding.tool}/${finding.rule}`.slice(0, 44).padEnd(44)} ` +
        `${finding.severity.padEnd(8)} ${finding.audience.padEnd(14)} x${finding.count}`,
    );
  }

  await write('index.json', {
    generatedFrom: input,
    schema: report.schema,
    generatedBy: 'npm run examples -- <findings.json>  (never edited by hand)',
    integrity: report.integrity,
    sites: [...new Set(report.findings.map((f) => f.site))].sort(),
    totals: {
      headlineLines: report.headline.length,
      issueRows: report.issues.length,
      findingRows: report.findings.length,
      occurrences: report.stats.occurrencesTotal,
    },
    examples: index,
  });

  console.log(`\n  ${index.length} example(s) written to docs/examples/`);
  if (missing.length > 0) {
    console.error(
      `\n  ${missing.length} documented rule(s) produced NOTHING in this run:\n` +
        missing.map((m) => `    ${m}`).join('\n') +
        `\n  Either the site was fixed or the check regressed. Do not ship the docs until you know which.\n`,
    );
    process.exitCode = 1;
  }
}

await main();
