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

import { captureEvidence } from '../../core/evidence.js';
import type { Finding, LaneResult, PageTarget, RunConfig } from '../../core/types.js';

import { checkAxe } from './axe.js';
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
): Promise<Finding[]> {
  const findings: Finding[] = [];
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let evidence: string | undefined;

  const note = (stage: string, err: unknown): void => {
    errors.push(`${stage} ${target.url}: ${err instanceof Error ? err.message : String(err)}`);
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

    if (opts.tools.axe) {
      try {
        findings.push(...(await checkAxe(target, page, evidence)));
      } catch (err) {
        note('axe', err);
      }
    }

    if (opts.tools.ibm) {
      try {
        findings.push(...(await checkIbm(target, page, evidence)));
      } catch (err) {
        note('ibm', err);
      }
    }

    // Layout last of the in-page checks: it resizes the viewport for the
    // mobile pass, which would invalidate anything measured after it.
    if (opts.tools.layout) {
      try {
        findings.push(...(await checkLayout(target, page, { mobilePass: true }, evidence)));
      } catch (err) {
        note('layout', err);
      }
    }
  } catch (err) {
    note('navigate', err);
  } finally {
    try {
      await context?.close();
    } catch {
      /* already gone */
    }
  }

  // Lighthouse drives the browser itself, so it runs only once our own context
  // is closed and the browser is otherwise idle.
  if (opts.tools.lighthouse) {
    try {
      findings.push(
        ...(await checkLighthouse(
          target,
          { port: worker.cdpPort, timeoutMs: opts.timeoutMs },
          evidence,
        )),
      );
    } catch (err) {
      note('lighthouse', err);
    }
  }

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

  if (pages.length === 0) {
    return { findings, errors, durationMs: 0 };
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
      return { findings, errors, durationMs: Date.now() - started };
    }

    let cursor = 0;
    let completed = 0;

    await Promise.all(
      workers.map(async (worker) => {
        for (;;) {
          const index = cursor++;
          if (index >= pages.length) return;
          const target = pages[index] as PageTarget;

          const pageFindings = await inspectPage(target, worker, opts, errors);
          findings.push(...pageFindings);

          completed += 1;
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

  return { findings, errors, durationMs: Date.now() - started };
}
