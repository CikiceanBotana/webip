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
import type { Finding, FindingInstance, PageTarget, Severity } from '../../core/types.js';

/** Categories worth reporting on, and how seriously to take a failure in each. */
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'] as const;
type CategoryId = (typeof CATEGORIES)[number];

/**
 * One row of an audit's evidence table.
 *
 * This is where Lighthouse puts the specifics: which image is oversized and by
 * how many bytes, which element fails contrast, which script blocks rendering.
 * An earlier version read only the audit score and threw this away, which meant
 * the report could say "Performance 46/100" but not name a single cause.
 */
interface LhItem {
  url?: string;
  node?: { selector?: string; snippet?: string; nodeLabel?: string; explanation?: string };
  source?: { url?: string; line?: number; column?: number } | string;
  totalBytes?: number;
  wastedBytes?: number;
  wastedMs?: number;
  label?: string;
}

interface LhAudit {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  details?: { type?: string; items?: LhItem[] };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/** Pulls the concrete evidence rows out of an audit. */
function instancesOf(audit: LhAudit): FindingInstance[] {
  const items = audit.details?.items ?? [];
  const out: FindingInstance[] = [];

  for (const item of items) {
    const instance: FindingInstance = {};

    if (item.node?.selector) instance.selector = item.node.selector;
    if (item.node?.snippet) instance.snippet = truncate(item.node.snippet, 160);
    if (item.url) instance.target = item.url;
    else if (typeof item.source === 'string') instance.target = item.source;
    else if (item.source?.url) {
      instance.target = item.source.url;
      if (item.source.line !== undefined) instance.line = item.source.line;
      if (item.source.column !== undefined) instance.column = item.source.column;
    }

    const explanation = item.node?.explanation ?? item.node?.nodeLabel ?? item.label;
    if (explanation) instance.message = truncate(explanation, 220);

    // Quantify the cost when Lighthouse measured one.
    const costs: string[] = [];
    if (item.totalBytes !== undefined) costs.push(formatBytes(item.totalBytes));
    if (item.wastedBytes !== undefined) costs.push(`${formatBytes(item.wastedBytes)} wasted`);
    if (item.wastedMs !== undefined) costs.push(`${Math.round(item.wastedMs)}ms wasted`);
    if (costs.length > 0) instance.measured = costs.join(', ');

    if (Object.keys(instance).length > 0) out.push(instance);
  }

  return out;
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
 * tidy up afterwards, so the timeline has to be cleared between runs.
 */
function resetUserTiming(): void {
  try {
    performance.clearMarks();
    performance.clearMeasures();
  } catch {
    /* not fatal */
  }
}

/**
 * Lighthouse runs are serialised across the WHOLE process, not just per worker.
 *
 * `performance` is a single global object per Node process. Each browser worker
 * has its own Chromium on its own CDP port, so the browsers cannot collide --
 * but two workers calling Lighthouse at the same time share one User Timing
 * timeline, and each one's clearMarks() erases the marks the other is midway
 * through recording. The loser then dies with "the 'start lh:driver:navigate'
 * performance mark has not been set".
 *
 * That is not a hypothetical: on a 120-page pilot with two workers it produced
 * 56 failures -- every scan error in the run, and roughly a quarter of all
 * Lighthouse attempts. The retry could not help, because the competing worker
 * was still running when the retry fired.
 *
 * So Lighthouse is process-wide serial. It is the slowest check by far, but
 * correctness is not negotiable for throughput, and the other lane keeps both
 * browsers busy meanwhile.
 */
let lighthouseLock: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = lighthouseLock.then(fn, fn);
  lighthouseLock = run.catch(() => undefined);
  return run;
}

async function runLighthouseOnce(target: PageTarget, opts: LighthouseOptions): Promise<Lhr | undefined> {
  return serialize(async () => {
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
  });
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
        category: 'scan',
        severity: 'moderate',
        title: `Lighthouse could not analyse the page: ${lhr.runtimeError.code}`,
        detail: lhr.runtimeError.message ?? 'Lighthouse aborted before producing a report.',
        remedy:
          'This is a scan failure, not a site defect. The page was not assessed for performance, SEO or best practices.',
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
          lighthouseCategory: categoryId,
          severity: severityForScore(category.score),
          title: `${category.title ?? categoryId} score ${Math.round(category.score * 100)}/100`,
          detail: `Lighthouse scored this page ${Math.round(category.score * 100)} out of 100 for ${category.title ?? categoryId}. The individual audits that cost points are reported alongside this.`,
          remedy: 'Work through the failing audits for this category, reported as separate findings on the same page.',
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

      const instances = instancesOf(audit);
      findings.push(
        makeFinding({
          site: target.site,
          url: target.url,
          lane: 'browser',
          tool: 'lighthouse',
          rule: audit.id ?? ref.id,
          lighthouseCategory: categoryId,
          severity: severityForAudit(categoryId, audit.score),
          title: `${audit.title ?? ref.id}${audit.displayValue ? ` (${audit.displayValue})` : ''}`,
          detail: truncate(audit.description ?? '', 260) || undefined,
          // The audit description is Lighthouse's own fix guidance.
          remedy: truncate(audit.description ?? '', 260) || undefined,
          instances,
          count: Math.max(1, instances.length),
          ...(evidence ? { evidence } : {}),
        }),
      );
    }
  }

  return findings;
}
