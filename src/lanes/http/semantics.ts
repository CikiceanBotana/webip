/**
 * Static semantic checks, browser-free.
 *
 * These are the things you can decide from the served HTML alone: does the
 * document declare a language, is there exactly one h1, do images carry alt
 * text, is the heading outline sane, is there a canonical. No layout, no
 * JavaScript, no browser -- anything needing geometry belongs to the browser
 * lane.
 *
 * Cheap enough to run on every page of all 357 sites.
 */

import * as cheerio from 'cheerio';

import { makeFinding, truncate } from '../../core/finding.js';
import { resolveLink } from '../../core/net.js';
import type { FetchedPage } from '../../core/net.js';
import type { Finding, PageTarget } from '../../core/types.js';

/** Rules that fire once per document. */
export function checkSemantics(target: PageTarget, page: FetchedPage): Finding[] {
  const findings: Finding[] = [];
  const add = (
    rule: string,
    severity: Parameters<typeof makeFinding>[0]['severity'],
    title: string,
    detail?: string,
    location?: { selector?: string; snippet?: string },
  ): void => {
    findings.push(
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'http',
        tool: 'semantics',
        rule,
        severity,
        title,
        ...(detail !== undefined ? { detail } : {}),
        ...(location !== undefined ? { location } : {}),
      }),
    );
  };

  // --- transport-level facts -------------------------------------------------
  if (!page.ok) {
    add(
      'http-status',
      page.status >= 500 ? 'critical' : 'serious',
      `Page returned HTTP ${page.status}`,
      `${target.url} responded ${page.status}.`,
    );
    // A non-OK page has no meaningful markup to inspect further.
    if (page.body.trim() === '') return findings;
  }

  const contentType = page.headers['content-type'] ?? '';
  if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
    add(
      'content-type',
      'moderate',
      `Unexpected Content-Type for an HTML page: ${contentType}`,
      'The URL is listed as a page but is not served as HTML.',
    );
  }

  if (page.finalUrl !== target.url && page.finalUrl.replace(/\/$/, '') !== target.url.replace(/\/$/, '')) {
    add(
      'redirect',
      'info',
      'URL redirects',
      `${target.url} -> ${page.finalUrl}`,
    );
  }

  const $ = cheerio.load(page.body);

  // --- document head ---------------------------------------------------------
  const lang = $('html').attr('lang')?.trim();
  if (!lang) {
    add(
      'html-lang',
      'serious',
      'Missing lang attribute on <html>',
      'Screen readers cannot determine the document language, so they may read content with the wrong pronunciation rules.',
      { selector: 'html' },
    );
  }

  const titles = $('head title');
  const titleText = titles.first().text().trim();
  if (titles.length === 0 || titleText === '') {
    add('title-missing', 'serious', 'Missing or empty <title>', undefined, { selector: 'head > title' });
  } else if (titles.length > 1) {
    add('title-duplicate', 'moderate', `${titles.length} <title> elements in <head>`, undefined, {
      selector: 'head > title',
    });
  } else if (titleText.length > 65) {
    add(
      'title-length',
      'minor',
      `<title> is ${titleText.length} characters; search results truncate near 60`,
      truncate(titleText),
    );
  }

  const description = $('head meta[name="description"]').attr('content')?.trim();
  if (!description) {
    add('meta-description', 'minor', 'Missing meta description', undefined, {
      selector: 'head > meta[name=description]',
    });
  }

  if ($('head meta[name="viewport"]').length === 0) {
    add(
      'viewport-missing',
      'serious',
      'Missing viewport meta tag',
      'Without it mobile browsers render at desktop width and zoom out, making text unreadable.',
      { selector: 'head > meta[name=viewport]' },
    );
  }

  if ($('head link[rel="canonical"]').length === 0) {
    add('canonical-missing', 'minor', 'Missing rel=canonical link', undefined, {
      selector: 'head > link[rel=canonical]',
    });
  }

  if ($('head meta[charset], head meta[http-equiv="Content-Type"]').length === 0) {
    add('charset-missing', 'moderate', 'No character encoding declared in <head>');
  }

  // --- headings --------------------------------------------------------------
  const h1s = $('h1');
  if (h1s.length === 0) {
    add('h1-missing', 'moderate', 'Page has no <h1>', 'Every page should have exactly one top-level heading.');
  } else if (h1s.length > 1) {
    add(
      'h1-multiple',
      'minor',
      `Page has ${h1s.length} <h1> elements`,
      'Multiple top-level headings make the document outline ambiguous.',
    );
  }

  // Heading levels must not jump downward by more than one (h2 -> h4).
  const levels = $('h1, h2, h3, h4, h5, h6')
    .map((_, el) => Number((el as { tagName?: string }).tagName?.slice(1) ?? 0))
    .get()
    .filter((n) => n > 0);
  let previous = 0;
  for (const level of levels) {
    if (previous !== 0 && level > previous + 1) {
      add(
        'heading-skip',
        'minor',
        `Heading level jumps from h${previous} to h${level}`,
        'Skipped levels break the outline for assistive technology.',
      );
      break; // one report per page is enough
    }
    previous = level;
  }

  // --- images ----------------------------------------------------------------
  const imgs = $('img');
  const missingAlt = imgs.filter((_, el) => $(el).attr('alt') === undefined);
  if (missingAlt.length > 0) {
    const first = missingAlt.first();
    add(
      'img-alt',
      'serious',
      `${missingAlt.length} of ${imgs.length} <img> elements have no alt attribute`,
      'Decorative images need alt="" ; meaningful images need a description.',
      { selector: 'img', snippet: truncate($.html(first) ?? '') },
    );
  }

  const lazyable = imgs.filter((_, el) => $(el).attr('loading') === undefined);
  if (imgs.length >= 5 && lazyable.length === imgs.length) {
    add(
      'img-loading',
      'info',
      `None of the ${imgs.length} images use loading="lazy"`,
      'Off-screen images are downloaded eagerly, costing bandwidth on first paint.',
    );
  }

  // --- links -----------------------------------------------------------------
  const anchors = $('a[href]');
  const empty = anchors.filter((_, el) => {
    const $el = $(el);
    const hasText = $el.text().trim().length > 0;
    const hasLabel = ($el.attr('aria-label') ?? '').trim().length > 0;
    const hasTitle = ($el.attr('title') ?? '').trim().length > 0;
    const hasImgAlt = $el.find('img[alt]').filter((__, img) => ($(img).attr('alt') ?? '').trim() !== '').length > 0;
    return !hasText && !hasLabel && !hasTitle && !hasImgAlt;
  });
  if (empty.length > 0) {
    add(
      'link-name',
      'serious',
      `${empty.length} link(s) have no accessible name`,
      'A link with no text, aria-label or titled image is announced as just "link".',
      { selector: 'a[href]', snippet: truncate($.html(empty.first()) ?? '') },
    );
  }

  // target=_blank without rel=noopener lets the opened page reach window.opener.
  const unsafeBlank = anchors.filter((_, el) => {
    const $el = $(el);
    if ($el.attr('target') !== '_blank') return false;
    const rel = ($el.attr('rel') ?? '').toLowerCase();
    return !rel.includes('noopener') && !rel.includes('noreferrer');
  });
  if (unsafeBlank.length > 0) {
    add(
      'target-blank-noopener',
      'moderate',
      `${unsafeBlank.length} link(s) use target="_blank" without rel="noopener"`,
      'The opened document can navigate the opener via window.opener.',
      { selector: 'a[target=_blank]', snippet: truncate($.html(unsafeBlank.first()) ?? '') },
    );
  }

  // --- forms -----------------------------------------------------------------
  const unlabelled = $('input, select, textarea').filter((_, el) => {
    const $el = $(el);
    const type = ($el.attr('type') ?? '').toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return false;
    if (($el.attr('aria-label') ?? '').trim() !== '') return false;
    if (($el.attr('aria-labelledby') ?? '').trim() !== '') return false;
    if (($el.attr('title') ?? '').trim() !== '') return false;
    const id = $el.attr('id');
    if (id && $(`label[for="${id.replace(/"/g, '\\"')}"]`).length > 0) return false;
    return $el.parents('label').length === 0;
  });
  if (unlabelled.length > 0) {
    add(
      'form-label',
      'serious',
      `${unlabelled.length} form control(s) have no associated label`,
      undefined,
      { selector: 'input, select, textarea', snippet: truncate($.html(unlabelled.first()) ?? '') },
    );
  }

  return findings;
}

/** Every on-page link, resolved absolute. Feeds the link checker. */
export function extractLinks(page: FetchedPage): string[] {
  const $ = cheerio.load(page.body);
  const hrefs = $('a[href]')
    .map((_, el) => resolveLink($(el).attr('href') ?? '', page.finalUrl))
    .get()
    .filter((href): href is string => href !== null);
  return [...new Set(hrefs)];
}
