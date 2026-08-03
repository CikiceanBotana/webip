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
 * Each entry below names a rule and the reason it is worth showing. If a rule
 * stops firing, the script says so loudly instead of silently shipping a
 * shorter docs page -- a missing example means either the site was fixed or the
 * check regressed, and both are things a maintainer must be told about.
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
  /** Output file name, without extension. */
  file: string;
  /** `tool/rule` to look for. */
  match: string;
  /** Why this example is in the documentation. */
  why: string;
  /** Prefer a finding on this URL, when the rule fires on many pages. */
  preferUrl?: string;
  /** Prefer the finding with the most occurrences rather than the first. */
  preferBusiest?: boolean;
}

const WANTED: Wanted[] = [
  {
    file: 'navigation-missing',
    match: 'layout/no-mobile-navigation',
    why: 'Proved by interaction: every candidate toggle was clicked and the link count re-counted.',
  },
  {
    file: 'navigation-cramped',
    match: 'layout/mobile-navigation-cramped',
    why: 'The nav survives 390px but was never adapted -- measured in wrapped lines and pixel gaps.',
  },
  {
    file: 'contrast-over-image',
    match: 'contrast/contrast-over-image',
    why: 'The answer no static engine can give: text over a photo, scrim and translucent tint.',
    preferBusiest: true,
  },
  {
    file: 'contrast-static',
    match: 'axe-core/color-contrast',
    why: 'The same defect class on a solid background, where static analysis is exact.',
  },
  {
    file: 'screen-reader',
    match: 'ibm-equal-access/aria_navigation_label_unique',
    why: 'Assistive-technology finding carrying the WCAG criterion decoded from the vendor ruleset.',
  },
  {
    file: 'layout-overflow',
    match: 'layout/horizontal-overflow-mobile',
    why: 'Demonstrated, not inferred: the probe scrolls the page and reads the offset back.',
  },
  {
    file: 'markup-invalid',
    match: 'nu-validator/*',
    why: 'Spec conformance from the W3C validator, classified as developer-facing.',
    preferBusiest: true,
  },
  {
    file: 'seo-meta-description',
    match: 'lighthouse/meta-description',
    why: 'A page-level result: no element to point at, so the instance describes the document.',
  },
  {
    file: 'branding-favicon',
    match: 'branding/favicon-missing',
    why: 'Site-level check, verified against the network rather than the markup alone.',
  },
  {
    file: 'performance-lcp',
    match: 'lighthouse/largest-contentful-paint',
    why: 'A measurement, reported as info because it is a number and not yet a defect.',
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
  let pool = findings.filter((f) => f.tool === tool && (rule === '*' || f.rule === rule));
  if (pool.length === 0) return undefined;

  if (want.preferUrl) {
    const onUrl = pool.filter((f) => f.url === want.preferUrl);
    if (onUrl.length > 0) pool = onUrl;
  }
  if (want.preferBusiest) {
    return [...pool].sort((a, b) => b.instances.length - a.instances.length || b.count - a.count)[0];
  }
  return pool[0];
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

  await fs.mkdir(OUT_DIR, { recursive: true });
  const index: Array<Record<string, unknown>> = [];
  const missing: string[] = [];

  for (const want of WANTED) {
    const finding = pick(report.findings, want);
    if (!finding) {
      missing.push(want.match);
      continue;
    }
    const file = `${want.file}.json`;
    await fs.writeFile(
      path.join(OUT_DIR, file),
      `${JSON.stringify(forDocs(finding), null, 2)}\n`,
      'utf8',
    );
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
      `  ${file.padEnd(28)} ${`${finding.tool}/${finding.rule}`.padEnd(46)} ` +
        `${finding.severity.padEnd(8)} ${finding.audience.padEnd(14)} x${finding.count}`,
    );
  }

  await fs.writeFile(
    path.join(OUT_DIR, 'index.json'),
    `${JSON.stringify(
      {
        generatedFrom: input,
        schema: report.schema,
        sites: [...new Set(report.findings.map((f) => f.site))].sort(),
        examples: index,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

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
