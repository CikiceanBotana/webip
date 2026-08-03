/**
 * Can a phone user navigate the site at all?
 *
 * The standard responsive pattern is: hide the horizontal nav below the tablet
 * breakpoint, show a menu button in its place. The standard way to get it wrong
 * is to ship the first half and never build the second, which is invisible on a
 * desktop and total on a phone -- the header collapses to a logo and every other
 * page becomes unreachable from the top of the document.
 *
 * No static tool can see this. The links are present in the HTML and pass every
 * accessibility, markup and link check; they are simply painted out by a media
 * query. It takes a real browser at a real phone width to notice, which is why
 * it lives here.
 *
 * The check is empirical end to end. It does not assume a hamburger is missing
 * because it cannot find a familiar class name -- it looks for anything that
 * could plausibly open a menu, CLICKS it, and re-counts. Only if the links are
 * still gone afterwards is anything reported.
 */

import type { ElementHandle, Page } from 'playwright';

import { makeFinding, truncate } from '../../core/finding.js';
import type { Finding, FindingInstance, PageTarget, Severity } from '../../core/types.js';

import { ensureNameShim } from './shim.js';

/** How many hidden links to name in the report. */
const MAX_NAMED_LINKS = 20;

/** Time for a menu transition to finish after the toggle is clicked. */
const MENU_ANIMATION_MS = 500;

/** Toggles tried before concluding nothing opens the menu. */
const MAX_TOGGLE_ATTEMPTS = 4;

/** Per-click budget. A control that cannot be clicked has not opened anything. */
const CLICK_TIMEOUT_MS = 3000;

export interface NavLink {
  href: string;
  text: string;
  /** Rendered box in viewport coordinates. Absent when not painted. */
  box?: { x: number; y: number; w: number; h: number };
  /** Line boxes the label wraps onto. 1 for a label on a single line. */
  lines?: number;
}

export interface NavToggle {
  /**
   * Index of the `data-webip-toggle` attribute stamped on the element itself.
   *
   * A generated CSS path is NOT good enough to click by. The paths this module
   * builds are short and shared: on one real site, five toggle candidates
   * re-queried into seventeen elements, so "click the menu button" clicked
   * every button in a testimonial carousel as well. Marking the exact nodes
   * removes the ambiguity entirely.
   */
  index: number;
  selector: string;
  snippet: string;
  label: string;
}

export interface NavSurvey {
  /** A description of the element treated as the primary navigation. */
  scope: string;
  /** Its markup, so a reader can see the breakpoint class that hides things. */
  scopeSnippet: string;
  /** Links visible inside the primary navigation right now. */
  links: NavLink[];
  /** Links present in the navigation markup but not painted at this width. */
  hidden: NavLink[];
  /** Anything inside it that could open a menu. */
  toggles: NavToggle[];
  /** Every visible link anywhere on the page -- the footer-fallback test. */
  pageHrefs: string[];
}

/**
 * Inventories the primary navigation at whatever the current viewport is.
 *
 * Runs inside the page, so every helper it uses has to be defined inside it:
 * Playwright serialises the function across the debugger protocol and nothing
 * from this module's scope survives the trip. The same constraint is why
 * layout.ts, contrast.ts and branding.ts each carry their own copy.
 */
