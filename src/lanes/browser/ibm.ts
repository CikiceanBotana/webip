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
    case 'potentialviolation':
      return 'moderate';
    case 'recommendation':
      return 'minor';
    case 'manual':
      return 'info';
    default:
      return null; // 'pass' and anything unknown are dropped
  }
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

    findings.push(
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'browser',
        tool: 'ibm-equal-access',
        rule: result.ruleId ?? 'unknown',
        severity,
        title: result.message ?? result.ruleId ?? 'Accessibility issue',
        location: {
          ...(result.path?.dom ? { selector: result.path.dom } : {}),
          ...(result.snippet ? { snippet: truncate(result.snippet, 160) } : {}),
        },
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
