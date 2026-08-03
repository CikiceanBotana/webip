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
  | 'html-validate'
  | 'nu-validator'
  | 'lychee'
  | 'semantics'
  | 'fetch';

/** Where in the document a finding lives. All fields optional. */
export interface FindingLocation {
  /** CSS selector, when the tool reports a DOM node. */
  selector?: string;
  /** Snippet of the offending markup, truncated. */
  snippet?: string;
  line?: number;
  column?: number;
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
  severity: Severity;
  /** One line, human readable. */
  title: string;
  /** Longer explanation, optional. */
  detail?: string;
  location?: FindingLocation;
  /** Repo-relative path to a screenshot. Evidence only -- never diffed. */
  evidence?: string;
  /** Upstream documentation for the rule. */
  helpUrl?: string;
  /**
   * How many times this same issue occurred on this page. Set by the deduper
   * when it collapses repeats (e.g. 40 images all missing alt text).
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

/** What a lane returns for one unit of work. */
export interface LaneResult {
  findings: Finding[];
  /** Non-fatal problems with the scan itself, not with the site. */
  errors: string[];
  /** Wall-clock ms. */
  durationMs: number;
}

/** Everything a run produces. */
export interface RunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: RunConfig;
  stats: {
    sitesScanned: number;
    pagesFastLane: number;
    pagesBrowserLane: number;
    findingsTotal: number;
    bySeverity: Record<Severity, number>;
    byTool: Record<string, number>;
  };
  findings: Finding[];
  errors: string[];
}
