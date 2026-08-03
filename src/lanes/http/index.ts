/**
 * The fast lane: everything that can be decided without a browser.
 *
 * Runs per site rather than per page, because two of its four checks are
 * process-based and batch far better than they parallelise:
 *
 *   fetch          pooled, N pages in flight
 *   semantics      in-process, per page
 *   html-validate  in-process, per page
 *   nu-validator   ONE java process for the whole site
 *   lychee         ONE process for the whole site
 *
 * Cheap enough to point at all 357 sites.
 */

import { CoverageTracker, countFindingsByUrl } from '../../core/coverage.js';
import { makeFinding } from '../../core/finding.js';
import { fetchPage, type FetchedPage } from '../../core/net.js';
import { mapPool } from '../../core/pool.js';
import type { Finding, LaneResult, PageTarget, RunConfig, ToolName } from '../../core/types.js';

import { checkLinks } from './links.js';
import { checkHtmlValidate, checkNuValidator, hasJava } from './markup.js';
import { checkSemantics, extractFormActions } from './semantics.js';

export interface HttpLaneOptions {
  concurrency: number;
  timeoutMs: number;
  tools: RunConfig['tools'];
  lycheeBin?: string;
  vnuHeapMb?: number;
}

/**
 * Probes for HEAD/GET divergence.
 *
 * Real defect found on sogood.business: `HEAD /` answers 404 with
 * application/json while `GET /` answers 200 with HTML. CDNs, uptime monitors,
 * link checkers and preflight probes all use HEAD, so the origin looks dead to
 * exactly the machinery that decides whether it is up.
 *
 * Run once per site, on the homepage -- it is an origin-level behaviour, so
 * repeating it per page would just be extra requests for the same answer.
 */
export async function checkTransport(
  target: PageTarget,
  getResult: FetchedPage,
  timeoutMs: number,
): Promise<Finding[]> {
  let head: FetchedPage;
  try {
    head = await fetchPage(target.url, { method: 'HEAD', timeoutMs });
  } catch {
    return [
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'http',
        tool: 'fetch',
        rule: 'head-request-fails',
        severity: 'moderate',
        title: 'HEAD request fails while GET succeeds',
        instances: [
          {
            target: target.url,
            message: 'HEAD threw while GET returned a body',
            measured: 'HEAD errors',
            expected: `HEAD ${getResult.status}`,
          },
        ],
      }),
    ];
  }

  const findings: Finding[] = [];

  if (head.ok !== getResult.ok || (head.status >= 400 && getResult.status < 400)) {
    findings.push(
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'http',
        tool: 'fetch',
        rule: 'head-get-mismatch',
        severity: 'serious',
        title: `HEAD returns ${head.status} but GET returns ${getResult.status}`,
        instances: [
          {
            target: target.url,
            message: `HEAD ${head.status} vs GET ${getResult.status}`,
            measured: `HEAD ${head.status}`,
            expected: `HEAD ${getResult.status}`,
          },
        ],
      }),
    );
  }

  const headType = (head.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
  const getType = (getResult.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
  if (headType !== '' && getType !== '' && headType !== getType) {
    findings.push(
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'http',
        tool: 'fetch',
        rule: 'head-get-content-type-mismatch',
        severity: 'moderate',
        title: `HEAD advertises "${headType}" but GET serves "${getType}"`,
        instances: [
          { target: target.url, measured: `HEAD: ${headType}`, expected: `GET: ${getType}` },
        ],
      }),
    );
  }

  return findings;
}

/**
 * Runs the whole fast lane over an arbitrary batch of pages. Never throws;
 * problems become errors[].
 *
 * Takes a flat page list rather than a single site on purpose. The two
 * process-based checks amortise over whatever they are handed, so a sweep of
 * 350 different homepages costs ONE java process, not 350. Batch composition is
 * the orchestrator's decision, not this function's.
 */
