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

import { makeFinding } from '../../core/finding.js';
import { fetchPage, type FetchedPage } from '../../core/net.js';
import { mapPool } from '../../core/pool.js';
import type { Finding, LaneResult, PageTarget, RunConfig } from '../../core/types.js';

import { checkLinks } from './links.js';
import { checkHtmlValidate, checkNuValidator } from './markup.js';
import { checkSemantics } from './semantics.js';

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
        detail:
          'Caches, monitors and link checkers issue HEAD before GET. If HEAD errors, they treat the URL as unreachable.',
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
        detail:
          'The same URL reports two different states depending on method. CDN caches, uptime monitors, link checkers and social-preview crawlers issue HEAD first and will treat this page as missing.',
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
        detail: 'Content negotiation differs by method, which breaks cache keys and content sniffing.',
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

  // --- fetch every page once, shared by all downstream checks ---------------
  const fetched = await mapPool(pages, opts.concurrency, async (page) => {
    try {
      return { target: page, page: await fetchPage(page.url, { timeoutMs: opts.timeoutMs }) };
    } catch (err) {
      errors.push(`fetch ${page.url}: ${err instanceof Error ? err.message : String(err)}`);
      findings.push(
        makeFinding({
          site: page.site,
          url: page.url,
          lane: 'http',
          tool: 'fetch',
          rule: 'unreachable',
          severity: 'critical',
          title: 'Page could not be fetched',
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }
  });

  const live = fetched.filter(
    (entry): entry is { target: PageTarget; page: FetchedPage } => entry !== null,
  );
  if (live.length === 0) {
    return { findings, errors, durationMs: Date.now() - started };
  }

  // --- per-page, in-process checks ------------------------------------------
  if (opts.tools.semantics) {
    for (const { target: pageTarget, page } of live) {
      findings.push(...checkSemantics(pageTarget, page));
    }
  }

  if (opts.tools.htmlValidate) {
    const perPage = await mapPool(live, opts.concurrency, async ({ target: t, page }) => {
      try {
        return await checkHtmlValidate(t, page);
      } catch (err) {
        errors.push(`html-validate ${t.url}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    });
    findings.push(...perPage.flat());
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

  return { findings, errors, durationMs: Date.now() - started };
}
