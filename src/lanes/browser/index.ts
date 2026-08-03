/**
 * The browser lane: a small pool of Chromium workers.
 *
 * Each worker owns one Chromium launched with its OWN CDP port, because
 * Lighthouse attaches over CDP and two workers sharing a port would audit each
 * other's tabs. Pool width is memory-bound, not CPU-bound: every worker is a
 * full browser at roughly 300MB, so the default is deliberately small.
 *
 * Within a worker, one page is processed at a time and strictly in this order:
 *
 *   navigate -> screenshot -> axe -> ibm -> layout -> close context -> lighthouse
 *
 * Screenshot first, because axe and equal-access both inject script into the
 * document and the evidence should show the page as shipped. Lighthouse last
 * and after the context is closed, because it drives the browser itself and
 * opens its own tab.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { CoverageTracker } from '../../core/coverage.js';
import { captureEvidence } from '../../core/evidence.js';
import type {
  Finding,
  LaneResult,
  PageCoverage,
  PageTarget,
  RunConfig,
  ToolName,
} from '../../core/types.js';

import { checkAxe } from './axe.js';
import { checkBranding } from './branding.js';
import { checkContrast } from './contrast.js';
import { checkIbm, closeIbm } from './ibm.js';
import { checkLayout } from './layout.js';
import { checkLighthouse } from './lighthouse.js';

export interface BrowserLaneOptions {
  concurrency: number;
  cdpBasePort: number;
  timeoutMs: number;
  tools: RunConfig['tools'];
  screenshots: boolean;
  outDir: string;
  rootDir: string;
  viewport?: { width: number; height: number };
  /** Called as each page finishes, for live progress. */
  onPage?: (url: string, findingCount: number, index: number, total: number) => void;
  /**
   * Called with each page's findings the moment they exist, so a caller can
   * persist them incrementally instead of waiting for the whole lane. A long
   * browser run is exactly the job that gets killed before it returns.
   */
  onFindings?: (findings: readonly Finding[], coverage: PageCoverage) => void;
}

interface Worker {
  browser: Browser;
  cdpPort: number;
}

async function launchWorker(cdpPort: number): Promise<Worker> {
  const browser = await chromium.launch({
    args: [
      `--remote-debugging-port=${cdpPort}`,
      // Chromium's default 64MB /dev/shm is not enough under sustained load;
      // in Docker this is solved with --shm-size=1gb instead.
      '--disable-dev-shm-usage',
    ],
  });
  return { browser, cdpPort };
}

