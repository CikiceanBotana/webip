/**
 * The explanation layer: rule id -> what is wrong, what to change, what it breaks.
 *
 * A raw tool emits "aria-prohibited-attr" or "attr-case". Neither tells a
 * developer what to do. This module is the single place that turns any rule
 * from any tool into three things a reader can act on:
 *
 *   category     tool-independent classification
 *   whatIsWrong  the defect, in plain English
 *   howToFix     the change, in the imperative
 *
 * EVERY rule resolves. Rules we own are described exhaustively below; rules
 * owned by axe, equal-access, Lighthouse and the validators fall back to a
 * per-tool default, and axe additionally decodes its own WCAG tags so all 105
 * of its rules map onto a success criterion without a hand-written table.
 *
 * This is deliberately data, not logic. Adding a rule is adding an entry.
 */

import type { Audience, Category, ToolName } from './types.js';

export interface RuleInfo {
  category: Category;
  /** Who feels this. Resolved for every rule; see audienceFor. */
  audience?: Audience;
  /** Plain-English defect. Falls back to the tool's own message when absent. */
  whatIsWrong?: string;
  /** The change to make. */
  howToFix?: string;
  standards?: string[];
}

/** WCAG success criteria referenced by the rules we emit or decode. */
const WCAG_NAMES: Record<string, string> = {
  '1.1.1': 'Non-text Content',
  '1.2.2': 'Captions (Prerecorded)',
  '1.3.1': 'Info and Relationships',
  '1.3.2': 'Meaningful Sequence',
  '1.3.4': 'Orientation',
  '1.3.5': 'Identify Input Purpose',
  '1.4.1': 'Use of Color',
  '1.4.2': 'Audio Control',
  '1.4.3': 'Contrast (Minimum)',
  '1.4.4': 'Resize Text',
  '1.4.10': 'Reflow',
  '1.4.11': 'Non-text Contrast',
  '1.4.12': 'Text Spacing',
  '2.1.1': 'Keyboard',
  '2.1.2': 'No Keyboard Trap',
  '2.2.1': 'Timing Adjustable',
  '2.2.2': 'Pause, Stop, Hide',
  '2.4.1': 'Bypass Blocks',
  '2.4.2': 'Page Titled',
  '2.4.3': 'Focus Order',
  '2.4.4': 'Link Purpose (In Context)',
  '2.4.6': 'Headings and Labels',
  '2.4.7': 'Focus Visible',
  '2.5.3': 'Label in Name',
  '2.5.8': 'Target Size (Minimum)',
  '3.1.1': 'Language of Page',
  '3.1.2': 'Language of Parts',
  '3.2.2': 'On Input',
  '3.3.1': 'Error Identification',
  '3.3.2': 'Labels or Instructions',
  '4.1.1': 'Parsing',
  '4.1.2': 'Name, Role, Value',
  '4.1.3': 'Status Messages',
};

function wcag(...criteria: string[]): string[] {
  return criteria.map((sc) => {
    const name = WCAG_NAMES[sc];
    return name ? `WCAG SC ${sc} ${name}` : `WCAG SC ${sc}`;
  });
}

// ---------------------------------------------------------------------------
// Rules this project owns. No upstream documentation exists for these, so the
// explanation has to live here or it lives nowhere.
// ---------------------------------------------------------------------------

