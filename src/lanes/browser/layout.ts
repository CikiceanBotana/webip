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

/**
 * How many offending elements to name per rule.
 *
 * The previous limits (5 overflow offenders, 3 clipped containers, and only the
 * FIRST of however many undersized tap targets) were invisible in the output: a
 * page with 40 tiny buttons reported one selector and the number 40. Naming
 * them is the entire value of measuring them.
 */
const MAX_INSTANCES_PER_RULE = 40;

export interface LayoutInstance {
  selector?: string;
  snippet?: string;
  message?: string;
  measured?: string;
  expected?: string;
}

export interface LayoutIssue {
  rule: string;
  title: string;
  detail?: string;
  count: number;
  severity: Severity;
  instances: LayoutInstance[];
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
function collectLayoutIssues(opts: {
  minTapTarget: number;
  tolerance: number;
  maxInstances: number;
}): LayoutIssue[] {
  const { minTapTarget, tolerance, maxInstances } = opts;
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
      instances: [
        {
          selector: 'html',
          measured: `${Math.round(docWidth)}px content`,
          expected: `${viewportWidth}px viewport`,
        },
      ],
    });

    // ---- 2. Which elements actually stick out? -----------------------------
    const offenders: LayoutInstance[] = [];
    let offenderTotal = 0;
    const all = document.querySelectorAll<HTMLElement>('body *');
    for (let i = 0; i < all.length; i += 1) {
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
          offenderTotal += 1;
          if (offenders.length < maxInstances) {
            offenders.push({
              selector: cssPath(el),
              snippet: outerHtml(el),
              message: `Extends ${Math.round(rect.right) - viewportWidth}px past the right edge`,
              measured: `right edge at ${Math.round(rect.right)}px`,
              expected: `at most ${viewportWidth}px`,
            });
          }
        }
      }
    }
    if (offenderTotal > 0) {
      issues.push({
        rule: 'element-overflows-viewport',
        severity: 'moderate',
        title: `${offenderTotal} element(s) extend past the right edge of the viewport`,
        count: offenderTotal,
        instances: offenders,
      });
    }
  }

  // ---- 3. Tap targets below the WCAG 2.2 minimum ---------------------------
  const interactiveSelector =
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [onclick]';
  const interactive = Array.from(
    document.querySelectorAll<HTMLElement>(interactiveSelector),
  ).filter(isVisible);

  const small: LayoutInstance[] = [];
  let smallTotal = 0;
  let smallestArea = Infinity;
  let smallestLabel = '';
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
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      smallTotal += 1;
      if (w * h < smallestArea) {
        smallestArea = w * h;
        smallestLabel = `${w}x${h}px`;
      }
      if (small.length < maxInstances) {
        small.push({
          selector: cssPath(el),
          snippet: outerHtml(el),
          message: `Tap target is ${w}x${h}px`,
          measured: `${w}x${h}px`,
          expected: `${minTapTarget}x${minTapTarget}px`,
        });
      }
    }
  }
  if (smallTotal > 0) {
    issues.push({
      rule: 'tap-target-too-small',
      severity: 'moderate',
      title: `${smallTotal} interactive element(s) smaller than ${minTapTarget}x${minTapTarget}px (smallest ${smallestLabel})`,
      count: smallTotal,
      instances: small,
    });
  }

  // ---- 4. Overlapping interactive elements ---------------------------------
  // Two separately clickable things sitting on top of each other means one of
  // them is unreachable, or the wrong one receives the tap.
  const candidates = interactive.slice(0, 250);
  const overlaps: LayoutInstance[] = [];
  for (let i = 0; i < candidates.length && overlaps.length < maxInstances; i += 1) {
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
        overlaps.push({
          selector: cssPath(a),
          snippet: outerHtml(a),
          message: `Overlaps "${cssPath(b)}"; one of the two is likely unclickable`,
          measured: `${Math.round((overlapArea / smaller) * 100)}% overlap`,
          expected: 'no overlap between separate controls',
        });
        break;
      }
    }
  }
  if (overlaps.length > 0) {
    issues.push({
      rule: 'interactive-overlap',
      severity: 'serious',
      title: `${overlaps.length} pair(s) of interactive elements overlap by more than 40%`,
      count: overlaps.length,
      instances: overlaps,
    });
  }

  // ---- 5. Content clipped by a fixed-height container ----------------------
  const clipped: LayoutInstance[] = [];
  let clippedTotal = 0;
  const blocks = document.querySelectorAll<HTMLElement>('body *');
  for (let i = 0; i < blocks.length; i += 1) {
    const el = blocks[i] as HTMLElement;
    if (!isVisible(el)) continue;
    const style = window.getComputedStyle(el);
    if (style.overflow !== 'hidden' && style.overflowY !== 'hidden') continue;
    if (el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 0) {
      const text = (el.textContent ?? '').trim();
      if (text.length > 20) {
        clippedTotal += 1;
        if (clipped.length < maxInstances) {
          clipped.push({
            selector: cssPath(el),
            snippet: outerHtml(el),
            message: `${el.scrollHeight - el.clientHeight}px of content is hidden below the container`,
            measured: `${el.scrollHeight}px of content in a ${el.clientHeight}px box`,
            expected: 'container tall enough for its content',
          });
        }
      }
    }
  }
  if (clippedTotal > 0) {
    issues.push({
      rule: 'content-clipped',
      severity: 'minor',
      title: `${clippedTotal} container(s) clip their own text content with overflow:hidden`,
      count: clippedTotal,
      instances: clipped,
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
          instances: issue.instances.map((instance) => ({
            ...instance,
            ...(instance.snippet ? { snippet: truncate(instance.snippet, 160) } : {}),
          })),
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
    maxInstances: MAX_INSTANCES_PER_RULE,
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
        maxInstances: MAX_INSTANCES_PER_RULE,
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
