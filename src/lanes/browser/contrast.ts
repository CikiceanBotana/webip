/**
 * Measured contrast over gradients, images and translucency.
 *
 * This exists because the other three engines give up here. axe reports
 * "Element's background color could not be determined due to a background
 * gradient" and returns an INCOMPLETE result; IBM says "verify the contrast
 * against the lightest and darkest colors of the background". Both are honest
 * -- neither can resolve it statically -- but on a site built entirely on
 * gradients that means the contrast question goes unanswered everywhere it
 * actually matters. On one 8-page site, 429 checks came back undecided.
 *
 * Static analysis fails for three compounding reasons:
 *
 *   1. Tailwind 4 emits colours in `oklab()`, which contrast engines do not parse.
 *   2. Text is semi-transparent (`text-white/65`), so its rendered colour depends
 *      on whatever is behind it.
 *   3. The backdrop is a STACK -- a translucent white veil, over a gradient, over
 *      a photograph -- and no single element owns the resulting colour.
 *
 * So do not analyse: render, then look. Hide the glyphs, screenshot the page,
 * and sample the pixels where the text was. That answers all three at once,
 * because the compositor has already done the work. The result is a real
 * measured ratio, at the worst point behind the text, for backgrounds that
 * cannot be reasoned about any other way.
 */

import type { Page } from 'playwright';

import { makeFinding } from '../../core/finding.js';
import type { Finding, FindingInstance, PageTarget, Severity } from '../../core/types.js';

import { ensureNameShim } from './shim.js';

/** WCAG AA: normal text needs 4.5:1, large text 3:1. */
const AA_NORMAL = 4.5;
const AA_LARGE = 3;

/** Large text is >=24px, or >=18.66px when bold. */
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;

/** Sample step in CSS pixels across each text line. Finer costs time, not accuracy. */
const SAMPLE_STEP = 3;

/** Cap on elements measured per page, worst-first is not knowable up front. */
const MAX_ELEMENTS = 400;

/** Skip runs of text shorter than this; single stray characters are noise. */
const MIN_TEXT_LENGTH = 2;

interface Candidate {
  index: number;
  text: string;
  selector: string;
  snippet: string;
  /** Text colour as [r,g,b,a] in sRGB, already decomposed from any colour space. */
  colour: [number, number, number, number];
  fontSize: number;
  bold: boolean;
  /** One rect per rendered line, in document coordinates. */
  rects: Array<{ x: number; y: number; w: number; h: number }>;
  /** Why static analysis could not answer this one. */
  reason: string;
}

interface Measured {
  index: number;
  /** Worst (lowest) contrast ratio found behind the text. */
  ratio: number;
  /** The background colour at that worst point. */
  bg: string;
  /** The text colour as actually composited there. */
  fg: string;
  samples: number;
}

/**
 * In-page: find text whose background cannot be resolved statically, decompose
 * its colour to sRGB, and record where every line of it sits.
 */