const OWN_RULES: Record<string, RuleInfo> = {
  // --- semantics: transport + document head --------------------------------
  'semantics/http-status': {
    category: 'transport',
    whatIsWrong:
      'The page is listed as a real URL but the server does not return it successfully. Anyone following a link, and every search engine, receives an error instead of content.',
    howToFix:
      'Either restore the page at this URL, or remove the URL from the sitemap and redirect it to the page that replaced it.',
  },
  'semantics/content-type': {
    category: 'transport',
    whatIsWrong:
      'The URL is advertised as a page but is not served as HTML, so browsers may download it instead of rendering it.',
    howToFix: 'Serve this URL with "Content-Type: text/html; charset=utf-8".',
  },
  'semantics/redirect': {
    category: 'transport',
    whatIsWrong:
      'The sitemap lists a URL that redirects rather than the destination itself, costing every visitor an extra round trip.',
    howToFix: 'List the final destination URL in the sitemap.',
  },
  'semantics/html-lang': {
    category: 'accessibility',
    whatIsWrong:
      'The document declares no language, so a screen reader falls back to the user\'s own locale and reads the page with the wrong pronunciation rules and voice.',
    howToFix: 'Add a language to the root element, e.g. <html lang="en">.',
    standards: wcag('3.1.1'),
  },
  'semantics/title-missing': {
    category: 'seo',
    whatIsWrong:
      'The page has no title, so browser tabs, bookmarks, search results and screen-reader page announcements have nothing to show.',
    howToFix: 'Add a unique, descriptive <title> to <head>.',
    standards: wcag('2.4.2'),
  },
  'semantics/title-duplicate': {
    category: 'markup',
    whatIsWrong:
      'More than one <title> in <head>. Only the first is used; the rest are dead markup and a sign the template renders the tag twice.',
    howToFix: 'Render exactly one <title>.',
  },
  'semantics/title-length': {
    category: 'seo',
    whatIsWrong: 'The title is longer than search results display, so the end is cut off.',
    howToFix: 'Shorten the title to roughly 60 characters, front-loading the distinctive words.',
  },
  'semantics/meta-description': {
    category: 'seo',
    whatIsWrong:
      'No meta description, so search engines invent a snippet from arbitrary page text.',
    howToFix: 'Add <meta name="description" content="..."> summarising the page in 120-160 characters.',
  },
  'semantics/viewport-missing': {
    category: 'layout',
    whatIsWrong:
      'Without a viewport meta tag, mobile browsers assume a desktop-width layout and zoom out, rendering the text too small to read.',
    howToFix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>.',
  },
  'semantics/canonical-missing': {
    category: 'seo',
    whatIsWrong:
      'No canonical URL, so the same content reachable at several URLs competes with itself in search rankings.',
    howToFix: 'Add <link rel="canonical" href="..."> pointing at the preferred URL.',
  },
  'semantics/charset-missing': {
    category: 'markup',
    whatIsWrong:
      'No character encoding is declared, so the browser guesses and non-ASCII characters can render as mojibake.',
    howToFix: 'Add <meta charset="utf-8"> as the first element in <head>.',
  },
  'semantics/h1-missing': {
    category: 'accessibility',
    whatIsWrong:
      'The page has no top-level heading, so assistive technology cannot tell the user what this page is.',
    howToFix: 'Add exactly one <h1> naming the page.',
    standards: wcag('1.3.1', '2.4.6'),
  },
  'semantics/h1-multiple': {
    category: 'accessibility',
    whatIsWrong:
      'Several <h1> elements make the document outline ambiguous; screen-reader users navigating by heading cannot tell which is the page title.',
    howToFix: 'Keep one <h1> and demote the others to <h2>.',
    standards: wcag('1.3.1'),
  },
  'semantics/heading-skip': {
    category: 'accessibility',
    whatIsWrong:
      'Heading levels jump downward, which breaks the outline that screen-reader users navigate by and implies a missing section.',
    howToFix: 'Use heading levels in sequence; style them with CSS rather than picking a level for its size.',
    standards: wcag('1.3.1'),
  },
  'semantics/img-alt': {
    category: 'accessibility',
    whatIsWrong:
      'Images carry no alt attribute, so a screen reader announces the file name or nothing at all.',
    howToFix:
      'Give every meaningful image a description in alt, and every decorative image an empty alt="".',
    standards: wcag('1.1.1'),
  },
  'semantics/img-loading': {
    category: 'performance',
    whatIsWrong:
      'No image on the page defers loading, so images far below the fold are downloaded before the page is usable.',
    howToFix: 'Add loading="lazy" to images below the fold; leave the hero image eager.',
  },
  'semantics/link-name': {
    category: 'accessibility',
    whatIsWrong:
      'Links have no text, no aria-label and no described image, so a screen reader announces only "link" and the user cannot tell where it goes.',
    howToFix:
      'Put text inside the link, or add aria-label, or give the icon/image inside it a meaningful alt.',
    standards: wcag('2.4.4', '4.1.2'),
  },
  'semantics/target-blank-noopener': {
    category: 'security',
    whatIsWrong:
      'A link opens a new tab without rel="noopener", so the opened document can reach back through window.opener and navigate the original tab to a phishing page.',
    howToFix: 'Add rel="noopener noreferrer" to every target="_blank" link.',
  },
  'semantics/form-label': {
    category: 'accessibility',
    whatIsWrong:
      'Form controls have no associated label, so a screen reader announces the field type but not what to type in it. A placeholder is not a label: it disappears on focus.',
    howToFix:
      'Give each control a <label for="id">, or an aria-label, or wrap it in a <label>.',
    standards: wcag('1.3.1', '3.3.2', '4.1.2'),
  },

  // --- layout --------------------------------------------------------------
  'layout/horizontal-overflow': {
    category: 'layout',
    whatIsWrong:
      'The page is wider than the viewport, so it scrolls sideways. Content is cut off until the user pans, and on touch devices vertical scrolling becomes unreliable.',
    howToFix:
      'Find the element wider than its container (reported alongside this) and constrain it: max-width:100%, flex-wrap, or overflow-wrap on long unbroken strings.',
    standards: wcag('1.4.10'),
  },
  'layout/element-overflows-viewport': {
    category: 'layout',
    whatIsWrong:
      'This element extends past the right edge of the viewport and is the cause of the page scrolling sideways.',
    howToFix:
      'Constrain the element: max-width:100%, box-sizing:border-box, or wrap its content. Check for fixed pixel widths and unbreakable strings.',
    standards: wcag('1.4.10'),
  },
  'layout/tap-target-too-small': {
    category: 'accessibility',
    whatIsWrong:
      'Interactive elements are smaller than the 24x24 CSS pixel minimum, so they are hard to hit accurately on a touch screen and for anyone with a motor impairment.',
    howToFix:
      'Increase the control to at least 24x24 CSS pixels, with padding rather than font size, or leave 24px of clear space around it.',
    standards: wcag('2.5.8'),
  },
  'layout/interactive-overlap': {
    category: 'layout',
    whatIsWrong:
      'Two separately clickable elements sit on top of each other, so one of them is unreachable or the wrong one receives the tap.',
    howToFix:
      'Separate the elements, or remove the stacking/negative-margin/absolute positioning that makes them collide.',
  },
  'layout/content-clipped': {
    category: 'layout',
    whatIsWrong:
      'A container hides its own text with overflow:hidden because the text is taller than the fixed height allowed for it. Part of the content is invisible and unreachable.',
    howToFix:
      'Let the container grow: replace the fixed height with min-height, or remove overflow:hidden.',
  },

  // --- transport -----------------------------------------------------------
  'fetch/unreachable': {
    category: 'transport',
    whatIsWrong: 'The page could not be fetched at all: DNS, TLS, connection or timeout failure.',
    howToFix:
      'Confirm the host resolves, the certificate is valid and the origin answers within the timeout.',
  },
  'fetch/head-request-fails': {
    category: 'transport',
    whatIsWrong:
      'HEAD errors while GET succeeds. Caches, uptime monitors and link checkers issue HEAD first and will treat this URL as unreachable.',
    howToFix:
      'Handle HEAD on every route that handles GET: identical status and headers, empty body.',
  },
  'fetch/head-get-mismatch': {
    category: 'transport',
    whatIsWrong:
      'The same URL reports two different states depending on the HTTP method. CDN caches, uptime monitors, link checkers and social-preview crawlers all issue HEAD first, so to every one of them this page does not exist.',
    howToFix:
      'Make HEAD return exactly what GET returns minus the body. In most frameworks this means routing HEAD to the GET handler rather than letting it fall through to a catch-all.',
  },
  'fetch/head-get-content-type-mismatch': {
    category: 'transport',
    whatIsWrong:
      'HEAD and GET advertise different content types for one URL, which breaks cache keys and content sniffing.',
    howToFix: 'Return the same Content-Type from both methods.',
  },

  // --- measured contrast ----------------------------------------------------
  'contrast/contrast-over-image': {
    category: 'accessibility',
    audience: 'assistive-tech',
    whatIsWrong:
      'Text does not have enough contrast against what is actually rendered behind it. These are the cases the static engines cannot judge: the text is semi-transparent, or sits on a gradient, an image, or a stack of translucent layers, so its real colour only exists once the page is composited. Measured here by hiding the glyphs, screenshotting the page and sampling the pixels behind every line of text.',
    howToFix:
      'Raise the text opacity, darken or lighten the layer behind it, or put a solid backing behind the text. Judge it at the WORST point reported, not the average: a gradient is only as readable as its lightest region under light text.',
    standards: wcag('1.4.3'),
  },

  // --- branding -------------------------------------------------------------
  'branding/logo-missing': {
    category: 'seo',
    audience: 'visitor',
    whatIsWrong:
      'The header brand is plain text with no image or SVG, so the site has no visual mark at all.',
    howToFix: 'Add a logo image or inline SVG inside the header link to the site root.',
  },
  'branding/logo-broken': {
    category: 'seo',
    audience: 'visitor',
    whatIsWrong:
      'The header logo is an image that failed to load, so visitors see a broken image or nothing where the brand should be.',
    howToFix: 'Fix the logo URL, or serve the asset from a host that resolves.',
  },
  'branding/logo-wordmark-only': {
    category: 'seo',
    audience: 'visitor',
    whatIsWrong:
      'The brand mark is the business name set as type, with no symbol. That is legitimate -- logotypes are explicitly exempt from the images-of-text rule -- but a wide strip of text carries no identity at small sizes, cannot serve as a favicon, app icon or social avatar, and is usually a generated placeholder nobody replaced.',
    howToFix:
      'Add a distinct mark that still reads at 32x32, and keep the wordmark for the full-width header lockup. Whether the current one looks good is a design judgement this scan does not make; what it reports is that there is no symbol, only type.',
  },
  'branding/logo-name-overridden': {
    category: 'accessibility',
    audience: 'assistive-tech',
    whatIsWrong:
      'The link wrapping the logo carries an aria-label, which overrides the alt text on the image inside it. The alt is never announced, so two names are being maintained and only one is heard -- they will drift apart.',
    howToFix:
      'Keep the aria-label on the link and set alt="" on the image, or drop the aria-label and let the alt describe it. Not both.',
    standards: wcag('1.1.1', '4.1.2'),
  },
  'branding/favicon-missing': {
    category: 'seo',
    audience: 'visitor',
    whatIsWrong:
      'The document declares no <link rel="icon">. Browsers fall back to /favicon.ico only if the server happens to serve one; nothing is guaranteed, no resolution is specified, and tab strips, bookmarks, history and search results have no icon to show.',
    howToFix:
      'Add <link rel="icon" href="/favicon.svg" type="image/svg+xml"> plus a 32x32 PNG fallback to <head>.',
  },
  'branding/apple-touch-icon-missing': {
    category: 'seo',
    audience: 'visitor',
    whatIsWrong:
      'No apple-touch-icon is declared, so a site saved to an iOS home screen gets a blurry screenshot of the page instead of an icon.',
    howToFix: 'Add <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">.',
  },

  // --- links ---------------------------------------------------------------
  'lychee/link-timeout': {
    category: 'links',
    whatIsWrong: 'The link did not respond within the timeout, so visitors see a hanging page.',
    howToFix: 'Confirm the target is reachable; replace or remove it if the host is gone.',
  },
};

