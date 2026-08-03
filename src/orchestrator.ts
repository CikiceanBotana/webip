/**
 * The orchestrator: the spine that drives both lanes.
 *
 * Responsibilities, and nothing else:
 *   1. expand seeds into a work list
 *   2. decide which pages get which lane
 *   3. run the two lanes CONCURRENTLY
 *   4. collapse the findings and hand back a report
 *
 * It contains no checking logic. Every rule lives behind a lane adapter that
 * returns Finding[], so adding a tool never touches this file.
 *
 * The two lanes run at the same time on purpose. They contend for nothing --
 * the fast lane is network- and JVM-bound, the browser lane is CPU- and
 * memory-bound -- so a sweep of 350 homepages finishes while Chromium is still
 * grinding through the deep sites. Running them in sequence would waste the
 * entire fast-lane duration.
 */

import path from 'node:path';

import { HTTP_BATCH_CONCURRENCY, HTTP_BATCH_SIZE } from './core/config.js';
import { CoverageTracker } from './core/coverage.js';
import { collapse } from './core/finding.js';
import { labelOf } from './core/net.js';
import { chunk, mapPool, mapPoolSettled } from './core/pool.js';
import { buildReport } from './core/report.js';
import { RunStream } from './core/stream.js';
import type {
  Finding,
  PageCoverage,
  PageTarget,
  RunConfig,
  RunReport,
  SiteTarget,
} from './core/types.js';
import { discoverSites, pagesForSite } from './discover/index.js';
import { runBrowserLane } from './lanes/browser/index.js';
import { runHttpLane } from './lanes/http/index.js';

export interface ScanHooks {
  onPhase?: (phase: string, detail?: string) => void;
  onProgress?: (message: string) => void;
}

export interface ScanPlan {
  /** Every site discovered, capped by maxSites. */
  sites: SiteTarget[];
  /** Pages that get the full browser lane. */
  deepPages: PageTarget[];
  /** Pages that get the fast lane (a superset of deepPages). */
  fastPages: PageTarget[];
}

/**
 * Builds the work list with a two-tier expansion.
 *
 * Only the deep sites have their sitemaps fetched for a full page list; the
 * rest contribute their homepage alone. On a 357-site hub that is the
 * difference between 357 sitemap round trips and 15.
 */
export async function planScan(config: RunConfig, hooks: ScanHooks = {}): Promise<ScanPlan> {
  const discovered: string[] = [];

  for (const seed of config.seeds) {
    const { sites, isHub } = await discoverSites(seed, {
      timeoutMs: config.pageTimeoutMs,
      concurrency: config.httpConcurrency,
    });
    hooks.onProgress?.(
      `${seed} -> ${sites.length} site${sites.length === 1 ? '' : 's'}${isHub ? ' (hub: sitemap index)' : ''}`,
    );
    discovered.push(...sites);
  }

  const unique = [...new Set(discovered)].slice(0, config.maxSites);
  const deepCount = Math.min(config.deepSites, unique.length);
  const deepOrigins = unique.slice(0, deepCount);
  const shallowOrigins = unique.slice(deepCount);

  hooks.onProgress?.(
    `${unique.length} site(s) in scope: ${deepOrigins.length} deep (both lanes), ${shallowOrigins.length} homepage-only (fast lane)`,
  );

  // Deep sites: expand via sitemap, in parallel.
  const deepSites = await mapPoolSettled(deepOrigins, config.httpConcurrency, async (site) => {
    const pages = await pagesForSite(site, {
      maxPages: config.maxPagesPerSite,
      timeoutMs: config.pageTimeoutMs,
    });
    return { site, label: labelOf(site), pages } satisfies SiteTarget;
  });

  // Shallow sites: homepage only, no sitemap fetch needed.
  const shallowSites: SiteTarget[] = shallowOrigins.map((site) => ({
    site,
    label: labelOf(site),
    pages: [{ url: `${site}/`, site }],
  }));

  const sites = [
    ...deepSites.filter((s): s is SiteTarget => s !== null && s.pages.length > 0),
    ...shallowSites,
  ];

  const deepPages = sites
    .filter((s) => deepOrigins.includes(s.site))
    .flatMap((s) => s.pages);

  const fastPages = sites.flatMap((s) => s.pages);

  return { sites, deepPages, fastPages };
}

