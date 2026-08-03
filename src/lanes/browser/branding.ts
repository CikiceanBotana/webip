/**
 * Brand presentation: the logo, and the icons a browser needs.
 *
 * A caveat this module is honest about: "the logo looks bad" is not something
 * a scanner can decide. Taste is not measurable, and a rule that pretended
 * otherwise would produce exactly the kind of false positive that makes a
 * reader stop trusting the report.
 *
 * What IS measurable is the objective ground underneath that impression:
 *   - is there a logo at all, or just text?
 *   - does the logo asset actually load?
 *   - is it a bare wordmark -- the business name set as type, no distinct mark?
 *   - does the site declare a favicon, or is the browser tab left blank?
 *   - is the logo's accessible name sound, or is its alt text dead?
 *
 * Those are facts. The design judgement stays with the human, but the facts
 * are what a judgement should rest on.
 */

import type { Page } from 'playwright';

import { makeFinding } from '../../core/finding.js';
import type { Finding, PageTarget } from '../../core/types.js';

import { ensureNameShim } from './shim.js';

/**
 * Above this width-to-height ratio, a logo is almost certainly the business
 * name set as type rather than a mark with a symbol in it. A square-ish logo
 * has an icon; a 9:1 strip is a word.
 */
const WORDMARK_RATIO = 4;

interface BrandFacts {
  hasHeader: boolean;
  brandFound: boolean;
  brandSelector: string;
  brandSnippet: string;
  brandText: string;
  /** Accessible name that assistive tech will actually announce. */
  accessibleName: string;
  linkAriaLabel: string | null;
  logo: {
    kind: 'img' | 'svg' | 'background' | 'none';
    src: string;
    loaded: boolean;
    intrinsicWidth: number;
    intrinsicHeight: number;
    renderedWidth: number;
    renderedHeight: number;
    alt: string | null;
    isVector: boolean;
  };
  icons: Array<{ rel: string; href: string; sizes: string }>;
}

/** In-page: gather everything about the brand mark and the icon declarations. */
function collectBrandFacts(): BrandFacts {
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const cls = (node.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join('.');
      if (cls) part += `.${cls}`;
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const header = document.querySelector('header') ?? document.querySelector('[role="banner"]');
  // The brand is conventionally the header's link to the site root.
  const brand =
    (header?.querySelector('a[href="/"], a[href=""], a[href="./"]') as HTMLElement | null) ??
    (header?.querySelector('a') as HTMLElement | null) ??
    (document.querySelector('[class*="logo" i] a, a[class*="logo" i]') as HTMLElement | null);

  const icons = Array.from(
    document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]'),
  ).map((l) => ({
    rel: l.getAttribute('rel') ?? '',
    href: (l.getAttribute('href') ?? '').slice(0, 120),
    sizes: l.getAttribute('sizes') ?? '',
  }));

  const empty: BrandFacts['logo'] = {
    kind: 'none',
    src: '',
    loaded: false,
    intrinsicWidth: 0,
    intrinsicHeight: 0,
    renderedWidth: 0,
    renderedHeight: 0,
    alt: null,
    isVector: false,
  };

  if (!brand) {
    return {
      hasHeader: header !== null,
      brandFound: false,
      brandSelector: '',
      brandSnippet: '',
      brandText: '',
      accessibleName: '',
      linkAriaLabel: null,
      logo: empty,
      icons,
    };
  }

  const img = brand.querySelector('img');
  const svg = brand.querySelector('svg');
  const bg = window.getComputedStyle(brand).backgroundImage;

  let logo = empty;
  if (img) {
    const r = img.getBoundingClientRect();
    const src = img.currentSrc || img.src;
    logo = {
      kind: 'img',
      src: src.slice(0, 140),
      loaded: img.complete && img.naturalWidth > 0,
      intrinsicWidth: img.naturalWidth,
      intrinsicHeight: img.naturalHeight,
      renderedWidth: Math.round(r.width),
      renderedHeight: Math.round(r.height),
      alt: img.getAttribute('alt'),
      isVector: /\.svg(\?|$)/i.test(src) || src.startsWith('data:image/svg'),
    };
  } else if (svg) {
    const r = svg.getBoundingClientRect();
    logo = {
      ...empty,
      kind: 'svg',
      loaded: true,
      renderedWidth: Math.round(r.width),
      renderedHeight: Math.round(r.height),
      intrinsicWidth: Math.round(r.width),
      intrinsicHeight: Math.round(r.height),
      isVector: true,
    };
  } else if (bg && bg !== 'none') {
    const r = brand.getBoundingClientRect();
    logo = {
      ...empty,
      kind: 'background',
      src: bg.slice(0, 140),
      loaded: true,
      renderedWidth: Math.round(r.width),
      renderedHeight: Math.round(r.height),
      isVector: /\.svg/i.test(bg),
    };
  }

  const linkAriaLabel = brand.getAttribute('aria-label');
  const accessibleName = (linkAriaLabel ?? logo.alt ?? brand.textContent ?? '').trim();

  return {
    hasHeader: header !== null,
    brandFound: true,
    brandSelector: cssPath(brand),
    brandSnippet: brand.outerHTML.slice(0, 180),
    brandText: (brand.textContent ?? '').trim().slice(0, 60),
    accessibleName: accessibleName.slice(0, 120),
    linkAriaLabel,
    logo,
    icons,
  };
}

/**
 * Runs the brand checks. Only the homepage needs them -- the header is the same
 * on every page, so repeating it would report one defect N times.
 */
