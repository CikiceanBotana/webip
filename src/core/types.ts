/**
 * The shared vocabulary of the whole tool.
 *
 * Every check in every lane -- axe, IBM equal-access, Lighthouse, the Nu
 * validator, html-validate, lychee, cheerio semantics, layout geometry --
 * normalises its native output into exactly one shape: `Finding`. The
 * orchestrator, the deduper, and the reporters then only ever speak `Finding`,
 * so adding a new tool never touches anything downstream.
 */

/** Ordered most severe first. Index in this array IS the sort rank. */
export const SEVERITIES = ['critical', 'serious', 'moderate', 'minor', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type LaneName = 'http' | 'browser';

/**
 * Which tool produced a finding. Kept as a closed union so the reporters can
 * group by tool without stringly-typed drift.
 */
export type ToolName =
  | 'axe-core'
  | 'ibm-equal-access'
  | 'lighthouse'
  | 'layout'
  | 'contrast'
  | 'branding'
  | 'html-validate'
  | 'nu-validator'
  | 'lychee'
  | 'semantics'
  | 'fetch';

/**
 * What kind of problem this is, independent of which tool found it.
 *
 * Tools overlap heavily -- axe, equal-access and Lighthouse all report contrast
 * -- so "which tool" is the wrong axis for a reader deciding what to fix.
 * Category is the axis that survives adding or removing a tool.
 */
export const CATEGORIES = [
  'accessibility',
  'markup',
  'links',
  'seo',
  'performance',
  'layout',
  'transport',
  'security',
  'scan',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * WHO is affected. Severity answers "how bad", this answers "bad for whom",
 * and without it a report sorts a trailing slash that affects nobody above a
 * dead checkout link. On one 357-site sweep, 76% of all occurrences were
 * developer-only spec deviations; they drowned 170 dead links.
 */
export const AUDIENCES = ['visitor', 'assistive-tech', 'search', 'developer'] as const;
export type Audience = (typeof AUDIENCES)[number];

/**
 * ONE concrete occurrence: the exact thing that is wrong, in one exact place.
 *
 * This is the unit that makes a report actionable. A finding that says
 * "12 links have no accessible name" is a statistic; twelve instances each
 * carrying a selector and the offending markup is a work list. Adapters must
 * emit every occurrence a tool reports, never just the first.
 */
export interface FindingInstance {
  /** CSS selector for the offending node. */
  selector?: string;
  /** The offending markup itself, truncated. */
  snippet?: string;
  /** 1-based source position, when the tool reports one. */
  line?: number;
  column?: number;
  /** What is wrong with THIS occurrence specifically. */
  message?: string;
  /** The value actually observed: "2.45:1", "32x20px", "418 KiB", "404". */
  measured?: string;
  /** The value required: "4.5:1", "24x24px". */
  expected?: string;
  /** The URL this instance is about: a broken link, an oversized asset. */
  target?: string;
}

export interface Finding {
  /** Stable content hash. Identical issues across runs share an id. */
  id: string;
  /** Origin, e.g. "https://pawdium.sogood.business". */
  site: string;
  /** Exact page URL the finding was observed on. */
  url: string;
  lane: LaneName;
  tool: ToolName;
  /** The tool's own rule identifier, e.g. "image-alt". */
  rule: string;
  /** Tool-independent classification. Always set. */
  category: Category;
  /** Who actually feels this. Always set. */
  audience: Audience;
  severity: Severity;
  /** One line, human readable. */
  title: string;
  /** Longer explanation of what is wrong and why it matters. */
  detail?: string;
  /** What to change, in the imperative. Always set when we know the rule. */
  remedy?: string;
  /** Standards this maps onto, e.g. ["WCAG 2.2 SC 1.4.3 (AA)"]. */
  standards?: string[];
  /**
   * Every occurrence of this issue on this page, each pinpointed.
   * Never empty for a DOM-level rule; page-level rules carry a single instance
   * describing the document.
   */
  instances: FindingInstance[];
  /** True when `count` exceeds the number of retained instances. */
  instancesTruncated?: boolean;
  /** Repo-relative path to a screenshot. Evidence only -- never diffed. */
  evidence?: string;
  /** Upstream documentation for the rule. */
  helpUrl?: string;
  /**
   * How many times this issue occurred on this page. Always the TRUE total,
   * even when `instances` was capped.
   */
  count: number;
}

/** One page queued for inspection. */
export interface PageTarget {
  url: string;
  site: string;
}

/** A site and the pages selected from it. */
export interface SiteTarget {
  /** Origin, used as the grouping key. */
  site: string;
  /** Human label, e.g. "pawdium". */
  label: string;
  pages: PageTarget[];
}

/** Fully resolved run configuration. */
export interface RunConfig {
  /** Hub or seed URLs to expand into a site list. */
  seeds: string[];
  /** Hard cap on sites taken from the seeds. */
  maxSites: number;
  /** Hard cap on pages per site for the deep (browser) lane. */
  maxPagesPerSite: number;
  /**
   * Sites that get the browser lane. The rest get the fast lane only.
   * Keeps a broad cheap sweep affordable alongside a narrow deep scan.
   */
  deepSites: number;
  /** Parallel fetches / fast-lane workers. */
  httpConcurrency: number;
  /** Parallel Chromium instances. Memory-bound: each is ~300MB+. */
  browserConcurrency: number;
  /** Toggle individual tools without editing code. */
  tools: {
    axe: boolean;
    ibm: boolean;
    lighthouse: boolean;
    layout: boolean;
    contrast: boolean;
    branding: boolean;
    htmlValidate: boolean;
    nuValidator: boolean;
    lychee: boolean;
    semantics: boolean;
  };
  /** Capture a screenshot as evidence for browser-lane findings. */
  screenshots: boolean;
  /** Per-page navigation/analysis timeout in ms. */
  pageTimeoutMs: number;
  /** Base CDP port; each browser worker gets basePort + workerIndex. */
  cdpBasePort: number;
  /** Where reports are written. */
  outDir: string;
}

/** Outcome of running one tool against one page. */
export type CheckStatus = 'ok' | 'error' | 'skipped';

export interface CheckRecord {
  status: CheckStatus;
  /** How many findings this tool produced here. Absent unless status is ok. */
  findings?: number;
  /** Why it failed or was skipped. */
  reason?: string;
}

/**
 * Proof of what was actually inspected.
 *
 * Without this a page with zero findings is ambiguous between "clean" and
 * "every check crashed" -- the exact failure mode that once made a whole run
 * look like progress while every browser check was dying. Coverage makes the
 * difference visible in the data instead of only in a log nobody re-reads.
 */
export interface PageCoverage {
  url: string;
  site: string;
  /** HTTP status seen by the fast lane, when it ran. */
  status?: number;
  /** Per-tool outcome, keyed by ToolName. */
  checks: Partial<Record<ToolName, CheckRecord>>;
  /** Total findings attributed to this page. */
  findings: number;
}

/** Per-tool totals across the whole run. */
export interface ToolCoverage {
  ran: number;
  errored: number;
  skipped: number;
  findings: number;
}

/**
 * A verdict on whether the run itself can be trusted.
 * `ok: false` means: do not report from this data.
 */
export interface RunIntegrity {
  ok: boolean;
  warnings: string[];
}

/** What a lane returns for one unit of work. */
export interface LaneResult {
  findings: Finding[];
  /** Non-fatal problems with the scan itself, not with the site. */
  errors: string[];
  /** What ran where. */
  coverage: PageCoverage[];
  /** Wall-clock ms. */
  durationMs: number;
}

/** How widely a rule reaches across the scanned network. */
export type IssueScope = 'platform' | 'widespread' | 'tenant';

/**
 * One rule, rolled up across every page it fired on.
 *
 * This is the layer that answers "what exactly is wrong with this website" in
 * one read: the plain-English defect, the fix, the standard it breaks, how far
 * it reaches, and concrete examples pinned to real URLs and selectors.
 */
export interface Issue {
  /** Stable key, "tool/rule". */
  key: string;
  tool: ToolName;
  rule: string;
  category: Category;
  audience: Audience;
  severity: Severity;
  /** Plain-English name of the defect. */
  title: string;
  /** Exactly what is wrong. */
  whatIsWrong: string;
  /** Exactly what to change. */
  howToFix: string;
  standards?: string[];
  helpUrl?: string;
  scope: IssueScope;
  sitesAffected: number;
  pagesAffected: number;
  /** True total occurrences across the run. */
  occurrences: number;
  /** Concrete, pinpointed samples. */
  examples: Array<{ url: string } & FindingInstance>;
  /** Sample of affected site origins. */
  sites: string[];
}

/** Everything a run produces. */
export interface RunReport {
  /** Format version, so consumers can detect a shape change. */
  schema: 'webip/2';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: RunConfig;
  integrity: RunIntegrity;
  stats: {
    sitesScanned: number;
    pagesFastLane: number;
    pagesBrowserLane: number;
    /** Distinct finding rows (one rule on one page). */
    findingsTotal: number;
    /** True total occurrences, summing every row's count. */
    occurrencesTotal: number;
    bySeverity: Record<Severity, number>;
    byCategory: Record<string, number>;
    byAudience: Record<string, number>;
    byTool: Record<string, number>;
  };
  /** Rolled up per rule: the fix plan. */
  issues: Issue[];
  /** Per page, per rule, with every occurrence pinpointed. */
  findings: Finding[];
  coverage: {
    byTool: Record<string, ToolCoverage>;
    pages: PageCoverage[];
  };
  errors: string[];
}