/** Broken-link rules are generated per status code, so they are matched by prefix. */
function brokenLinkInfo(rule: string): RuleInfo | undefined {
  if (!rule.startsWith('broken-link-')) return undefined;
  const code = rule.slice('broken-link-'.length);
  if (code === '404' || code === '410') {
    return {
      category: 'links',
      whatIsWrong:
        'The link points at a page that does not exist. Visitors hit a dead end, and search engines treat it as a quality signal against the site.',
      howToFix:
        'Point the link at the correct URL, or restore the missing page, or remove the link. If the page moved, add a 301 redirect from the old URL.',
    };
  }
  if (/^5\d\d$/.test(code)) {
    return {
      category: 'links',
      whatIsWrong: 'The linked page returns a server error, so the destination is broken.',
      howToFix: 'Fix the error at the destination, or remove the link until it is fixed.',
    };
  }
  if (code === '403' || code === '401') {
    return {
      category: 'links',
      whatIsWrong:
        'The linked URL refuses access to automated clients. Often bot protection rather than a real break, but it also blocks search engines and preview crawlers.',
      howToFix: 'Verify the link in a browser; if it works, no change is needed.',
    };
  }
  return {
    category: 'links',
    whatIsWrong: 'The link did not resolve successfully.',
    howToFix: 'Verify the destination and update or remove the link.',
  };
}