function surveyNavigationInPage(): NavSurvey {
  const cssPath = (el: Element | null): string => {
    if (!el) return '';
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

  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const nameOf = (el: Element): string => {
    const aria = (el.getAttribute('aria-label') ?? '').trim();
    if (aria) return aria;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text;
    const img = el.querySelector('img[alt]');
    return (img?.getAttribute('alt') ?? '').trim();
  };

  /**
   * The primary navigation, in order of confidence.
   *
   * The footer is deliberately excluded. Nearly every site repeats its nav
   * links down there, and counting them would mask exactly the defect being
   * looked for: the header can be completely empty while the footer still
   * carries a full sitemap. Whether those footer links exist is a separate
   * question, asked further down to decide how bad this is.
   */
  const inFooter = (el: Element): boolean => el.closest('footer, [role=contentinfo]') !== null;

  let scopeEl: Element | null = null;
  for (const selector of ['header', '[role=banner]', 'nav', '[role=navigation]']) {
    const found = Array.from(document.querySelectorAll(selector)).filter(
      (el) => !inFooter(el) && isVisible(el),
    );
    // The one carrying the most links wins; a bare <header> with only a logo is
    // not the navigation if a <nav> beside it has five links.
    const best = found.sort(
      (a, b) => b.querySelectorAll('a[href]').length - a.querySelectorAll('a[href]').length,
    )[0];
    if (best && best.querySelectorAll('a[href]').length > 0) {
      scopeEl = best;
      break;
    }
  }

  if (!scopeEl) {
    return { scope: '', scopeSnippet: '', links: [], hidden: [], toggles: [], pageHrefs: [] };
  }

  /**
   * How many line boxes the label occupies. A horizontal nav link that wraps
   * onto two lines is the visible signature of a row with no room left.
   */
  const lineCount = (el: Element): number => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    // Distinct baselines, not distinct boxes: an inline icon beside the label
    // is a second rect on the same line and must not read as a second line.
    const tops = new Set(rects.map((r) => Math.round(r.top / 4)));
    return Math.max(1, tops.size);
  };

  const links: NavLink[] = [];
  const hidden: NavLink[] = [];
  const seenHref = new Set<string>();
  for (const anchor of Array.from(scopeEl.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = anchor.getAttribute('href') ?? '';
    if (href === '' || href.startsWith('#') || href.startsWith('javascript:')) continue;
    if (seenHref.has(href) && isVisible(anchor)) continue;

    if (!isVisible(anchor)) {
      hidden.push({ href, text: nameOf(anchor) });
      continue;
    }
    seenHref.add(href);
    const rect = anchor.getBoundingClientRect();
    links.push({
      href,
      text: nameOf(anchor),
      box: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      lines: lineCount(anchor),
    });
  }

  /**
   * Anything that could open a menu.
   *
   * Wide enough not to miss one -- a missed toggle means a false report, and
   * this rule makes a loud claim -- but no wider, because every candidate here
   * is going to be CLICKED on somebody's live site. Two scopes:
   *
   *   - any visible button-like element inside the header. Cheap and safe: a
   *     header holds a handful of controls and the hamburger is always one.
   *   - anywhere else on the page, only elements whose own name or id says they
   *     are a menu. The words "nav" and "toggle" are deliberately NOT in that
   *     list: they matched `testimonial-carousel__navigation-button` on a real
   *     site and clicked through a carousel looking for a menu.
   */
  const toggleSelector =
    'button, [role=button], [aria-expanded], [aria-controls], summary, input[type=button], input[type=checkbox]';
  const toggleEls = new Set<Element>();
  for (const el of Array.from(scopeEl.querySelectorAll(toggleSelector))) {
    if (isVisible(el)) toggleEls.add(el);
  }
  for (const el of Array.from(document.querySelectorAll(toggleSelector))) {
    if (inFooter(el) || !isVisible(el)) continue;
    const label = `${nameOf(el)} ${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`;
    if (/\b(menu|hamburger|burger|drawer)\b/i.test(label)) toggleEls.add(el);
  }

  // Stale marks from an earlier survey would collide with this one's indices.
  for (const marked of Array.from(document.querySelectorAll('[data-webip-toggle]'))) {
    marked.removeAttribute('data-webip-toggle');
  }

  /**
   * Menu-looking controls first, and the order matters more than it sounds.
   *
   * These get clicked in sequence on a live page. On one real site the header's
   * first button was Search, clicking it opened a modal over the whole page,
   * and the actual "Toggle navigation" button two positions later could no
   * longer be clicked at all -- so the site was reported as having a broken
   * menu because of an overlay this check had opened itself. Trying the most
   * likely candidate first usually means never touching the others.
   */
  const looksLikeMenu = (el: Element): boolean =>
    /\b(menu|nav|hamburger|burger|drawer|toggle)/i.test(
      `${nameOf(el)} ${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''}`,
    );

  const ordered = Array.from(toggleEls).sort(
    (a, b) => Number(looksLikeMenu(b)) - Number(looksLikeMenu(a)),
  );

  const toggles: NavToggle[] = ordered.map((el, index) => {
    el.setAttribute('data-webip-toggle', String(index));
    return {
      index,
      selector: cssPath(el),
      snippet: el.outerHTML.slice(0, 160),
      label: nameOf(el) || '(no accessible name)',
    };
  });

  const pageHrefs: string[] = [];
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (isVisible(anchor)) pageHrefs.push(anchor.getAttribute('href') ?? '');
  }

  return {
    scope: cssPath(scopeEl),
    scopeSnippet: scopeEl.outerHTML.slice(0, 400),
    links,
    hidden,
    toggles,
    pageHrefs,
  };
}

