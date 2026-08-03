/**
 * IBM equal-access (accessibility-checker).
 *
 * Complements axe rather than duplicating it: equal-access implements a
 * different, larger rule set (174 rules) mapped directly onto WCAG success
 * criteria, and reports "potential" issues that need human confirmation, which
 * axe simply omits.
 */

import * as aChecker from 'accessibility-checker';
import type { Page } from 'playwright';

import { makeFinding, truncate } from '../../core/finding.js';
import type { Finding, PageTarget, Severity } from '../../core/types.js';

interface IbmResult {
  ruleId?: string;
  level?: string;
  message?: string;
  snippet?: string;
  category?: string;
  help?: string;
  path?: { dom?: string; aria?: string };
  value?: [string, string];
}

/**
 * equal-access levels:
 *   violation           definite failure
 *   potentialviolation  needs a human to confirm
 *   recommendation      good practice
 *   manual              can only be checked by hand
 *   pass                fine
 */
function severityFromLevel(level: string | undefined): Severity | null {
  switch (level) {
    case 'violation':
      return 'serious';
    /**
     * equal-access could NOT decide these; it is asking a human to look.
     * Their messages say so in as many words -- "Verify color is not used as
     * the only visual means", "Check the keyboard focus indicator is visible",
     * "Confirm the word 'right' is not the only cue".
     *
     * Ranked as a moderate defect they outranked real ones and, worse, reached
     * the headline as things "a visitor would notice" while being unable to
     * name a single element to look at: one of them pointed at a stylesheet in
     * <head>. axe already treats its own undecided results this way, and the
     * reasoning is identical, so the convention is now shared.
     */
    case 'potentialviolation':
    case 'manual':
      return 'info';
    case 'recommendation':
      return 'minor';
    default:
      return null; // 'pass' and anything unknown are dropped
  }
}

/** Did equal-access decide, or is it asking a human to? */
function needsReview(level: string | undefined): boolean {
  return level === 'potentialviolation' || level === 'manual';
}

/**
 * equal-access states measured contrast inside its prose message, e.g.
 * "Text contrast of 1.02 with its background is less than the WCAG AA minimum
 * requirements for text of size 16px and weight normal". Lifting the numbers
 * into structured fields makes them sortable and comparable with axe's, which
 * reports the same defect from a different engine.
 */
function contrastOf(message: string | undefined): { measured: string; expected: string } | undefined {
  if (!message) return undefined;
  const found = /contrast of ([\d.]+)/i.exec(message);
  if (!found?.[1]) return undefined;
  const large = /large text|18pt|14pt bold/i.test(message);
  return { measured: `${found[1]}:1`, expected: large ? '3:1' : '4.5:1' };
}

/**
 * equal-access rule -> the WCAG success criteria it implements.
 *
 * Hand-writing this for 174 rules would be a large table that rots on every
 * upstream release. It is not necessary: the checker ships its own rulesets,
 * and each one is a list of checkpoints (`num`, `scId`, `name`, `wcagLevel`)
 * carrying the rules that test them. Decode that and every rule is mapped at
 * once, by the vendor, always in step with the installed version -- the same
 * approach axe gets through its `wcag143`-style tags.
 *
 * Built once per process and cached. A rule may implement more than one
 * criterion (`img_alt_redundant` fails both 1.1.1 and 2.4.4), so this is a
 * one-to-many map and every criterion is kept.
 */
interface IbmCheckpoint {
  num?: string;
  name?: string;
  wcagLevel?: string;
  rules?: Array<{ id?: string }>;
}

let wcagByRule: Map<string, string[]> | null = null;