// ---------------------------------------------------------------------------
// axe-core: decode its own tags rather than tabulate 105 rules.
// ---------------------------------------------------------------------------

/**
 * axe tags every rule with the criteria it implements, e.g.
 * ["cat.color", "wcag2aa", "wcag143", "ACT"]. Decoding those covers every axe
 * rule, including ones added by a future axe release.
 */
export function standardsFromAxeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];

  for (const tag of tags) {
    // "wcag143" -> 1.4.3 ; "wcag2410" -> 2.4.10
    const sc = /^wcag(\d)(\d)(\d+)$/.exec(tag);
    if (sc) {
      out.push(...wcag(`${sc[1]}.${sc[2]}.${sc[3]}`));
      continue;
    }
    // "wcag2aa" -> WCAG 2.0 Level AA ; "wcag22aa" -> WCAG 2.2 Level AA
    const level = /^wcag(\d)(\d)?(a{1,3})$/.exec(tag);
    if (level) {
      const minor = level[2] ?? '0';
      out.push(`WCAG ${level[1]}.${minor} Level ${(level[3] ?? '').toUpperCase()}`);
      continue;
    }
    if (tag === 'best-practice') out.push('Best practice (not a WCAG failure)');
    if (tag === 'section508') out.push('Section 508');
  }

  return [...new Set(out)];
}