/** Inventories the primary navigation at the page's current viewport. */
export async function surveyNavigation(page: Page): Promise<NavSurvey> {
  await ensureNameShim(page);
  return page.evaluate(surveyNavigationInPage);
}

/**
 * Clicks the candidate toggles, one at a time, and reports whether a menu
 * appeared.
 *
 * Three things this has to get right, each learned from a false positive on a
 * site whose menu works perfectly:
 *
 *   - Click ONE at a time and re-check after each. Clicking them all and
 *     looking once is worse than useless: the second click closes what the
 *     first opened, and the check concludes nothing happened.
 *   - Undo an attempt that did not help, so the page is handed on the way it
 *     was found rather than with three panels open.
 *   - Use a real input-level click. `HTMLElement.click()` dispatches an
 *     untrusted event with no pointer sequence behind it, and a framework menu
 *     listening for pointerdown simply does not react -- which reads back as
 *     "the menu is broken" for a menu that is fine.
 *
 * Anchors with a real href are never clicked: that would navigate away and end
 * the inspection.
 */
async function tryOpenMenu(
  page: Page,
  toggles: readonly NavToggle[],
  restored: (survey: NavSurvey) => boolean,
): Promise<{ attempted: number; survey: NavSurvey | null }> {
  let attempted = 0;

  /**
   * Resolved to element handles UP FRONT, before anything is clicked.
   *
   * The marks cannot be re-queried later: every survey clears and re-stamps
   * `data-webip-toggle`, so an index captured now points at a different element
   * after the first re-survey, and the undo click lands on a stranger. A handle
   * is a reference to the node itself and survives the renumbering.
   */
  const candidates: Array<{ toggle: NavToggle; handle: ElementHandle<Element> }> = [];
  for (const toggle of toggles.slice(0, MAX_TOGGLE_ATTEMPTS)) {
    const href = /href="([^"]*)"/.exec(toggle.snippet)?.[1];
    if (href !== undefined && href !== '' && !href.startsWith('#')) continue;
    const handle = await page.$(`[data-webip-toggle="${toggle.index}"]`);
    if (handle) candidates.push({ toggle, handle });
  }

  try {
    for (const { handle } of candidates) {
      try {
        await handle.click({ timeout: CLICK_TIMEOUT_MS });
        attempted += 1;
      } catch {
        continue; // not clickable: it has not opened anything
      }

      await page.waitForTimeout(MENU_ANIMATION_MS);
      const survey = await page.evaluate(surveyNavigationInPage);
      if (restored(survey)) return { attempted, survey };

      // Not the one. Put the page back before trying the next, or this check's
      // own side effects become the reason the next candidate cannot be
      // clicked. Escape covers what a second click does not: a search modal
      // stays open when its trigger is clicked again from underneath it.
      try {
        await page.keyboard.press('Escape');
        await handle.click({ timeout: CLICK_TIMEOUT_MS });
        await page.waitForTimeout(MENU_ANIMATION_MS);
      } catch {
        /* leaving it open only risks a false NEGATIVE, which is the safe way to err */
      }
    }
  } finally {
    await Promise.all(candidates.map(({ handle }) => handle.dispose().catch(() => undefined)));
  }

  return { attempted, survey: null };
}

export interface NavVerdict {
  /** Destinations the header offers at the wide viewport, excluding the logo. */
  offered: NavLink[];
  /** Of those, the ones not painted at the narrow viewport. */
  lost: NavLink[];
  /** Destinations still reachable in the header at the narrow viewport. */
  remaining: NavLink[];
  /** Whether this amounts to the navigation collapsing rather than changing. */
  collapsed: boolean;
}

/**
 * Decides whether a narrow viewport LOSES the navigation or merely rearranges
 * it. Pure, so the judgement can be tested without a browser.
 *
 * Three conditions, all required. Two exist purely to stop this rule crying
 * wolf, which matters more here than anywhere else in the scan: it makes a loud
 * claim, and it will make it on every page of every site sharing a template.
 *
 *   - at least two destinations to begin with -- a one-link header is not
 *     navigation and cannot lose it
 *   - at least two of them gone -- a single dropped link is a design choice
 *   - at most one left -- a header that keeps three of five has reorganised its
 *     menu, which is normal responsive behaviour and none of our business
 */