/** Runs the fast lane over every in-scope page, batched. */
async function runFastLane(
  plan: ScanPlan,
  config: RunConfig,
  hooks: ScanHooks,
  stream: RunStream | undefined,
): Promise<{ findings: Finding[]; errors: string[]; coverage: PageCoverage[] }> {
  const batches = chunk(plan.fastPages, HTTP_BATCH_SIZE);
  hooks.onProgress?.(
    `fast lane: ${plan.fastPages.length} pages in ${batches.length} batch(es) of ${HTTP_BATCH_SIZE}`,
  );

  let done = 0;
  const results = await mapPool(batches, HTTP_BATCH_CONCURRENCY, async (batch) => {
    const result = await runHttpLane(batch, {
      concurrency: config.httpConcurrency,
      timeoutMs: config.pageTimeoutMs,
      tools: config.tools,
      vnuHeapMb: 512,
    });
    done += 1;
    // Persist as soon as the batch exists, so a crash costs one batch, not
    // the whole sweep.
    stream?.findings(result.findings);
    stream?.coverage(result.coverage);
    stream?.errors(result.errors);
    hooks.onProgress?.(
      `fast lane batch ${done}/${batches.length} · ${batch.length} pages · ${result.findings.length} findings · ${Math.round(result.durationMs / 1000)}s`,
    );
    return result;
  });

  return {
    findings: results.flatMap((r) => r.findings),
    errors: results.flatMap((r) => r.errors),
    coverage: results.flatMap((r) => r.coverage),
  };
}

/** Runs the browser lane over the deep pages. */
async function runDeepLane(
  plan: ScanPlan,
  config: RunConfig,
  rootDir: string,
  hooks: ScanHooks,
  stream: RunStream | undefined,
): Promise<{ findings: Finding[]; errors: string[]; coverage: PageCoverage[] }> {
  if (plan.deepPages.length === 0 || !anyBrowserToolEnabled(config)) {
    return { findings: [], errors: [], coverage: [] };
  }

  hooks.onProgress?.(
    `browser lane: ${plan.deepPages.length} pages across ${config.browserConcurrency} Chromium worker(s)`,
  );

  const result = await runBrowserLane(plan.deepPages, {
    concurrency: config.browserConcurrency,
    cdpBasePort: config.cdpBasePort,
    timeoutMs: config.pageTimeoutMs,
    tools: config.tools,
    screenshots: config.screenshots,
    outDir: path.resolve(rootDir, config.outDir),
    rootDir,
    onFindings: (findings, coverage) => {
      stream?.findings(findings);
      stream?.coverage([coverage]);
    },
    onPage: (url, count, index, total) => {
      hooks.onProgress?.(`browser ${index}/${total} · ${count} findings · ${url}`);
    },
  });

  stream?.errors(result.errors);
  return { findings: result.findings, errors: result.errors, coverage: result.coverage };
}

function anyBrowserToolEnabled(config: RunConfig): boolean {
  const { axe, ibm, lighthouse, layout } = config.tools;
  return axe || ibm || lighthouse || layout;
}

/** Runs a full scan and returns the report. */
export async function runScan(
  config: RunConfig,
  rootDir: string,
  hooks: ScanHooks = {},
): Promise<RunReport> {
  const startedAt = new Date();

  hooks.onPhase?.('discover', 'expanding seeds');
  const plan = await planScan(config, hooks);

  if (plan.fastPages.length === 0) {
    throw new Error('Discovery produced no pages. Check the seed URL.');
  }

  hooks.onPhase?.(
    'scan',
    `${plan.fastPages.length} pages fast lane, ${plan.deepPages.length} pages browser lane`,
  );

  // A write-ahead log, opened before any work starts. Everything below also
  // lands in the consolidated JSON; this exists so that a run killed at hour
  // eleven is still worth something.
  const outDir = path.resolve(rootDir, config.outDir);
  const stream = await RunStream.open(outDir).catch(() => undefined);
  stream?.write({ type: 'meta', startedAt: startedAt.toISOString(), config });

  try {
    // Both lanes at once. Independent by construction: the browser lane loads
    // its own pages in Chromium and shares no state with the HTTP lane.
    const [fast, deep] = await Promise.all([
      runFastLane(plan, config, hooks, stream),
      runDeepLane(plan, config, rootDir, hooks, stream),
    ]);

    hooks.onPhase?.('report', 'consolidating findings');

    // Collapse repeats of the same rule on the same page into one row that
    // keeps every occurrence.
    const findings = collapse([...fast.findings, ...deep.findings]);

    // One page is inspected by both lanes, so the two coverage records for it
    // are merged rather than listed twice.
    const coverage = new CoverageTracker();
    coverage.merge(fast.coverage);
    coverage.merge(deep.coverage);

    return buildReport({
      startedAt,
      finishedAt: new Date(),
      config,
      findings,
      errors: [...fast.errors, ...deep.errors],
      coverage: coverage.list(),
      sitesScanned: plan.sites.length,
      pagesFastLane: plan.fastPages.length,
      pagesBrowserLane: plan.deepPages.length,
    });
  } finally {
    await stream?.close();
  }
}
