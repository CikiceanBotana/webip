/**
 * Screenshot evidence.
 *
 * Screenshots exist ONLY to show a human what a finding looks like. They are
 * never compared against a baseline, never diffed, and never used to decide
 * whether something is a defect. That decision always comes from a rule engine
 * or a geometry measurement.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from 'playwright';

/** Filesystem-safe slug for a URL path, e.g. "/products/lick-pad" -> "products-lick-pad". */
export function slugForUrl(url: string): string {
  try {
    const { pathname } = new URL(url);
    const slug = pathname.replace(/^\/+|\/+$/g, '').replace(/[^\w.-]+/g, '-');
    return slug === '' ? 'index' : slug.slice(0, 80);
  } catch {
    return 'page';
  }
}

/** Short, filesystem-safe site directory name. */
export function slugForSite(site: string): string {
  try {
    return new URL(site).hostname.replace(/[^\w.-]+/g, '-');
  } catch {
    return site.replace(/[^\w.-]+/g, '-').slice(0, 60);
  }
}

/**
 * Captures a full-page screenshot and returns its path relative to the repo
 * root, ready to embed in a report. Returns null on failure -- evidence is
 * nice to have and must never fail a scan.
 */
export async function captureEvidence(
  page: Page,
  opts: { site: string; url: string; outDir: string; rootDir: string },
): Promise<string | null> {
  try {
    const dir = path.join(opts.outDir, 'evidence', slugForSite(opts.site));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${slugForUrl(opts.url)}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return path.relative(opts.rootDir, file);
  } catch {
    return null;
  }
}