export async function checkBranding(
  target: PageTarget,
  page: Page,
  evidence?: string,
): Promise<Finding[]> {
  await ensureNameShim(page);
  const facts = await page.evaluate(collectBrandFacts);
  const findings: Finding[] = [];

  const add = (
    rule: string,
    severity: Parameters<typeof makeFinding>[0]['severity'],
    title: string,
    instances: Parameters<typeof makeFinding>[0]['instances'],
    over: Partial<Parameters<typeof makeFinding>[0]> = {},
  ): void => {
    findings.push(
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'browser',
        tool: 'branding',
        rule,
        severity,
        title,
        instances,
        ...(evidence ? { evidence } : {}),
        ...over,
      }),
    );
  };

  // --- the logo itself ------------------------------------------------------
  if (facts.brandFound && facts.logo.kind === 'none') {
    add(
      'logo-missing',
      'moderate',
      'The site has no logo: the header brand is plain text',
      [
        {
          selector: facts.brandSelector,
          snippet: facts.brandSnippet,
          message: `Header brand renders as the text "${facts.brandText}" with no image, SVG or background image`,
          measured: 'text only',
          expected: 'an image or SVG mark',
        },
      ],
    );
  }

  if (facts.logo.kind === 'img' && !facts.logo.loaded) {
    add(
      'logo-broken',
      'serious',
      'The logo image fails to load',
      [
        {
          selector: facts.brandSelector,
          target: facts.logo.src,
          message: 'The header logo is an <img> that did not load, so the brand is missing entirely',
          measured: 'failed to load',
          expected: 'a loading image',
        },
      ],
    );
  }

  // A wide, short mark is the business name set as type. Legitimate, and every
  // WCAG rule permits it -- logotypes are explicitly exempt from SC 1.4.5 --
  // but it is worth stating plainly, because a generated wordmark is usually a
  // placeholder nobody ever replaced.
  if (facts.logo.loaded && facts.logo.intrinsicHeight > 0) {
    const ratio = facts.logo.intrinsicWidth / facts.logo.intrinsicHeight;
    if (ratio >= WORDMARK_RATIO) {
      add(
        'logo-wordmark-only',
        'info',
        `The logo is a text wordmark, not a designed mark (${ratio.toFixed(1)}:1 aspect ratio)`,
        [
          {
            selector: facts.brandSelector,
            target: facts.logo.src,
            message:
              'The brand mark is the business name set as type, with no symbol or icon. It carries no identity at small sizes, cannot be used as an avatar or app icon, and is usually a generated placeholder.',
            measured: `${facts.logo.intrinsicWidth}x${facts.logo.intrinsicHeight} (${ratio.toFixed(1)}:1)`,
            expected: 'a mark that also works square',
          },
        ],
        {
          category: 'seo',
          remedy:
            'Commission or generate a distinct mark that reads at 32x32 as well as it does in the header, and keep the wordmark for the full-width lockup. Whether the current one looks good is a design judgement this scan does not make -- what it reports is that there is no symbol, only type.',
        },
      );
    }
  }

  // --- the accessible name --------------------------------------------------
  // aria-label on the link OVERRIDES the alt text on the image inside it, so a
  // carefully written alt is simply never announced.
  if (facts.linkAriaLabel && facts.logo.alt && facts.linkAriaLabel !== facts.logo.alt) {
    add(
      'logo-name-overridden',
      'minor',
      'The logo image has alt text that is never announced',
      [
        {
          selector: facts.brandSelector,
          snippet: facts.brandSnippet,
          message: `The link's aria-label "${facts.linkAriaLabel}" overrides the image alt "${facts.logo.alt}", so the alt text is dead weight and the two can drift apart.`,
          measured: `announced: "${facts.linkAriaLabel}"`,
          expected: 'one accessible name, in one place',
        },
      ],
      {
        category: 'accessibility',
        remedy:
          'Keep the aria-label on the link and set alt="" on the image, or drop the aria-label and let the alt describe it. Do not maintain both.',
      },
    );
  }

  // --- browser icons --------------------------------------------------------
  const hasIcon = facts.icons.some((i) => i.rel.includes('icon') && i.rel !== 'apple-touch-icon');
  const hasApple = facts.icons.some((i) => i.rel === 'apple-touch-icon');

  if (!hasIcon) {
    add(
      'favicon-missing',
      'moderate',
      'No favicon is declared',
      [
        {
          selector: 'head',
          message:
            'The document declares no <link rel="icon">. Browsers fall back to /favicon.ico if the server happens to serve one, but nothing is guaranteed, no resolution is specified, and bookmarks, tab strips, history and search results have no icon to show.',
          measured: 'no icon declared',
          expected: '<link rel="icon" href="..."> in <head>',
        },
      ],
      {
        category: 'seo',
        remedy:
          'Add <link rel="icon" href="/favicon.svg" type="image/svg+xml"> plus a 32x32 PNG fallback to <head>.',
      },
    );
  }

  if (!hasApple) {
    add(
      'apple-touch-icon-missing',
      'minor',
      'No apple-touch-icon is declared',
      [
        {
          selector: 'head',
          message:
            'Saved to an iOS home screen, the site gets a blurry screenshot of the page instead of an icon.',
          measured: 'absent',
          expected: '<link rel="apple-touch-icon" href="..." sizes="180x180">',
        },
      ],
      { category: 'seo' },
    );
  }

  return findings;
}