/** axe's `cat.*` tag is a ready-made category. */
function categoryFromAxeTags(tags: readonly string[] | undefined): Category {
  for (const tag of tags ?? []) {
    if (tag === 'cat.structure' || tag === 'cat.parsing') return 'markup';
    if (tag === 'cat.sensory-and-visual-cues') return 'layout';
  }
  return 'accessibility';
}

/** Lighthouse category id -> our category. */
const LIGHTHOUSE_CATEGORY: Record<string, Category> = {
  performance: 'performance',
  accessibility: 'accessibility',
  seo: 'seo',
  'best-practices': 'markup',
};

/** Last-resort category when a rule is not described anywhere. */
const TOOL_CATEGORY: Record<ToolName, Category> = {
  'axe-core': 'accessibility',
  'ibm-equal-access': 'accessibility',
  lighthouse: 'performance',
  layout: 'layout',
  contrast: 'accessibility',
  branding: 'seo',
  'html-validate': 'markup',
  'nu-validator': 'markup',
  lychee: 'links',
  semantics: 'markup',
  fetch: 'transport',
};

/** Generic guidance per tool, used when the rule itself carries no remedy. */
const TOOL_FALLBACK: Partial<Record<ToolName, string>> = {
  'html-validate':
    'Correct the markup so it validates. Invalid nesting changes how browsers build the DOM, which silently breaks CSS selectors and assistive technology.',
  'nu-validator':
    'Correct the markup so it validates against the HTML specification. The W3C validator is the reference implementation browsers are measured against.',
  'ibm-equal-access':
    'Follow the linked IBM Accessibility Requirements guidance for this rule.',
  'axe-core': 'Follow the linked Deque rule documentation.',
  lighthouse: 'Follow the audit guidance in the description.',
};