export async function runHttpLane(
  pages: readonly PageTarget[],
  opts: HttpLaneOptions,
): Promise<LaneResult> {
  const started = Date.now();
  const findings: Finding[] = [];
  const errors: string[] = [];
  const coverage = new CoverageTracker();

  /** Tools this lane is configured to run, for accurate "skipped" records. */
  const enabled: Array<[ToolName, boolean]> = [
    ['semantics', opts.tools.semantics],
    ['html-validate', opts.tools.htmlValidate],
    ['nu-validator', opts.tools.nuValidator],
    ['lychee', opts.tools.lychee],
  ];

  // --- fetch every page once, shared by all downstream checks ---------------
  const fetched = await mapPool(pages, opts.concurrency, async (page) => {
    coverage.page(page.url, page.site);
    try {
      const result = await fetchPage(page.url, { timeoutMs: opts.timeoutMs });
      coverage.status(page.url, page.site, result.status);
      coverage.record(page.url, page.site, 'fetch', 'ok');
      return { target: page, page: result };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(`fetch ${page.url}: ${reason}`);
      coverage.record(page.url, page.site, 'fetch', 'error', { reason });
      // Nothing downstream can run without a body. Say so explicitly rather
      // than leaving the page looking clean.
      coverage.skip(
        page.url,
        page.site,
        enabled.map(([tool]) => tool),
        'page could not be fetched',
      );
      findings.push(
        makeFinding({
          site: page.site,
          url: page.url,
          lane: 'http',
          tool: 'fetch',
          rule: 'unreachable',
          severity: 'critical',
          title: 'Page could not be fetched',
          detail: reason,
          instances: [{ target: page.url, message: reason }],
        }),
      );
      return null;
    }
  });

  const live = fetched.filter(
    (entry): entry is { target: PageTarget; page: FetchedPage } => entry !== null,
  );
  if (live.length === 0) {
    return { findings, errors, coverage: coverage.list(), durationMs: Date.now() - started };
  }

  // --- per-page, in-process checks ------------------------------------------
  if (opts.tools.semantics) {
    for (const { target: pageTarget, page } of live) {
      const produced = checkSemantics(pageTarget, page);
      findings.push(...produced);
      coverage.record(pageTarget.url, pageTarget.site, 'semantics', 'ok', {
        findings: produced.length,
      });
    }
  } else {
    for (const { target } of live) {
      coverage.record(target.url, target.site, 'semantics', 'skipped', { reason: 'disabled' });
    }
  }

  if (opts.tools.htmlValidate) {
    const perPage = await mapPool(live, opts.concurrency, async ({ target: t, page }) => {
      try {
        const produced = await checkHtmlValidate(t, page);
        coverage.record(t.url, t.site, 'html-validate', 'ok', { findings: produced.length });
        return produced;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        errors.push(`html-validate ${t.url}: ${reason}`);
        coverage.record(t.url, t.site, 'html-validate', 'error', { reason });
        return [];
      }
    });
    findings.push(...perPage.flat());
  } else {
    for (const { target } of live) {
      coverage.record(target.url, target.site, 'html-validate', 'skipped', { reason: 'disabled' });
    }
  }

  // --- batched, process-based checks ----------------------------------------
  // The transport probe is per ORIGIN, not per page: HEAD/GET divergence is a
  // server behaviour, so probing every page of a site would re-answer the same
  // question at N times the request cost.
  const firstPerSite = new Map<string, { target: PageTarget; page: FetchedPage }>();
  for (const entry of live) {
    if (!firstPerSite.has(entry.target.site)) firstPerSite.set(entry.target.site, entry);
  }

  // All three are independent, so the java process, the lychee process and the
  // HEAD probes all run at the same time.
  const [nuFindings, linkFindings, transportFindings] = await Promise.all([
    opts.tools.nuValidator
      ? checkNuValidator(live, {
          timeoutMs: Math.max(opts.timeoutMs, 180_000),
          heapMb: opts.vnuHeapMb ?? 512,
        }).catch((err: unknown) => {
          errors.push(`nu-validator: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Finding[];
        })
      : Promise.resolve([] as Finding[]),

    opts.tools.lychee
      ? checkLinks(
          live.map((l) => l.target),
          {
            ...(opts.lycheeBin !== undefined ? { bin: opts.lycheeBin } : {}),
            timeoutMs: Math.max(opts.timeoutMs, 300_000),
            maxConcurrency: opts.concurrency,
            // Form actions are submit targets, not links; GETting them proves
            // nothing and a POST-only endpoint answers 400.
            ignoreUrls: [...new Set(live.flatMap(({ page }) => extractFormActions(page)))],
          },
        ).catch((err: unknown) => {
          errors.push(`lychee: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Finding[];
        })
      : Promise.resolve([] as Finding[]),

    mapPool([...firstPerSite.values()], opts.concurrency, ({ target: t, page }) =>
      checkTransport(t, page, opts.timeoutMs).catch(() => [] as Finding[]),
    ).then((groups) => groups.flat()),
  ]);

  findings.push(...nuFindings, ...linkFindings, ...transportFindings);

  // The two process-based checks run over the whole batch at once, so their
  // outcome is per batch, not per page. Attribute it to every page the batch
  // carried, otherwise a failed JVM would leave 40 pages looking validated.
  const recordBatch = (tool: ToolName, skipReason: string | null, produced: Finding[]): void => {
    const counts = countFindingsByUrl(produced);
    const failed = errors.some((e) => e.startsWith(`${tool}:`));
    for (const { target } of live) {
      if (skipReason !== null) {
        coverage.record(target.url, target.site, tool, 'skipped', { reason: skipReason });
      } else if (failed) {
        coverage.record(target.url, target.site, tool, 'error', { reason: 'batch failed' });
      } else {
        coverage.record(target.url, target.site, tool, 'ok', {
          findings: counts.get(target.url) ?? 0,
        });
      }
    }
  };

  // The Nu validator returns an empty array when no JRE is on PATH, which is
  // indistinguishable from "this markup is valid". Ask separately, so a machine
  // without Java reports 40 pages as UNCHECKED rather than as clean.
  const nuSkipReason = !opts.tools.nuValidator
    ? 'disabled'
    : (await hasJava())
      ? null
      : 'no Java runtime on PATH';

  recordBatch('nu-validator', nuSkipReason, nuFindings);
  recordBatch('lychee', opts.tools.lychee ? null : 'disabled', linkFindings);

  return { findings, errors, coverage: coverage.list(), durationMs: Date.now() - started };
}
