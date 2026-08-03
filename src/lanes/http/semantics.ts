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
import type { Finding, FindingInstance, PageTarget } from '../../core/types.js';

/** Offending elements named per rule. See layout.ts for the same reasoning. */
const MAX_INSTANCES_PER_RULE = 40;

/**
 * The shape of a parsed DOM node that this file needs.
 *
 * cheerio 1.x keeps its node types in `domhandler` and does not re-export them,
 * so naming `Element` here would mean depending on a transitive package for a
 * type alone. Describing the three fields actually used is structurally
 * compatible with what cheerio hands back and couples to nothing.
 */
interface ElementLike {
  type: string;
  tagName?: string;
  attribs?: Record<string, string>;
  parent: ElementLike | null;
}

/**
 * A short CSS-ish path for one element.
 *
 * cheerio has no selector generator, so this walks up a few levels building
 * tag#id.class. It does not have to be a guaranteed-unique selector -- it has
 * to let a developer find the element in their template, which "1 control has
 * no label" does not.
 */
function pathOf(element: ElementLike): string {
  const parts: string[] = [];
  let node: ElementLike | null = element;
  let depth = 0;

  while (node && node.type === 'tag' && node.tagName && depth < 4) {
    let part = node.tagName.toLowerCase();
    const id = node.attribs?.['id'];
    if (id) {
      parts.unshift(`${part}#${id}`);
      break;
    }
    const cls = (node.attribs?.['class'] ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    if (cls) part += `.${cls}`;
    parts.unshift(part);
    node = node.parent;
    depth += 1;
  }

  return parts.join(' > ');
}

/** Rules that fire once per document. */
export function checkSemantics(target: PageTarget, page: FetchedPage): Finding[] {
  const findings: Finding[] = [];
  const add = (
    rule: string,
    severity: Parameters<typeof makeFinding>[0]['severity'],
    title: string,
    detail?: string,
    instances?: FindingInstance[],
    count?: number,
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
        ...(instances !== undefined ? { instances } : {}),
        ...(count !== undefined ? { count } : {}),
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

  /**
   * Every element in a selection, pinpointed.
   *
   * This is the difference between "181 sites have an unlabelled form control"
   * and a list a developer can walk. `attr` optionally lifts a URL (an image
   * src, a link href) into the instance so the reader does not have to parse the
   * snippet to find out which asset is at fault.
   */
  const instancesOf = (
    selection: ReturnType<typeof $>,
    attr?: 'src' | 'href',
  ): FindingInstance[] =>
    selection
      .slice(0, MAX_INSTANCES_PER_RULE)
      .map((_, element): FindingInstance => {
        const value = attr ? $(element).attr(attr) : undefined;
        return {
          selector: pathOf(element),
          snippet: truncate($.html(element) ?? '', 160),
          ...(value ? { target: resolveLink(value, page.finalUrl) ?? value } : {}),
        };
      })
      .get();

  // --- document head ---------------------------------------------------------
  const lang = $('html').attr('lang')?.trim();
  if (!lang) {
    add(
      'html-lang',
      'serious',
      'Missing lang attribute on <html>',
      'Screen readers cannot determine the document language, so they may read content with the wrong pronunciation rules.',
      [{ selector: 'html', snippet: truncate($.html($('html').first()) ?? '', 120) }],
    );
  }

  const titles = $('head title');
  const titleText = titles.first().text().trim();
  if (titles.length === 0 || titleText === '') {
    add('title-missing', 'serious', 'Missing or empty <title>', undefined, [
      { selector: 'head > title', message: 'No non-empty <title> element in <head>' },
    ]);
  } else if (titles.length > 1) {
    add(
      'title-duplicate',
      'moderate',
      `${titles.length} <title> elements in <head>`,
      undefined,
      instancesOf(titles),
      titles.length,
    );
  } else if (titleText.length > 65) {
    add(
      'title-length',
      'minor',
      `<title> is ${titleText.length} characters; search results truncate near 60`,
      undefined,
      [{ selector: 'head > title', snippet: truncate(titleText, 160), measured: `${titleText.length} characters`, expected: 'about 60 characters' }],
    );
  }

  const description = $('head meta[name="description"]').attr('content')?.trim();
  if (!description) {
    add('meta-description', 'minor', 'Missing meta description', undefined, [
      { selector: 'head > meta[name=description]', message: 'Element absent from <head>' },
    ]);
  }

  if ($('head meta[name="viewport"]').length === 0) {
    add(
      'viewport-missing',
      'serious',
      'Missing viewport meta tag',
      'Without it mobile browsers render at desktop width and zoom out, making text unreadable.',
      [{ selector: 'head > meta[name=viewport]', message: 'Element absent from <head>' }],
    );
  }

  if ($('head link[rel="canonical"]').length === 0) {
    add('canonical-missing', 'minor', 'Missing rel=canonical link', undefined, [
      { selector: 'head > link[rel=canonical]', message: 'Element absent from <head>' },
    ]);
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
      undefined,
      instancesOf(h1s),
      h1s.length,
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
        undefined,
        [{ selector: `h${level}`, message: `Follows an h${previous}, skipping ${level - previous - 1} level(s)`, measured: `h${previous} then h${level}`, expected: `h${previous} then h${previous + 1}` }],
      );
      break; // one report per page is enough
    }
    previous = level;
  }

  // --- images ----------------------------------------------------------------
  const imgs = $('img');
  const missingAlt = imgs.filter((_, el) => $(el).attr('alt') === undefined);
  if (missingAlt.length > 0) {
    add(
      'img-alt',
      'serious',
      `${missingAlt.length} of ${imgs.length} <img> elements have no alt attribute`,
      undefined,
      instancesOf(missingAlt, 'src'),
      missingAlt.length,
    );
  }

  const lazyable = imgs.filter((_, el) => $(el).attr('loading') === undefined);
  if (imgs.length >= 5 && lazyable.length === imgs.length) {
    add(
      'img-loading',
      'info',
      `None of the ${imgs.length} images use loading="lazy"`,
      undefined,
      instancesOf(lazyable, 'src'),
      lazyable.length,
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
      undefined,
      instancesOf(empty, 'href'),
      empty.length,
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
      undefined,
      instancesOf(unsafeBlank, 'href'),
      unsafeBlank.length,
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
      instancesOf(unlabelled),
      unlabelled.length,
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