export function compareNavigation(desktop: NavSurvey, narrow: NavSurvey): NavVerdict {
  // The site root is the logo, not a destination. A header showing nothing but
  // its own logo has no navigation, however many times it links to itself.
  const isRootish = (href: string): boolean => /^(\/|\.\/|#|https?:\/\/[^/]+\/?)$/.test(href.trim());

  const offered = desktop.links.filter((link) => !isRootish(link.href));
  const visible = new Set(narrow.links.map((link) => link.href));
  const lost = offered.filter((link) => !visible.has(link.href));
  const remaining = narrow.links.filter((link) => !isRootish(link.href));

  return {
    offered,
    lost,
    remaining,
    collapsed: offered.length >= 2 && lost.length >= 2 && remaining.length <= 1,
  };
}

/**
 * Reports a navigation that survived the narrow viewport without adapting to it.
 *
 * Separate from the collapse case because the remedy is different: this header
 * does not need a menu button wired up, it needs a mobile layout at all.
 */
function crampedFindings(
  target: PageTarget,
  mobile: NavSurvey,
  opts: MobileNavOptions,
  evidence?: string,
): Finding[] {
  const crowding = assessCrowding(opts.desktop, mobile);
  if (!crowding.cramped) return [];

  const { wrapped, touching, dropped } = crowding;
  const symptoms: string[] = [];
  if (wrapped.length > 0) {
    symptoms.push(`${wrapped.length} label(s) wrap onto a second line`);
  }
  if (touching.length > 0) {
    const tightest = Math.min(...touching.map((t) => t.gap));
    symptoms.push(`${touching.length} pair(s) of items sit ${tightest}px apart`);
  }
  if (dropped.length > 0) {
    symptoms.push(`${dropped.length} control(s) are hidden outright to make room`);
  }

  const instances: FindingInstance[] = [
    {
      selector: mobile.scope || 'header',
      snippet: truncate(mobile.scopeSnippet, 400),
      message:
        'The desktop navigation row, at a phone width. It has no breakpoint of its own: the same flex row is simply given less space until its contents give way.',
      measured: symptoms.join('; '),
      expected: `a layout intended for ${opts.viewportWidth}px`,
    },
    ...wrapped.map((entry) => ({
      target: entry.link.href,
      message: `"${entry.link.text}" wraps onto ${entry.narrowLines} lines here and ${entry.wideLines} at the desktop width, so the row has run out of horizontal space`,
      measured: `${entry.narrowLines} lines, ${Math.round(entry.link.box?.w ?? 0)}px wide`,
      expected: `${entry.wideLines} line`,
    })),
    ...touching.map((entry) => ({
      target: entry.after.href,
      message: `"${entry.after.text}" begins ${entry.gap}px after "${entry.before.text}" ends, so the two read as one block and are easy to mis-tap`,
      measured: `${entry.gap}px gap`,
      expected: `at least ${MIN_ITEM_GAP}px`,
    })),
    ...dropped.map((link) => {
      const survives = mobile.pageHrefs.includes(link.href);
      return {
        target: link.href,
        message: `"${link.text}" is painted at the desktop width and set to display:none here${
          survives
            ? `; its destination is still reachable from another link on the page`
            : `; its destination is not reachable from anywhere else on this page`
        }`,
        measured: 'hidden at this width',
        expected: 'present, or replaced by an equivalent control',
      };
    }),
  ];

  // A hidden control whose destination survives elsewhere is a design choice.
  // One whose destination does not is a lost route, and outranks the squeeze.
  const strands = dropped.some((link) => !mobile.pageHrefs.includes(link.href));

  return [
    makeFinding({
      site: target.site,
      url: target.url,
      lane: 'browser',
      tool: 'layout',
      rule: 'mobile-navigation-cramped',
      severity: strands ? 'serious' : 'moderate',
      title: `[mobile] The navigation is the desktop row squeezed into ${opts.viewportWidth}px: ${symptoms.join(', ')}`,
      detail: `The header keeps all ${mobile.links.length} of its items at ${opts.viewportWidth}px and never switches to a narrow layout.`,
      instances,
      ...(evidence ? { evidence } : {}),
      count: wrapped.length + touching.length + dropped.length,
    }),
  ];
}

/** Below this many pixels, two items in a row are touching rather than spaced. */
const MIN_ITEM_GAP = 8;

/** Two items count as sharing a row when their tops are within this. */
const SAME_ROW_TOLERANCE = 8;

export interface CrowdingReport {
  /** Labels that wrap onto more lines at the narrow width than the wide one. */
  wrapped: Array<{ link: NavLink; wideLines: number; narrowLines: number }>;
  /** Neighbouring items in the same row with almost no space between them. */
  touching: Array<{ before: NavLink; after: NavLink; gap: number }>;
  /** Controls painted at the wide width and not at the narrow one. */
  dropped: NavLink[];
  /** Whether the row shows measurable strain rather than adapting. */
  cramped: boolean;
}

/**
 * Decides whether a navigation that SURVIVES the narrow viewport has actually
 * adapted to it, or is just the desktop row squeezed until it buckles.
 *
 * `compareNavigation` answers "is the menu gone". This answers the other half,
 * which is what a phone user actually meets on a site that never built a mobile
 * layout: every link still there, two of them wrapped onto two lines, the first
 * one touching the logo, and the call-to-action quietly set to display:none to
 * buy back the space.
 *
 * Only measurements are used -- wrapped line counts and pixel gaps -- because
 * "looks cramped" is not something a scan can assert. Pure, so the judgement is
 * testable without a browser.
 */
export function assessCrowding(desktop: NavSurvey, narrow: NavSurvey): CrowdingReport {
  const wideByHref = new Map(desktop.links.map((link) => [link.href, link]));
  const narrowVisible = new Set(narrow.links.map((link) => link.href));

  const wrapped: CrowdingReport['wrapped'] = [];
  for (const link of narrow.links) {
    const wide = wideByHref.get(link.href);
    const wideLines = wide?.lines ?? 1;
    const narrowLines = link.lines ?? 1;
    if (narrowLines > wideLines) wrapped.push({ link, wideLines, narrowLines });
  }

  const laidOut = narrow.links.filter((link) => link.box !== undefined);
  const ordered = [...laidOut].sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0));
  const touching: CrowdingReport['touching'] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const before = ordered[i - 1] as NavLink;
    const after = ordered[i] as NavLink;
    const b = before.box;
    const a = after.box;
    if (!b || !a) continue;
    if (Math.abs(a.y - b.y) > SAME_ROW_TOLERANCE) continue; // different rows
    const gap = a.x - (b.x + b.w);
    if (gap < MIN_ITEM_GAP) touching.push({ before, after, gap: Math.round(gap) });
  }

  // Painted wide, not painted narrow. The narrow survey lists what is in the
  // markup but unpainted, which is how a `hidden sm:inline-block` CTA is told
  // apart from a link that was simply never there.
  const narrowHidden = new Set(narrow.hidden.map((link) => link.href));
  const dropped = desktop.links.filter(
    (link) => !narrowVisible.has(link.href) && narrowHidden.has(link.href),
  );

  return {
    wrapped,
    touching,
    dropped,
    cramped: wrapped.length > 0 || touching.length > 0,
  };
}