/**
 * Markup rules that are true spec deviations with no runtime consequence.
 *
 * These are not "less important" in the abstract -- they are important to the
 * codebase and meaningless to every visitor. Ranking them by the same severity
 * scale as a broken link is what produced a report that was 76% noise.
 */
const DEVELOPER_ONLY = new Set([
  'html-validate/no-inline-style',
  'html-validate/attr-case',
  'html-validate/attribute-empty-style',
  'html-validate/attribute-boolean-style',
  'html-validate/void-style',
  'html-validate/attr-quotes',
  'html-validate/no-trailing-whitespace',
  'html-validate/element-permitted-content',
  'html-validate/no-implicit-button-type',
  'html-validate/long-title',
]);

/** Markup rule ids that DO reach a user, via assistive technology. */
const ASSISTIVE_MARKUP = /aria|label|landmark|heading|alt\b|lang\b|role|fieldset|legend|input|form|title/i;

/** Resolves who is affected. Never returns undefined. */
export function audienceFor(tool: ToolName, rule: string, category: Category): Audience {
  if (DEVELOPER_ONLY.has(`${tool}/${rule}`)) return 'developer';

  if (tool === 'html-validate' || tool === 'nu-validator') {
    return ASSISTIVE_MARKUP.test(rule) ? 'assistive-tech' : 'developer';
  }

  switch (category) {
    case 'accessibility':
      return 'assistive-tech';
    case 'seo':
      return 'search';
    case 'markup':
      return 'developer';
    case 'scan':
      return 'developer';
    default:
      // links, transport, layout, performance, security
      return 'visitor';
  }
}

export interface ClassifyInput {
  tool: ToolName;
  rule: string;
  /** axe rule tags, when the tool is axe. */
  tags?: readonly string[];
  /** Lighthouse category id, when the tool is Lighthouse. */
  lighthouseCategory?: string;
}

/**
 * Resolves any rule from any tool. Never returns undefined -- an unknown rule
 * still gets a category and generic guidance, so no finding is ever blank.
 */
export function classify(input: ClassifyInput): RuleInfo {
  const own = OWN_RULES[`${input.tool}/${input.rule}`];
  if (own) return own;

  if (input.tool === 'lychee') {
    const link = brokenLinkInfo(input.rule);
    if (link) return link;
  }

  // Layout re-runs its rules at a phone viewport with a "-mobile" suffix.
  if (input.tool === 'layout' && input.rule.endsWith('-mobile')) {
    const base = OWN_RULES[`layout/${input.rule.slice(0, -'-mobile'.length)}`];
    if (base) {
      return {
        ...base,
        whatIsWrong: `At a 390px phone viewport: ${base.whatIsWrong ?? ''}`.trim(),
      };
    }
  }

  if (input.tool === 'axe-core') {
    return {
      category: categoryFromAxeTags(input.tags),
      standards: standardsFromAxeTags(input.tags),
      ...(TOOL_FALLBACK['axe-core'] ? { howToFix: TOOL_FALLBACK['axe-core'] } : {}),
    };
  }

  if (input.tool === 'lighthouse') {
    const category = LIGHTHOUSE_CATEGORY[input.lighthouseCategory ?? ''] ?? 'performance';
    return {
      category,
      ...(TOOL_FALLBACK.lighthouse ? { howToFix: TOOL_FALLBACK.lighthouse } : {}),
    };
  }

  const fallback = TOOL_FALLBACK[input.tool];
  return {
    category: TOOL_CATEGORY[input.tool],
    ...(fallback ? { howToFix: fallback } : {}),
  };
}