async function standardsForRule(ruleId: string | undefined): Promise<string[] | undefined> {
  if (!ruleId) return undefined;

  if (wcagByRule === null) {
    const collected = new Map<string, Set<string>>();
    try {
      const rulesets = (await (
        aChecker as unknown as {
          getRulesets: () => Promise<Array<{ id?: string; checkpoints?: IbmCheckpoint[] }>>;
        }
      ).getRulesets()) as Array<{ id?: string; checkpoints?: IbmCheckpoint[] }>;

      // Prefer the newest WCAG ruleset; the IBM_* ones add house rules that are
      // not success criteria, and citing those as "WCAG" would be a lie.
      const wcagSets = rulesets.filter((set) => (set.id ?? '').startsWith('WCAG_'));
      const newest = wcagSets.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? '')).at(-1);

      for (const checkpoint of newest?.checkpoints ?? []) {
        if (!checkpoint.num) continue;
        const level = checkpoint.wcagLevel ? ` (${checkpoint.wcagLevel.toUpperCase()})` : '';
        const label = `WCAG SC ${checkpoint.num} ${checkpoint.name ?? ''}`.trim() + level;
        for (const rule of checkpoint.rules ?? []) {
          if (!rule.id) continue;
          const seen = collected.get(rule.id) ?? new Set<string>();
          seen.add(label);
          collected.set(rule.id, seen);
        }
      }
    } catch {
      // An unreadable ruleset costs the standards column, nothing else.
    }
    wcagByRule = new Map([...collected].map(([id, set]) => [id, [...set].sort()]));
  }

  return wcagByRule.get(ruleId);
}

/**
 * equal-access appends the entire finding as a URL-encoded fragment to its help
 * link, producing 800-character URLs. Keep the document, drop the fragment.
 */
function cleanHelpUrl(help: string | undefined): string | undefined {
  if (!help) return undefined;
  const hash = help.indexOf('#');
  return hash === -1 ? help : help.slice(0, hash);
}

/**
 * equal-access keeps engine state on the module, not per call, so two
 * concurrent getCompliance() calls interleave and corrupt each other's reports.
 * Serialise here rather than making every caller remember this -- the
 * constraint belongs to the tool, so the tool owns the lock.
 */
let ibmLock: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = ibmLock.then(fn, fn);
  ibmLock = run.catch(() => undefined);
  return run;
}

export async function checkIbm(
  target: PageTarget,
  page: Page,
  evidence?: string,
): Promise<Finding[]> {
  const label = `${target.site}${new URL(target.url).pathname}`.replace(/[^\w.-]+/g, '_');
  const response = await serialize(() => aChecker.getCompliance(page, label));

  const results = (response?.report as { results?: IbmResult[] } | undefined)?.results ?? [];
  const findings: Finding[] = [];

  for (const result of results) {
    const severity = severityFromLevel(result.level);
    if (severity === null) continue;

    const standards = await standardsForRule(result.ruleId);

    findings.push(
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'browser',
        tool: 'ibm-equal-access',
        // Same naming as axe's undecided results, so "did an engine actually
        // decide this" is answerable from the rule id alone.
        rule: needsReview(result.level)
          ? `${result.ruleId ?? 'unknown'}-needs-review`
          : (result.ruleId ?? 'unknown'),
        severity,
        title: result.message ?? result.ruleId ?? 'Accessibility issue',
        // equal-access reports one result per element, so each finding carries
        // exactly one occurrence. `collapse` later merges the occurrences of a
        // rule on a page into one row WITHOUT discarding any of them, so the
        // per-element message -- "Text contrast of 1.02", not "contrast is
        // wrong" -- survives all the way into the report.
        instances: [
          {
            ...(result.path?.dom ? { selector: result.path.dom } : {}),
            ...(result.snippet ? { snippet: truncate(result.snippet, 160) } : {}),
            ...(result.message ? { message: truncate(result.message, 220) } : {}),
            ...(contrastOf(result.message) ?? {}),
          },
        ],
        ...(standards && standards.length > 0 ? { standards } : {}),
        ...(cleanHelpUrl(result.help) ? { helpUrl: cleanHelpUrl(result.help) as string } : {}),
        ...(evidence ? { evidence } : {}),
      }),
    );
  }

  return findings;
}

/** Releases the checker's internal browser/engine handles at end of run. */
export async function closeIbm(): Promise<void> {
  try {
    await aChecker.close();
  } catch {
    /* never started */
  }
}
