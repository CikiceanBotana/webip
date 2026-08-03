/**
 * What actually ran, and whether the run can be trusted.
 *
 * A page with zero findings is ambiguous: it is either clean, or every check
 * against it died. That ambiguity is not theoretical -- a previous run had every
 * Chromium killed while the Node parent survived, and because each page's errors
 * were caught and stepped over, the log kept printing "browser N/120 - 0
 * findings" and looked exactly like healthy progress.
 *
 * The fix is to record the outcome of every tool on every page, and then assert
 * over that record. A tool that errored on everything it touched is a broken
 * run, not a clean site, and the report says so in `integrity` instead of
 * quietly reporting nothing.
 */

import type {
  CheckRecord,
  CheckStatus,
  Finding,
  PageCoverage,
  RunIntegrity,
  ToolCoverage,
  ToolName,
} from './types.js';

/** How many findings each page received. Used to fill the coverage record. */
export function countFindingsByUrl(findings: readonly Finding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.url, (counts.get(finding.url) ?? 0) + 1);
  }
  return counts;
}

/** A tool failing at least this share of its attempts invalidates the run. */
const FATAL_ERROR_RATE = 1;
/** A tool failing at least this share is worth warning about. */
const WARN_ERROR_RATE = 0.25;

export class CoverageTracker {
  private readonly pages = new Map<string, PageCoverage>();

  /** Ensures a page exists in the record even before any tool reports. */
  page(url: string, site: string): PageCoverage {
    let entry = this.pages.get(url);
    if (!entry) {
      entry = { url, site, checks: {}, findings: 0 };
      this.pages.set(url, entry);
    }
    return entry;
  }

  /** HTTP status observed for this page. */
  status(url: string, site: string, status: number): void {
    this.page(url, site).status = status;
  }

  /** Records one tool's outcome on one page. */
  record(
    url: string,
    site: string,
    tool: ToolName,
    status: CheckStatus,
    detail?: { findings?: number; reason?: string },
  ): void {
    const page = this.page(url, site);
    const record: CheckRecord = { status };
    if (detail?.findings !== undefined) record.findings = detail.findings;
    if (detail?.reason !== undefined) record.reason = detail.reason;
    page.checks[tool] = record;
    page.findings = Object.values(page.checks).reduce((n, c) => n + (c.findings ?? 0), 0);
  }

  /** Marks a set of tools as deliberately not run. */
  skip(url: string, site: string, tools: readonly ToolName[], reason: string): void {
    for (const tool of tools) this.record(url, site, tool, 'skipped', { reason });
  }

  list(): PageCoverage[] {
    return [...this.pages.values()];
  }

  merge(other: readonly PageCoverage[]): void {
    for (const incoming of other) {
      const page = this.page(incoming.url, incoming.site);
      if (incoming.status !== undefined) page.status = incoming.status;
      Object.assign(page.checks, incoming.checks);
      page.findings = Object.values(page.checks).reduce((n, c) => n + (c.findings ?? 0), 0);
    }
  }
}

/** Per-tool totals across every page. */
export function summariseByTool(pages: readonly PageCoverage[]): Record<string, ToolCoverage> {
  const out: Record<string, ToolCoverage> = {};

  for (const page of pages) {
    for (const [tool, record] of Object.entries(page.checks)) {
      const entry = (out[tool] ??= { ran: 0, errored: 0, skipped: 0, findings: 0 });
      if (record.status === 'ok') {
        entry.ran += 1;
        entry.findings += record.findings ?? 0;
      } else if (record.status === 'error') {
        entry.errored += 1;
      } else {
        entry.skipped += 1;
      }
    }
  }

  return out;
}

/**
 * Turns the coverage record into a verdict.
 *
 * `ok: false` means the data is not safe to report from -- some tool failed on
 * everything it attempted, so its silence means "broken", not "clean".
 */
export function assessIntegrity(pages: readonly PageCoverage[]): RunIntegrity {
  const byTool = summariseByTool(pages);
  const warnings: string[] = [];
  let ok = true;

  for (const [tool, stats] of Object.entries(byTool)) {
    const attempted = stats.ran + stats.errored;
    if (attempted === 0) continue;

    const rate = stats.errored / attempted;
    if (rate >= FATAL_ERROR_RATE) {
      ok = false;
      warnings.push(
        `${tool} failed on all ${attempted} page(s) it attempted. Its silence means "broken", not "clean" -- do not report ${tool} results from this run.`,
      );
    } else if (rate >= WARN_ERROR_RATE) {
      warnings.push(
        `${tool} failed on ${stats.errored} of ${attempted} page(s) (${Math.round(rate * 100)}%). Its findings are incomplete.`,
      );
    }
  }

  const uninspected = pages.filter(
    (p) => Object.values(p.checks).every((c) => c.status !== 'ok'),
  );
  if (uninspected.length > 0) {
    warnings.push(
      `${uninspected.length} page(s) had no check complete successfully; they are unassessed, not clean.`,
    );
  }

  if (pages.length === 0) {
    ok = false;
    warnings.push('No page was inspected at all.');
  }

  return { ok, warnings };
}