function collectCandidates(opts: {
  maxElements: number;
  minTextLength: number;
}): { candidates: Candidate[]; scrollX: number; scrollY: number; viewportWidth: number } {
  const { maxElements, minTextLength } = opts;
  const candidates: Candidate[] = [];

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

  /**
   * Resolves ANY CSS colour -- oklab, lab, colour-mix, named, hsl -- to sRGB
   * with a separated alpha, by asking the compositor instead of parsing.
   *
   * Painting the colour once over white and once over black gives two
   * composites; alpha and the pure channel values fall straight out of the
   * pair. This is exact, and it is why oklab costs nothing here.
   */
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  const resolveColour = (css: string): [number, number, number, number] | null => {
    if (!probeCtx) return null;
    const read = (backdrop: string): [number, number, number] => {
      probeCtx.clearRect(0, 0, 1, 1);
      probeCtx.fillStyle = backdrop;
      probeCtx.fillRect(0, 0, 1, 1);
      probeCtx.fillStyle = css;
      probeCtx.fillRect(0, 0, 1, 1);
      const d = probeCtx.getImageData(0, 0, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
    };
    const overWhite = read('#ffffff');
    const overBlack = read('#000000');
    // Cw - Cb = (1 - a) * 255  ->  a = 1 - (Cw - Cb)/255
    const alpha = 1 - ((overWhite[0] - overBlack[0]) / 255);
    if (!Number.isFinite(alpha) || alpha <= 0.001) return null;
    // Cb = a * C  ->  C = Cb / a
    return [
      Math.min(255, overBlack[0] / alpha),
      Math.min(255, overBlack[1] / alpha),
      Math.min(255, overBlack[2] / alpha),
      Math.min(1, alpha),
    ];
  };

  /**
   * Is this text sitting on something a static engine cannot resolve?
   *
   * Only those are measured. Text on a plain solid colour is already handled
   * correctly by axe and IBM, and duplicating them would add noise without
   * adding an answer.
   */
  const unresolvableBackdrop = (el: Element): string | null => {
    let node: Element | null = el;
    let translucentLayers = 0;
    while (node && node !== document.documentElement) {
      const s = window.getComputedStyle(node);
      if (s.backgroundImage !== 'none') {
        return s.backgroundImage.startsWith('url')
          ? 'text sits on a background image'
          : 'text sits on a gradient';
      }
      const bg = s.backgroundColor;
      const match = /rgba?\(([^)]+)\)/.exec(bg);
      if (match?.[1]) {
        const parts = match[1].split(',').map((v) => parseFloat(v));
        const a = parts.length > 3 ? (parts[3] ?? 1) : 1;
        if (a >= 0.999) {
          // Reached an opaque solid backdrop.
          return translucentLayers > 0 ? 'text sits on stacked translucent layers' : null;
        }
        if (a > 0) translucentLayers += 1;
      } else if (bg !== 'transparent' && !bg.startsWith('rgba(0, 0, 0, 0)')) {
        // A colour in a space the regex does not cover (oklab, lab, color()).
        translucentLayers += 1;
      }
      node = node.parentElement;
    }
    return translucentLayers > 0 ? 'text sits on stacked translucent layers' : null;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let index = 0;

  for (
    let current = walker.nextNode();
    current !== null && candidates.length < maxElements;
    current = walker.nextNode()
  ) {
    const value = (current.nodeValue ?? '').trim();
    const parent = current.parentElement;

    if (!parent || value.length < minTextLength) continue;
    const tag = parent.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TITLE') continue;
    if (parent.getAttribute('aria-hidden') === 'true') continue;

    const style = window.getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number(style.opacity) === 0) continue;

    const reason = unresolvableBackdrop(parent);
    if (reason === null) continue; // solid backdrop: axe already answered this

    const colour = resolveColour(style.color);
    if (!colour) continue;

    // Per-line rects, so we sample where glyphs actually are rather than across
    // a padded block box.
    const range = document.createRange();
    range.selectNodeContents(current);
    const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      rects.push({
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        w: r.width,
        h: r.height,
      });
    }
    if (rects.length === 0) continue;

    const fontSize = parseFloat(style.fontSize) || 16;
    const weight = parseInt(style.fontWeight, 10) || 400;

    candidates.push({
      index: index++,
      text: value.slice(0, 80),
      selector: cssPath(parent),
      snippet: parent.outerHTML.slice(0, 160),
      colour,
      fontSize,
      bold: weight >= 700,
      rects,
      reason,
    });
  }

  return {
    candidates,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth: window.innerWidth,
  };
}

/** In-page: hide glyphs without disturbing layout or backgrounds. */
function hideGlyphs(): void {
  const style = document.createElement('style');
  style.id = '__webip_hide_text';
  // Colour only -- not visibility -- so every box, background and gradient
  // stays exactly where it was. Only the glyphs stop being painted.
  style.textContent =
    '*, *::before, *::after { color: transparent !important; ' +
    '-webkit-text-fill-color: transparent !important; text-shadow: none !important; }';
  document.head.appendChild(style);
}

function showGlyphs(): void {
  document.getElementById('__webip_hide_text')?.remove();
}

/** In-page: sample the screenshot behind each candidate and find the worst ratio. */
async function measureAgainst(input: {
  dataUrl: string;
  candidates: Candidate[];
  viewportWidth: number;
  step: number;
}): Promise<Measured[]> {
  const { dataUrl, candidates, viewportWidth, step } = input;

  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0);

  // The screenshot may be captured at a different device scale than CSS pixels.
  const scale = img.naturalWidth / viewportWidth;

  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = (r: number, g: number, b: number): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (l1: number, l2: number): number =>
    (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

  const results: Measured[] = [];

  for (const candidate of candidates) {
    const [tr, tg, tb, ta] = candidate.colour;
    let worst = Infinity;
    let worstBg = '';
    let worstFg = '';
    let samples = 0;

    for (const rect of candidate.rects) {
      const x0 = Math.max(0, Math.floor(rect.x * scale));
      const y0 = Math.max(0, Math.floor(rect.y * scale));
      const w = Math.min(canvas.width - x0, Math.ceil(rect.w * scale));
      const h = Math.min(canvas.height - y0, Math.ceil(rect.h * scale));
      if (w <= 0 || h <= 0) continue;

      const data = ctx.getImageData(x0, y0, w, h).data;
      const stride = Math.max(1, Math.round(step * scale));

      for (let y = 0; y < h; y += stride) {
        for (let x = 0; x < w; x += stride) {
          const i = (y * w + x) * 4;
          const br = data[i] ?? 0;
          const bg = data[i + 1] ?? 0;
          const bb = data[i + 2] ?? 0;

          // The text is semi-transparent, so what the eye sees is the text
          // composited ONTO this exact pixel. Compute that, then compare it
          // with the pixel it sits on.
          const fr = ta * tr + (1 - ta) * br;
          const fg2 = ta * tg + (1 - ta) * bg;
          const fb = ta * tb + (1 - ta) * bb;

          const ratio = contrast(luminance(fr, fg2, fb), luminance(br, bg, bb));
          samples += 1;
          if (ratio < worst) {
            worst = ratio;
            worstBg = `rgb(${br}, ${bg}, ${bb})`;
            worstFg = `rgb(${Math.round(fr)}, ${Math.round(fg2)}, ${Math.round(fb)})`;
          }
        }
      }
    }

    if (samples > 0 && Number.isFinite(worst)) {
      results.push({ index: candidate.index, ratio: worst, bg: worstBg, fg: worstFg, samples });
    }
  }

  return results;
}