/** Runs every configured browser check against one page. Never throws. */
async function inspectPage(
  target: PageTarget,
  worker: Worker,
  opts: BrowserLaneOptions,
  errors: string[],
  coverage: CoverageTracker,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let evidence: string | undefined;

  coverage.page(target.url, target.site);

  const note = (stage: ToolName, err: unknown): void => {
    const reason = err instanceof Error ? err.message : String(err);
    errors.push(`${stage} ${target.url}: ${reason}`);
    coverage.record(target.url, target.site, stage, 'error', { reason });
  };

  /** Runs one check and records whether it actually ran. */
  const run = async (
    tool: ToolName,
    enabled: boolean,
    check: () => Promise<Finding[]>,
  ): Promise<void> => {
    if (!enabled) {
      coverage.record(target.url, target.site, tool, 'skipped', { reason: 'disabled' });
      return;
    }
    try {
      const produced = await check();
      findings.push(...produced);

      // A tool can fail without throwing: Lighthouse returns a report whose
      // only content is "I could not analyse this page". Those are emitted with
      // category 'scan', and treating them as a successful check would put the
      // page back in the ambiguous state coverage exists to remove -- assessed
      // and clean, versus never assessed at all.
      const selfReported = produced.find((finding) => finding.category === 'scan');
      if (selfReported) {
        coverage.record(target.url, target.site, tool, 'error', {
          reason: selfReported.title,
        });
        return;
      }

      coverage.record(target.url, target.site, tool, 'ok', { findings: produced.length });
    } catch (err) {
      note(tool, err);
    }
  };

  try {
    context = await worker.browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();

    await page.goto(target.url, { waitUntil: 'load', timeout: opts.timeoutMs });
    // Let late CSS/webfonts/JS settle before anything measures geometry.
    await page.waitForTimeout(400);

    if (opts.screenshots) {
      const captured = await captureEvidence(page, {
        site: target.site,
        url: target.url,
        outDir: opts.outDir,
        rootDir: opts.rootDir,
      });
      if (captured) evidence = captured;
    }

    const live = page;
    await run('axe-core', opts.tools.axe, () => checkAxe(target, live, evidence));
    await run('ibm-equal-access', opts.tools.ibm, () => checkIbm(target, live, evidence));
    // Measured contrast BEFORE layout: it samples rendered pixels at the
    // desktop viewport, and layout resizes to a phone width for its mobile pass.
    await run('contrast', opts.tools.contrast, () => checkContrast(target, live, evidence));
    // Layout last of the in-page checks, for that same reason.
    // Branding only on the site root: the header is identical on every page, so
    // running it everywhere would report one missing favicon eight times.
    const isRoot = new URL(target.url).pathname.replace(/\/$/, '') === '';
    await run('branding', opts.tools.branding && isRoot, () =>
      checkBranding(target, live, evidence),
    );
    await run('layout', opts.tools.layout, () =>
      checkLayout(target, live, { mobilePass: true }, evidence),
    );
  } catch (err) {
    // Navigation failed, so nothing in-page ever got a chance. Record that
    // explicitly: a page with no findings because it never loaded is not clean.
    const reason = err instanceof Error ? err.message : String(err);
    errors.push(`navigate ${target.url}: ${reason}`);
    // Deliberately NOT recorded against 'fetch': that key belongs to the HTTP
    // lane, which fetched this same URL successfully over plain HTTP. The two
    // records are merged by key, so reusing it here would erase a true success
    // with a failure from a different operation. The in-page tools carry the
    // reason instead, which is where a reader would look for it anyway.
    for (const [tool, enabled] of [
      ['axe-core', opts.tools.axe],
      ['ibm-equal-access', opts.tools.ibm],
      ['layout', opts.tools.layout],
      ['contrast', opts.tools.contrast],
    ] as Array<[ToolName, boolean]>) {
      if (enabled) {
        coverage.record(target.url, target.site, tool, 'error', {
          reason: `page did not load: ${reason}`,
        });
      }
    }
  } finally {
    try {
      await context?.close();
    } catch {
      /* already gone */
    }
  }

  // Lighthouse drives the browser itself, so it runs only once our own context
  // is closed and the browser is otherwise idle.
  await run('lighthouse', opts.tools.lighthouse, () =>
    checkLighthouse(target, { port: worker.cdpPort, timeoutMs: opts.timeoutMs }, evidence),
  );

  return findings;
}

/**
 * Processes `pages` across a pool of browsers.
 *
 * Work is pulled from a shared cursor rather than pre-sharded, so a worker that
 * lands on a slow site does not leave the others idle.
 */
export async function runBrowserLane(
  pages: readonly PageTarget[],
  opts: BrowserLaneOptions,
): Promise<LaneResult> {
  const started = Date.now();
  const findings: Finding[] = [];
  const errors: string[] = [];
  const coverage = new CoverageTracker();

  if (pages.length === 0) {
    return { findings, errors, coverage: [], durationMs: 0 };
  }

  const width = Math.max(1, Math.min(opts.concurrency, pages.length));
  const workers: Worker[] = [];

  try {
    for (let i = 0; i < width; i += 1) {
      try {
        workers.push(await launchWorker(opts.cdpBasePort + i));
      } catch (err) {
        errors.push(
          `browser worker ${i} failed to launch: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (workers.length === 0) {
      errors.push('No Chromium workers could be launched; browser lane skipped.');
      return { findings, errors, coverage: coverage.list(), durationMs: Date.now() - started };
    }

    let cursor = 0;
    let completed = 0;

    await Promise.all(
      workers.map(async (worker) => {
        for (;;) {
          const index = cursor++;
          if (index >= pages.length) return;
          const target = pages[index] as PageTarget;

          const pageFindings = await inspectPage(target, worker, opts, errors, coverage);
          findings.push(...pageFindings);

          completed += 1;
          opts.onFindings?.(pageFindings, coverage.page(target.url, target.site));
          opts.onPage?.(target.url, pageFindings.length, completed, pages.length);
        }
      }),
    );
  } finally {
    await closeIbm();
    await Promise.all(
      workers.map(async (w) => {
        try {
          await w.browser.close();
        } catch {
          /* already closed */
        }
      }),
    );
  }

  return { findings, errors, coverage: coverage.list(), durationMs: Date.now() - started };
}