export interface MobileNavOptions {
  /** The inventory taken at the desktop viewport, before the page was resized. */
  desktop: NavSurvey;
  /** Width the page is currently at, for the message. */
  viewportWidth: number;
}

/**
 * The navigation a phone actually gets, in the two ways it goes wrong.
 *
 * Either the menu is GONE -- hidden by a media query with nothing put in its
 * place -- or it SURVIVES but was never adapted, so the desktop row is squeezed
 * into the narrow viewport until labels wrap and items touch.
 *
 * Both are reported only on measurements, and only after every plausible menu
 * button has been clicked, because the failure mode of a rule like this is
 * crying wolf on a site that merely reorganises its menu.
 */
export async function checkMobileNavigation(
  target: PageTarget,
  page: Page,
  opts: MobileNavOptions,
  evidence?: string,
): Promise<Finding[]> {
  const { desktop } = opts;

  await ensureNameShim(page);
  let mobile = await page.evaluate(surveyNavigationInPage);
  let verdict = compareNavigation(desktop, mobile);

  // The navigation survived the resize. That is not the end of the question:
  // surviving by being squeezed is its own defect.
  if (!verdict.collapsed) {
    return crampedFindings(target, mobile, opts, evidence);
  }

  /**
   * Did that click bring the navigation back?
   *
   * Two ways to say yes, because a mobile menu is not obliged to render inside
   * the header it belongs to. Either the primary nav scope regained its links,
   * or destinations that were not painted anywhere on the page a moment ago are
   * painted now -- which is a panel opening, wherever in the DOM it was
   * portalled to.
   *
   * The second test counts link ELEMENTS pointing at each lost destination, not
   * whether the destination is visible at all. Presence is useless here: almost
   * every template repeats its nav in the footer, so "is /pricing visible on
   * this page" answers yes before anything has been clicked. A panel opening
   * adds another visible anchor to the same href, and that increase is the
   * signal -- it survives both the footer copy and a menu portalled to the end
   * of the body, outside the header entirely.
   */
  const tally = (hrefs: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const href of hrefs) counts.set(href, (counts.get(href) ?? 0) + 1);
    return counts;
  };

  const before = tally(mobile.pageHrefs);
  const wanted = verdict.lost.map((link) => link.href);
  const restored = (survey: NavSurvey): boolean => {
    if (!compareNavigation(desktop, survey).collapsed) return true;
    const after = tally(survey.pageHrefs);
    const gained = wanted.filter((href) => (after.get(href) ?? 0) > (before.get(href) ?? 0));
    return gained.length >= Math.min(2, wanted.length);
  };

  // Something might open a menu. Find out by clicking it rather than guessing.
  const { attempted, survey: opened } = await tryOpenMenu(page, mobile.toggles, restored);
  if (opened) return []; // the menu works

  const toggleClicked = attempted > 0;

  const { offered, lost, remaining } = verdict;

  /**
   * Severity turns on whether the destinations survive anywhere else.
   *
   * Nearly every template repeats its nav in the footer. That is a genuine
   * mitigation -- the pages are still reachable, just buried at the bottom of
   * the document -- and pretending otherwise would overstate the finding. With
   * no footer copy, a phone visitor who lands on this page can reach no other
   * page on the site at all, which is as bad as the site being down.
   */
  const elsewhere = new Set(mobile.pageHrefs);
  const recoverable = lost.filter((l) => elsewhere.has(l.href));
  const strandedEverywhere = recoverable.length < lost.length / 2;
  const severity: Severity = strandedEverywhere ? 'critical' : 'serious';

  const fallback = strandedEverywhere
    ? 'They are not reachable anywhere else on the page either, so a phone visitor who lands here cannot get to another page of the site.'
    : `${recoverable.length} of them are still reachable further down the page (typically the footer), so navigating means scrolling to the bottom of every page.`;

  const openerNote = toggleClicked
    ? `${mobile.toggles.length} control(s) in the header were clicked to see whether a menu would open. None restored the links.`
    : 'There is no menu button in the header: no button, no aria-expanded, no aria-controls, nothing named like a menu anywhere on the page. The links are simply painted out by a media query with nothing put in their place.';

  return [
    makeFinding({
      site: target.site,
      url: target.url,
      lane: 'browser',
      tool: 'layout',
      rule: toggleClicked ? 'mobile-navigation-does-not-open' : 'no-mobile-navigation',
      severity,
      title: `[mobile] ${lost.length} navigation link(s) disappear at ${opts.viewportWidth}px and no menu button brings them back`,
      detail: `The header offers ${offered.length} destination(s) at the desktop viewport and ${remaining.length} at ${opts.viewportWidth}px. ${openerNote} ${fallback}`,
      instances: [
        {
          selector: desktop.scope || 'header',
          snippet: truncate(mobile.scopeSnippet || desktop.scopeSnippet, 400),
          message:
            'The primary navigation. Look for the breakpoint class on the wrapper around the links -- a "hidden md:flex" or equivalent hides them below the tablet width.',
          measured: `${remaining.length} destination(s) in the header at ${opts.viewportWidth}px`,
          expected: `${offered.length} destination(s), or a menu button that reveals them`,
        },
        ...lost.slice(0, MAX_NAMED_LINKS).map((link) => ({
          target: link.href,
          message: `"${link.text || '(no text)'}" is in the markup but not painted at ${opts.viewportWidth}px${
            elsewhere.has(link.href) ? '; still reachable further down the page' : '; unreachable from this page'
          }`,
          measured: 'hidden',
          expected: 'visible, or reachable through a menu button',
        })),
      ],
      ...(evidence ? { evidence } : {}),
      count: lost.length,
    }),
  ];
}
