/**
 * Layout geometry checks.
 *
 * This is the reason the browser lane exists. Everything here needs real
 * computed boxes -- element rectangles after CSS, fonts and JavaScript have
 * settled -- and is therefore impossible in the fast lane.
 *
 * All measurement happens inside the page and returns plain serialisable data.
 * No screenshots are involved in the decision: findings come from numbers, not
 * from comparing images.
 */

import type { Page } from 'playwright';

import { makeFinding, truncate } from '../../core/finding.js';
import type { Finding, PageTarget, Severity } from '../../core/types.js';

/** WCAG 2.2 SC 2.5.8 Target Size (Minimum) is 24x24 CSS pixels. */
const MIN_TAP_TARGET = 24;

/** Ignore sub-pixel and scrollbar-width noise when judging overflow. */
const OVERFLOW_TOLERANCE = 2;

export interface LayoutIssue {
  rule: string;
  title: string;
  detail?: string;
  selector?: string;
  snippet?: string;
  count: number;
  severity: Severity;
}

/**
 * The in-page measurement routine. Runs as a single evaluate so the DOM is
 * walked once, not once per rule.
 *
 * Passed to page.evaluate as a function value, which Playwright serialises and
 * invokes through the debugger protocol. Deliberately NOT injected as a string
 * for eval(): many of these sites ship a Content-Security-Policy, and a
 * script-src without 'unsafe-eval' would silently break every layout check.
 */
function collectLayoutIssues(opts: { minTapTarget: number; tolerance: number }): LayoutIssue[] {
  const { minTapTarget, tolerance } = opts;
  const issues: LayoutIssue[] = [];

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
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

  const outerHtml = (el: Element): string => el.outerHTML.slice(0, 160);

  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const viewportWidth = document.documentElement.clientWidth;

  // ---- 1. Document-level horizontal overflow -------------------------------
  const docWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0,
  );
  if (docWidth > viewportWidth + tolerance) {
    issues.push({
      rule: 'horizontal-overflow',
      severity: 'serious',
      title: `Page scrolls horizontally: content is ${Math.round(docWidth)}px wide in a ${viewportWidth}px viewport`,
      detail:
        'Horizontal scrolling on a page that is not meant to scroll sideways is one of the most common mobile layout defects.',
      count: 1,
    });

    // ---- 2. Which elements actually stick out? -----------------------------
    const offenders: Array<{ selector: string; snippet: string; right: number }> = [];
    const all = document.querySelectorAll<HTMLElement>('body *');
    for (let i = 0; i < all.length && offenders.length < 5; i += 1) {
      const el = all[i] as HTMLElement;
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.width > viewportWidth * 3) continue;
      if (rect.right > viewportWidth + tolerance) {
        // Only blame the element if its parent does NOT also overflow, so we
        // report the actual culprit rather than every ancestor of it.
        const parent = el.parentElement;
        const parentOverflows =
          parent !== null && parent !== document.body
            ? parent.getBoundingClientRect().right > viewportWidth + tolerance
            : false;
        if (!parentOverflows) {
          offenders.push({
            selector: cssPath(el),
            snippet: outerHtml(el),
            right: Math.round(rect.right),
          });
        }
      }
    }
    for (const offender of offenders) {
      issues.push({
        rule: 'element-overflows-viewport',
        severity: 'moderate',
        title: `Element extends ${offender.right - viewportWidth}px past the right edge of the viewport`,
        selector: offender.selector,
        snippet: offender.snippet,
        count: 1,
      });
    }
  }

  // ---- 3. Tap targets below the WCAG 2.2 minimum ---------------------------
  const interactiveSelector =
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [onclick]';
  const interactive = Array.from(
    document.querySelectorAll<HTMLElement>(interactiveSelector),
  ).filter(isVisible);

  const small: Array<{ selector: string; snippet: string; w: number; h: number }> = [];
  for (const el of interactive) {
    const rect = el.getBoundingClientRect();
    // SC 2.5.8 exempts targets that sit inline within a sentence.
    const style = window.getComputedStyle(el);
    if (style.display === 'inline') {
      const parentText = el.parentElement?.textContent ?? '';
      const ownText = el.textContent ?? '';
      if (parentText.trim().length > ownText.trim().length + 20) continue;
    }
    if (rect.width < minTapTarget || rect.height < minTapTarget) {
      small.push({
        selector: cssPath(el),
        snippet: outerHtml(el),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }
  }
  if (small.length > 0) {
    const first = small[0] as { selector: string; snippet: string; w: number; h: number };
    issues.push({
      rule: 'tap-target-too-small',
      severity: 'moderate',
      title: `${small.length} interactive element(s) smaller than ${minTapTarget}x${minTapTarget}px (smallest ${first.w}x${first.h}px)`,
      detail:
        'WCAG 2.2 SC 2.5.8 requires a minimum 24x24 CSS pixel target. Small controls are hard to hit accurately on touch screens and for users with motor impairments.',
      selector: first.selector,
      snippet: first.snippet,
      count: small.length,
    });
  }

  // ---- 4. Overlapping interactive elements ---------------------------------
  // Two separately clickable things sitting on top of each other means one of
  // them is unreachable, or the wrong one receives the tap.
  const candidates = interactive.slice(0, 250);
  const overlaps: Array<{ selector: string; snippet: string; other: string }> = [];
  for (let i = 0; i < candidates.length && overlaps.length < 5; i += 1) {
    const a = candidates[i] as HTMLElement;
    const ra = a.getBoundingClientRect();
    if (ra.width === 0 || ra.height === 0) continue;

    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j] as HTMLElement;
      // Nested controls legitimately share space.
      if (a.contains(b) || b.contains(a)) continue;
      const rb = b.getBoundingClientRect();
      if (rb.width === 0 || rb.height === 0) continue;

      const overlapW = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const overlapH = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (overlapW <= 1 || overlapH <= 1) continue;

      const overlapArea = overlapW * overlapH;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (smaller > 0 && overlapArea / smaller > 0.4) {
        overlaps.push({ selector: cssPath(a), snippet: outerHtml(a), other: cssPath(b) });
        break;
      }
    }
  }
  if (overlaps.length > 0) {
    const first = overlaps[0] as { selector: string; snippet: string; other: string };
    issues.push({
      rule: 'interactive-overlap',
      severity: 'serious',
      title: `${overlaps.length} pair(s) of interactive elements overlap by more than 40%`,
      detail: `"${first.selector}" overlaps "${first.other}". One of them is likely unclickable.`,
      selector: first.selector,
      snippet: first.snippet,
      count: overlaps.length,
    });
  }

  // ---- 5. Content clipped by a fixed-height container ----------------------
  const clipped: Array<{ selector: string; snippet: string }> = [];
  const blocks = document.querySelectorAll<HTMLElement>('body *');
  for (let i = 0; i < blocks.length && clipped.length < 3; i += 1) {
    const el = blocks[i] as HTMLElement;
    if (!isVisible(el)) continue;
    const style = window.getComputedStyle(el);
    if (style.overflow !== 'hidden' && style.overflowY !== 'hidden') continue;
    if (el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 0) {
      const text = (el.textContent ?? '').trim();
      if (text.length > 20) {
        clipped.push({ selector: cssPath(el), snippet: outerHtml(el) });
      }
    }
  }
  if (clipped.length > 0) {
    const first = clipped[0] as { selector: string; snippet: string };
    issues.push({
      rule: 'content-clipped',
      severity: 'minor',
      title: `${clipped.length} container(s) clip their own text content with overflow:hidden`,
      detail: 'Text is taller than its container, so part of it is invisible and unreachable.',
      selector: first.selector,
      snippet: first.snippet,
      count: clipped.length,
    });
  }

  return issues;
}

