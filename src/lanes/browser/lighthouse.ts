/**
 * Lighthouse.
 *
 * Driven over the CDP port that the worker's Chromium was launched with, so it
 * reuses an already-warm browser instead of starting its own. Lighthouse opens
 * its own tab, so it must not run while we are mid-analysis on another page in
 * the same browser -- the worker calls this strictly after the page checks.
 */

import lighthouse from 'lighthouse';

import { makeFinding, truncate } from '../../core/finding.js';
import type { Finding, PageTarget, Severity } from '../../core/types.js';

/** Categories worth reporting on, and how seriously to take a failure in each. */
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const;
type CategoryId = (typeof CATEGORIES)[number];

interface LhAudit {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
}

interface LhCategory {
  id?: string;
  title?: string;
  score?: number | null;
  auditRefs?: Array<{ id: string; weight?: number; group?: string }>;
}

interface Lhr {
  audits?: Record<string, LhAudit>;
  categories?: Record<string, LhCategory>;
  lighthouseVersion?: string;
  runtimeError?: { code?: string; message?: string };
}

/** Category score -> severity. Below 0.5 is a bad experience, not a nitpick. */
function severityForScore(score: number): Severity {
  if (score < 0.5) return 'serious';
  if (score < 0.75) return 'moderate';
  if (score < 0.9) return 'minor';
  return 'info';
}

/** A failed audit inherits urgency from its category and its own score. */
function severityForAudit(category: CategoryId, score: number): Severity {
  if (category === 'accessibility') return score === 0 ? 'serious' : 'moderate';
  if (score === 0) return 'moderate';
  if (score < 0.5) return 'minor';
  return 'info';
}

export interface LighthouseOptions {
  /** CDP port of an already-running Chromium. */
  port: number;
  timeoutMs: number;
  /** Emulate mobile (Lighthouse's default) or measure desktop. */
  formFactor?: 'mobile' | 'desktop';
}

/**
 * Lighthouse instruments itself with the global User Timing API and does not
 * tidy up afterwards. Across many runs in ONE long-lived Node process -- which
 * is exactly what a 6,800-page crawl is -- the leftover marks make a later run
 * die with "The 'start lh:driver:navigate' performance mark has not been set".
 * Clearing the timeline before each run makes runs independent.
 */
function resetUserTiming(): void {
  try {
    performance.clearMarks();
    performance.clearMeasures();
  } catch {
    /* not fatal */
  }
}

async function runLighthouseOnce(target: PageTarget, opts: LighthouseOptions): Promise<Lhr | undefined> {
  resetUserTiming();
  const run = await lighthouse(target.url, {
    port: opts.port,
    output: 'json',
    logLevel: 'error',
    onlyCategories: [...CATEGORIES],
    maxWaitForLoad: opts.timeoutMs,
    ...(opts.formFactor === 'desktop'
      ? { formFactor: 'desktop' as const, screenEmulation: { disabled: true } }
      : {}),
  });
  return run?.lhr as Lhr | undefined;
}

export async function checkLighthouse(
  target: PageTarget,
  opts: LighthouseOptions,
  evidence?: string,
): Promise<Finding[]> {
  let lhr: Lhr | undefined;

  // One retry. Lighthouse navigates the page itself, so a transient network
  // hiccup surfaces as ERRORED_DOCUMENT_REQUEST rather than as an exception --
  // retrying once separates a flaky fetch from a genuinely broken page.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lhr = await runLighthouseOnce(target, opts);
    } catch (err) {
      if (attempt === 1) throw err;
      lhr = undefined;
    }
    const failed =
      lhr === undefined ||
      (lhr.runtimeError?.code !== undefined && lhr.runtimeError.code !== 'NO_ERROR');
    if (!failed) break;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  if (!lhr) return [];

  if (lhr.runtimeError?.code && lhr.runtimeError.code !== 'NO_ERROR') {
    return [
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'browser',
        tool: 'lighthouse',
        rule: `runtime-${lhr.runtimeError.code}`,
        severity: 'moderate',
        title: `Lighthouse could not analyse the page: ${lhr.runtimeError.code}`,
        detail: lhr.runtimeError.message,
      }),
    ];
  }

  const findings: Finding[] = [];
  const audits = lhr.audits ?? {};

  for (const categoryId of CATEGORIES) {
    const category = lhr.categories?.[categoryId];
    if (!category || typeof category.score !== 'number') continue;

    // 1. The headline score for the category.
    if (category.score < 0.9) {
      findings.push(
        makeFinding({
          site: target.site,
          url: target.url,
          lane: 'browser',
          tool: 'lighthouse',
          rule: `category-${categoryId}`,
          severity: severityForScore(category.score),
          title: `${category.title ?? categoryId} score ${Math.round(category.score * 100)}/100`,
          ...(evidence ? { evidence } : {}),
        }),
      );
    }

    // 2. The individual audits that dragged it down.
    for (const ref of category.auditRefs ?? []) {
      const audit = audits[ref.id];
      if (!audit || typeof audit.score !== 'number') continue;

      // notApplicable/manual/informative carry no pass-fail meaning.
      const mode = audit.scoreDisplayMode ?? 'binary';
      if (mode === 'notApplicable' || mode === 'manual' || mode === 'informative') continue;
      if (audit.score >= 0.9) continue;
      // Zero-weight audits are diagnostics, not scored problems.
      if ((ref.weight ?? 0) === 0) continue;

      findings.push(
        makeFinding({
          site: target.site,
          url: target.url,
          lane: 'browser',
          tool: 'lighthouse',
          rule: audit.id ?? ref.id,
          severity: severityForAudit(categoryId, audit.score),
          title: `${audit.title ?? ref.id}${audit.displayValue ? ` (${audit.displayValue})` : ''}`,
          detail: truncate(audit.description ?? '', 260) || undefined,
          ...(evidence ? { evidence } : {}),
        }),
      );
    }
  }

  return findings;
}
