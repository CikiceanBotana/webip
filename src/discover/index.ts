/**
 * URL discovery.
 *
 * Turns a seed URL into a concrete work list. Handles two shapes with the same
 * code path:
 *
 *   HUB   -- the seed's sitemap is a <sitemapindex>, so each child sitemap is a
 *            separate site. sogood.business is this: 357 tenant sites, several
 *            on their own apex domains.
 *   SITE  -- the seed's sitemap is a <urlset>, so the seed is one site and the
 *            entries are its pages.
 *
 * Sitemaps are preferred over crawling because they are authoritative, cheap,
 * and do not hammer the target. Link-scraping the homepage is the fallback for
 * sites that publish no sitemap.
 */

import * as cheerio from 'cheerio';

import { mapPoolSettled } from '../core/pool.js';
import { fetchPage, labelOf, originOf, resolveLink } from '../core/net.js';
import type { PageTarget, SiteTarget } from '../core/types.js';

interface Sitemap {
  kind: 'index' | 'urlset' | 'empty';
  locs: string[];
}

/** Parses a sitemap or sitemap index. Never throws; unparseable becomes empty. */
export function parseSitemap(xml: string): Sitemap {
  try {
    const $ = cheerio.load(xml, { xml: true });

    const indexLocs = $('sitemapindex > sitemap > loc')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (indexLocs.length > 0) return { kind: 'index', locs: indexLocs };

    const urlLocs = $('urlset > url > loc')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (urlLocs.length > 0) return { kind: 'urlset', locs: urlLocs };

    return { kind: 'empty', locs: [] };
  } catch {
    return { kind: 'empty', locs: [] };
  }
}

async function loadSitemap(url: string, timeoutMs: number): Promise<Sitemap> {
  try {
    const res = await fetchPage(url, { timeoutMs, accept: 'application/xml,text/xml,*/*' });
    if (!res.ok) return { kind: 'empty', locs: [] };
    return parseSitemap(res.body);
  } catch {
    return { kind: 'empty', locs: [] };
  }
}

/** Reads Sitemap: directives out of robots.txt. */
async function sitemapsFromRobots(origin: string, timeoutMs: number): Promise<string[]> {
  try {
    const res = await fetchPage(`${origin}/robots.txt`, { timeoutMs, accept: 'text/plain,*/*' });
    if (!res.ok) return [];
    return res.body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^sitemap:/i.test(line))
      .map((line) => line.slice(line.indexOf(':') + 1).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Candidate sitemap URLs for an origin, robots.txt first then the convention. */
async function sitemapCandidates(origin: string, timeoutMs: number): Promise<string[]> {
  const fromRobots = await sitemapsFromRobots(origin, timeoutMs);
  return [...new Set([...fromRobots, `${origin}/sitemap.xml`])];
}

/**
 * Expands one seed into the list of distinct sites underneath it.
 * A hub yields many; an ordinary site yields itself.
 */
export async function discoverSites(
  seed: string,
  opts: { timeoutMs: number; concurrency: number },
): Promise<{ sites: string[]; isHub: boolean }> {
  const origin = originOf(seed);
  const candidates = await sitemapCandidates(origin, opts.timeoutMs);

  for (const candidate of candidates) {
    const sitemap = await loadSitemap(candidate, opts.timeoutMs);

    if (sitemap.kind === 'index') {
      // Each child sitemap belongs to its own origin -> that origin is a site.
      const sites = [...new Set(sitemap.locs.map(originOf))].filter(Boolean);
      return { sites, isHub: true };
    }
    if (sitemap.kind === 'urlset') {
      return { sites: [origin], isHub: false };
    }
  }

  // No usable sitemap: fall back to scraping same-page links off the homepage.
  const linked = await linksFromPage(origin, opts.timeoutMs);
  const externalOrigins = [...new Set(linked.map(originOf))].filter((o) => o !== origin);
  if (externalOrigins.length >= 10) return { sites: externalOrigins, isHub: true };
  return { sites: [origin], isHub: false };
}

/** All resolvable links on a page. */
async function linksFromPage(url: string, timeoutMs: number): Promise<string[]> {
  try {
    const res = await fetchPage(url, { timeoutMs });
    if (!res.ok) return [];
    const $ = cheerio.load(res.body);
    const links = $('a[href]')
      .map((_, el) => resolveLink($(el).attr('href') ?? '', res.finalUrl))
      .get()
      .filter((href): href is string => href !== null);
    return [...new Set(links)];
  } catch {
    return [];
  }
}

/**
 * Picks the pages to inspect for one site.
 *
 * Ordering matters: the homepage always comes first, then sitemap order, which
 * for these tenants is roughly importance order (/, /products, /about, ...).
 * Truncation therefore keeps the pages that matter.
 */
export async function pagesForSite(
  site: string,
  opts: { maxPages: number; timeoutMs: number },
): Promise<PageTarget[]> {
  const seen = new Set<string>();
  const urls: string[] = [];

  const push = (raw: string): void => {
    const normalised = raw.replace(/\/+$/, '') || raw;
    if (originOf(normalised) !== site) return; // stay on-site
    if (seen.has(normalised)) return;
    seen.add(normalised);
    urls.push(raw);
  };

  push(`${site}/`);

  for (const candidate of await sitemapCandidates(site, opts.timeoutMs)) {
    const sitemap = await loadSitemap(candidate, opts.timeoutMs);
    if (sitemap.kind === 'urlset') {
      sitemap.locs.forEach(push);
      break;
    }
    if (sitemap.kind === 'index') {
      // A nested index: pull the first child urlset.
      const first = sitemap.locs[0];
      if (first) {
        const child = await loadSitemap(first, opts.timeoutMs);
        child.locs.forEach(push);
      }
      break;
    }
  }

  if (urls.length <= 1) {
    (await linksFromPage(`${site}/`, opts.timeoutMs)).forEach(push);
  }

  return urls.slice(0, opts.maxPages).map((url) => ({ url, site }));
}

/** Builds the full work list: sites, each with its selected pages. */
export async function buildTargets(
  seeds: readonly string[],
  opts: {
    maxSites: number;
    maxPagesPerSite: number;
    timeoutMs: number;
    concurrency: number;
    onProgress?: (message: string) => void;
  },
): Promise<SiteTarget[]> {
  const allSites: string[] = [];

  for (const seed of seeds) {
    const { sites, isHub } = await discoverSites(seed, {
      timeoutMs: opts.timeoutMs,
      concurrency: opts.concurrency,
    });
    opts.onProgress?.(
      `${seed} -> ${sites.length} site(s)${isHub ? ' (hub: sitemap index)' : ''}`,
    );
    allSites.push(...sites);
  }

  const unique = [...new Set(allSites)].slice(0, opts.maxSites);

  const targets = await mapPoolSettled(unique, opts.concurrency, async (site) => {
    const pages = await pagesForSite(site, {
      maxPages: opts.maxPagesPerSite,
      timeoutMs: opts.timeoutMs,
    });
    return { site, label: labelOf(site), pages } satisfies SiteTarget;
  });

  return targets.filter((t): t is SiteTarget => t !== null && t.pages.length > 0);
}