export interface LayoutOptions {
  /** Also re-measure overflow at a phone viewport. */
  mobilePass?: boolean;
  mobileViewport?: { width: number; height: number };
}

/**
 * Installs an identity `__name` shim in the page.
 *
 * tsx/esbuild compiles with keepNames, which rewrites every inner function as
 * `__name(fn, "fn")` to preserve `Function.prototype.name`. That helper is
 * defined in the Node module scope, so when Playwright serialises
 * collectLayoutIssues into the browser the reference is dangling and every
 * layout check dies with "__name is not defined".
 *
 * Passed as a STRING expression on purpose: a function argument would itself be
 * compiled by esbuild and could reference the very helper it is trying to
 * define. Playwright runs it through the debugger protocol, so it is not
 * subject to the page's Content-Security-Policy.
 */
async function ensureNameShim(page: Page): Promise<void> {
  await page.evaluate(
    '(() => { if (typeof globalThis.__name !== "function") { globalThis.__name = function (f) { return f; }; } })()',
  );
}

/**
 * Measures the page at its current viewport, then optionally re-measures
 * overflow at a phone width -- horizontal scroll is overwhelmingly a mobile
 * defect and invisible at 1280px.
 */
export async function checkLayout(
  target: PageTarget,
  page: Page,
  opts: LayoutOptions = {},
  evidence?: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  const toFindings = (issues: LayoutIssue[], viewportLabel: string): void => {
    for (const issue of issues) {
      findings.push(
        makeFinding({
          site: target.site,
          url: target.url,
          lane: 'browser',
          tool: 'layout',
          rule: viewportLabel === 'mobile' ? `${issue.rule}-mobile` : issue.rule,
          severity: issue.severity,
          title: viewportLabel === 'mobile' ? `[mobile] ${issue.title}` : issue.title,
          ...(issue.detail !== undefined ? { detail: issue.detail } : {}),
          location: {
            ...(issue.selector ? { selector: issue.selector } : {}),
            ...(issue.snippet ? { snippet: truncate(issue.snippet, 160) } : {}),
          },
          ...(evidence ? { evidence } : {}),
          count: issue.count,
        }),
      );
    }
  };

  await ensureNameShim(page);

  const desktop = await page.evaluate(collectLayoutIssues, {
    minTapTarget: MIN_TAP_TARGET,
    tolerance: OVERFLOW_TOLERANCE,
  });
  toFindings(desktop, 'desktop');

  if (opts.mobilePass) {
    const original = page.viewportSize();
    const mobile = opts.mobileViewport ?? { width: 390, height: 844 };
    try {
      await page.setViewportSize(mobile);
      // Let responsive CSS and any resize observers settle.
      await page.waitForTimeout(250);
      const issues = await page.evaluate(collectLayoutIssues, {
        minTapTarget: MIN_TAP_TARGET,
        tolerance: OVERFLOW_TOLERANCE,
      });
      // Only overflow is re-reported; re-reporting tap targets would duplicate.
      toFindings(
        issues.filter((i) => i.rule.includes('overflow')),
        'mobile',
      );
    } finally {
      if (original) await page.setViewportSize(original);
    }
  }

  return findings;
}