function severityForShortfall(ratio: number, required: number): Severity {
  const shortfall = required - ratio;
  if (shortfall >= 2) return 'serious';
  if (shortfall >= 1) return 'moderate';
  return 'minor';
}

/**
 * Measures every piece of text whose background cannot be resolved statically.
 * Never throws; a failure here must not cost the page its other checks.
 */
export async function checkContrast(
  target: PageTarget,
  page: Page,
  evidence?: string,
): Promise<Finding[]> {
  await ensureNameShim(page);

  const collected = await page.evaluate(collectCandidates, {
    maxElements: MAX_ELEMENTS,
    minTextLength: MIN_TEXT_LENGTH,
  });

  if (collected.candidates.length === 0) return [];

  // Hide glyphs, capture the page as the compositor drew it, restore.
  await page.evaluate(hideGlyphs);
  let shot: Buffer;
  try {
    shot = await page.screenshot({ fullPage: true, type: 'png' });
  } finally {
    await page.evaluate(showGlyphs);
  }

  const measured = await page.evaluate(measureAgainst, {
    dataUrl: `data:image/png;base64,${shot.toString('base64')}`,
    candidates: collected.candidates,
    viewportWidth: collected.viewportWidth,
    step: SAMPLE_STEP,
  });

  const byIndex = new Map(collected.candidates.map((c) => [c.index, c]));
  const failures: FindingInstance[] = [];
  let worstRatio = Infinity;
  let reason = 'text sits on a gradient';

  for (const result of measured) {
    const candidate = byIndex.get(result.index);
    if (!candidate) continue;

    const large =
      candidate.fontSize >= LARGE_PX || (candidate.bold && candidate.fontSize >= LARGE_BOLD_PX);
    const required = large ? AA_LARGE : AA_NORMAL;
    if (result.ratio >= required) continue;

    if (result.ratio < worstRatio) {
      worstRatio = result.ratio;
      reason = candidate.reason;
    }

    failures.push({
      selector: candidate.selector,
      snippet: candidate.snippet,
      message: `"${candidate.text}" - ${candidate.reason}; measured against the rendered pixels at its worst point`,
      measured: `${result.ratio.toFixed(2)}:1 (${result.fg} on ${result.bg}, ${Math.round(candidate.fontSize)}px${candidate.bold ? ' bold' : ''})`,
      expected: `${required}:1`,
    });
  }

  if (failures.length === 0) return [];

  return [
    makeFinding({
      site: target.site,
      url: target.url,
      lane: 'browser',
      tool: 'contrast',
      rule: 'contrast-over-image',
      category: 'accessibility',
      severity: severityForShortfall(worstRatio, AA_NORMAL),
      title: `${failures.length} text element(s) fail contrast against their rendered background (worst ${worstRatio.toFixed(2)}:1 - ${reason})`,
      detail:
        'These are the elements the other engines could not judge: the text is semi-transparent, or sits on a gradient, image or stack of translucent layers, so its real colour only exists once the page is composited. Measured here by hiding the glyphs, screenshotting the page, and sampling the actual pixels behind each line of text.',
      remedy:
        'Raise the text opacity, darken or lighten the layer behind it, or place a solid backing behind the text. Check the worst point reported, not the average -- a gradient is only as good as its lightest region under light text.',
      standards: ['WCAG SC 1.4.3 Contrast (Minimum)'],
      instances: failures,
      count: failures.length,
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
      ...(evidence ? { evidence } : {}),
    }),
  ];
}
