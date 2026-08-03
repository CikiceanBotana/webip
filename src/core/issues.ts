/**
 * Rolling findings up into issues.
 *
 * A finding is "this rule fired on this page". An issue is "this rule is broken
 * across the network, here is what it is, here is the fix, here is how far it
 * reaches, and here are real examples".
 *
 * On a hub of 357 tenant sites generated from one template, the per-page view is
 * the wrong unit of work: 351 sites reporting the same attribute-case defect is
 * ONE template bug, not 351 bugs. Scope answers "fix once or fix everywhere":
 *
 *   platform    on a third or more of the sites -- baked into the shared template
 *   widespread  on a handful -- a shared component or one common page type
 *   tenant      on one or two -- that tenant's own content or configuration
 */

import { severityRank } from './finding.js';
import type { Category, Finding, Issue, IssueScope, Severity, ToolName } from './types.js';

/** Concrete examples kept per issue. Enough to see the pattern, not a dump. */
const EXAMPLES_PER_ISSUE = 8;
/** Affected origins listed per issue. */
const SITES_PER_ISSUE = 12;

/** A rule at or above this share of sites is in the shared template. */
const PLATFORM_SHARE = 0.33;
/** At or below this many sites, it is that tenant's own problem. */
const TENANT_MAX_SITES = 2;

interface Accumulator {
  key: string;
  tool: ToolName;
  rule: string;
  category: Category;
  severity: Severity;
  title: string;
  whatIsWrong?: string;
  howToFix?: string;
  standards?: string[];
  helpUrl?: string;
  sites: Set<string>;
  pages: Set<string>;
  occurrences: number;
  examples: Array<{ url: string } & Finding['instances'][number]>;
  /** Distinct occurrence shapes already shown, to keep examples varied. */
  shapes: Set<string>;
}

/** What makes one occurrence look different from another to a reader. */
function shapeOf(instance: Finding['instances'][number]): string {
  return `${instance.selector ?? ''}|${instance.target ?? ''}|${instance.measured ?? ''}`;
}

export function scopeFor(siteCount: number, totalSites: number): IssueScope {
  if (totalSites > 0 && siteCount >= Math.max(2, Math.ceil(totalSites * PLATFORM_SHARE))) {
    return 'platform';
  }
  return siteCount <= TENANT_MAX_SITES ? 'tenant' : 'widespread';
}

/**
 * Groups findings by tool+rule across the whole run.
 *
 * `totalSites` is the number of sites SCANNED, not the number with findings, so
 * "97% of the network" means what it says.
 */
export function rollupIssues(findings: readonly Finding[], totalSites: number): Issue[] {
  const map = new Map<string, Accumulator>();

  for (const finding of findings) {
    const key = `${finding.tool}/${finding.rule}`;
    let entry = map.get(key);

    if (!entry) {
      entry = {
        key,
        tool: finding.tool,
        rule: finding.rule,
        category: finding.category,
        severity: finding.severity,
        title: finding.title,
        ...(finding.detail !== undefined ? { whatIsWrong: finding.detail } : {}),
        ...(finding.remedy !== undefined ? { howToFix: finding.remedy } : {}),
        ...(finding.standards !== undefined ? { standards: finding.standards } : {}),
        ...(finding.helpUrl !== undefined ? { helpUrl: finding.helpUrl } : {}),
        sites: new Set(),
        pages: new Set(),
        occurrences: 0,
        examples: [],
        shapes: new Set(),
      };
      map.set(key, entry);
    }

    entry.sites.add(finding.site);
    entry.pages.add(finding.url);
    entry.occurrences += finding.count;

    // Keep the most severe classification and the wording that came with it.
    if (severityRank(finding.severity) < severityRank(entry.severity)) {
      entry.severity = finding.severity;
      entry.title = finding.title;
    }
    // Backfill explanation from whichever finding first carried one.
    if (entry.whatIsWrong === undefined && finding.detail !== undefined) {
      entry.whatIsWrong = finding.detail;
    }
    if (entry.howToFix === undefined && finding.remedy !== undefined) {
      entry.howToFix = finding.remedy;
    }
    if (entry.helpUrl === undefined && finding.helpUrl !== undefined) {
      entry.helpUrl = finding.helpUrl;
    }

    // Spread examples across pages rather than taking the first N from one page,
    // so a reader sees whether the defect is one page or the whole network.
    //
    // Prefer a shape not shown yet. On a templated network the same element
    // fails identically on every tenant, so taking the first instance of each
    // page fills the list with eight copies of one selector and teaches nothing.
    // Distinct selectors first, then repeats to demonstrate reach.
    if (entry.examples.length < EXAMPLES_PER_ISSUE) {
      const fresh = finding.instances.find(
        (instance) => !entry.shapes.has(shapeOf(instance)),
      );
      const chosen = fresh ?? finding.instances[0];
      if (chosen) {
        entry.shapes.add(shapeOf(chosen));
        entry.examples.push({ url: finding.url, ...chosen });
      } else {
        // A page-level rule has nothing below the URL to point at.
        entry.examples.push({ url: finding.url });
      }
    }
  }

  return [...map.values()]
    .map((entry): Issue => {
      const sites = [...entry.sites];
      return {
        key: entry.key,
        tool: entry.tool,
        rule: entry.rule,
        category: entry.category,
        severity: entry.severity,
        title: entry.title,
        whatIsWrong: entry.whatIsWrong ?? entry.title,
        howToFix: entry.howToFix ?? 'No automated guidance for this rule; review the linked documentation.',
        ...(entry.standards !== undefined ? { standards: entry.standards } : {}),
        ...(entry.helpUrl !== undefined ? { helpUrl: entry.helpUrl } : {}),
        scope: scopeFor(sites.length, totalSites),
        sitesAffected: sites.length,
        pagesAffected: entry.pages.size,
        occurrences: entry.occurrences,
        examples: entry.examples,
        sites: sites.slice(0, SITES_PER_ISSUE),
      };
    })
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        b.sitesAffected - a.sitesAffected ||
        b.occurrences - a.occurrences ||
        a.key.localeCompare(b.key),
    );
}
