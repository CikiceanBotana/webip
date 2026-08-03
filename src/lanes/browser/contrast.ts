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

/**
 * How much a pixel must change when the glyphs are hidden before it counts as
 * one a glyph was painted on. Summed across R, G and B, so ~8 levels a channel.
 * Below this the two screenshots are the same picture and nothing was drawn.
 */
const GLYPH_MIN_DELTA = 24;

/**
 * Glyphs cover part of a line box, never all of it -- a dense bold heading
 * reaches roughly 40%. Past this the whole box changed, which means the
 * background moved between the screenshots, not that the text is enormous.
 */
const GLYPH_MAX_COVERAGE = 0.85;

/** Sampling budget per line rectangle; larger rects are strided down to fit. */
const MAX_SAMPLES_PER_RECT = 20000;

/** Cap on elements measured per page, worst-first is not knowable up front. */
const MAX_ELEMENTS = 400;

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
}): {
  candidates: Candidate[];
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  capped: boolean;
} {
  const { maxElements } = opts;
  const candidates: Candidate[] = [];
  let eligible = 0;

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

  /** Alpha of any computed colour, exactly, in any colour space. 0 = fully transparent. */
  const alphaOf = (css: string): number => resolveColour(css)?.[3] ?? 0;

  /**
   * Everything on the page that paints something no static engine can reduce to
   * one flat colour: a photo, a gradient, or a translucent fill. Boxes are in
   * document coordinates so text can be tested against what is really behind
   * it. Collected once for the whole document, not once per text node.
   */
  const layers: Array<{ el: Element; x: number; y: number; w: number; h: number; kind: string }> =
    [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const s = window.getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;

    const tag = el.tagName.toUpperCase();
    let kind: string | null = null;
    if (tag === 'IMG' || tag === 'PICTURE' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'SVG') {
      kind = 'an image';
    } else if (s.backgroundImage !== 'none') {
      kind = s.backgroundImage.startsWith('url') ? 'a background image' : 'a gradient';
    } else {
      const a = alphaOf(s.backgroundColor);
      if (a > 0.001 && a < 0.999) kind = 'a translucent tint';
    }
    if (kind === null) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    layers.push({
      el,
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      w: r.width,
      h: r.height,
      kind,
    });
  }

  /**
   * Is this text sitting on something a static engine cannot resolve?
   *
   * Only those are measured. Text in a plain `rgb()` on a plain solid colour is
   * already handled correctly by axe and IBM, and duplicating them would add
   * noise without adding an answer.
   *
   * Three things make a backdrop unresolvable, and the first version of this
   * function only knew about one of them -- the ancestor chain. That misses the
   * single most common hero on the modern web:
   *
   *     <section class="relative isolate">
   *       <div class="absolute inset-0">          <- the photo and its scrim
   *         <img class="object-cover">
   *         <div class="absolute inset-0 bg-gradient-to-b from-neutral/55">
   *       </div>
   *       <div class="mx-auto max-w-3xl">         <- a SIBLING, holding the text
   *         <p class="text-white/90">
   *
   * Walking up from that `<p>` finds nothing but transparent boxes until it
   * reaches `<body>`, which is an opaque cream -- so the old code concluded
   * "solid backdrop, axe already answered this" and skipped it before a single
   * pixel was sampled. axe had NOT answered it; it returned an INCOMPLETE
   * ("background color could not be determined due to a background gradient")
   * for all nine text runs on that page. The one check that can resolve a
   * composited backdrop declined to look, and the defect fell through the gap:
   * a hero paragraph at 1.84:1, and a heading at 1.73:1, on a live site.
   *
   * Over-inclusion here is cheap and safe -- the pixel sampler is the actual
   * judge, and text that turns out to sit on an opaque card simply passes.
   * Under-inclusion is the failure mode, because it is silent.
   */
  const unresolvableBackdrop = (
    el: Element,
    rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
    colourCss: string,
  ): string | null => {
    const reasons: string[] = [];

    // 1. The ancestor chain: the classic case, and the only one that can be
    //    decided without geometry.
    let node: Element | null = el;
    let translucentLayers = 0;
    let ancestorVerdict: string | null = null;
    while (node && node !== document.documentElement) {
      const s = window.getComputedStyle(node);
      if (s.backgroundImage !== 'none') {
        ancestorVerdict = s.backgroundImage.startsWith('url')
          ? 'text sits on a background image'
          : 'text sits on a gradient';
        break;
      }
      const a = alphaOf(s.backgroundColor);
      if (a >= 0.999) break; // reached an opaque solid backdrop
      if (a > 0) translucentLayers += 1;
      node = node.parentElement;
    }
    if (ancestorVerdict !== null) reasons.push(ancestorVerdict);
    else if (translucentLayers > 0) reasons.push('text sits on stacked translucent layers');

    // 2. Anything painted behind it that is NOT an ancestor.
    const behind = new Set<string>();
    for (const layer of layers) {
      if (layer.el.contains(el)) continue; // an ancestor: already judged above
      if (el.contains(layer.el)) continue; // inside the text: in front, not behind
      for (const r of rects) {
        if (
          layer.x < r.x + r.w &&
          layer.x + layer.w > r.x &&
          layer.y < r.y + r.h &&
          layer.y + layer.h > r.y
        ) {
          behind.add(layer.kind);
          break;
        }
      }
    }
    if (behind.size > 0) {
      const list = [...behind];
      const tail = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0];
      reasons.push(`${tail} sits behind it, painted by an element that is not its ancestor`);
    }

    // 3. A colour the other engines cannot read. Tailwind 4 emits `oklab()`,
    //    which no contrast engine parses, so even a solid backdrop leaves the
    //    question open when the text colour is written this way.
    if (!/^rgba?\(/.test(colourCss.trim())) {
      reasons.push(`the text colour is written as ${colourCss.split('(')[0]}(), which the other engines do not parse`);
    }

    return reasons.length > 0 ? reasons.join('; ') : null;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let index = 0;

  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    const value = (current.nodeValue ?? '').trim();
    const parent = current.parentElement;

    /**
     * Anything that paints a glyph is measured, including a run of exactly one
     * character.
     *
     * This used to skip text shorter than two characters, on the theory that a
     * lone glyph is stray noise. That assumption hid a real defect: a
     * testimonial rating built as five separate `<span>*</span>` elements, one
     * character each, sitting at 1.20:1 on a green panel. Invisible on the
     * page, and discarded here before a single pixel was sampled, purely for
     * being one character long.
     *
     * The symbols that carry the most meaning per glyph are exactly the ones
     * written this way -- star ratings, tick marks, close crosses, arrows,
     * currency signs, icon-font glyphs -- and they are also the ones a designer
     * colours by eye and never measures. Runs that paint nothing are still
     * skipped, but by whether they occupy area, which is asked further down
     * where the line rectangles are collected.
     */
    if (!parent || value === '') continue;
    const tag = parent.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TITLE') continue;
    if (parent.getAttribute('aria-hidden') === 'true') continue;

    const style = window.getComputedStyle(parent);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number(style.opacity) === 0) continue;

    const colour = resolveColour(style.color);
    if (!colour) continue;

    // Per-line rects, so we sample where glyphs actually are rather than across
    // a padded block box. Computed BEFORE the backdrop question is asked,
    // because "what is painted behind this text" is answered geometrically and
    // there is nothing to test against until the lines have positions.
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

    const reason = unresolvableBackdrop(parent, rects, style.color);
    if (reason === null) continue; // solid backdrop, plain colour: axe answered this

    const fontSize = parseFloat(style.fontSize) || 16;
    const weight = parseInt(style.fontWeight, 10) || 400;

    // Counted before the cap is applied, so the report can say how much text it
    // did NOT look at. A silent cap reads exactly like a clean page.
    eligible += 1;
    if (candidates.length >= maxElements) continue;

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
    capped: eligible > candidates.length,
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

/**
 * In-page: find where each candidate's glyphs are ACTUALLY painted, and sample
 * the background only there.
 *
 * A text node having a rectangle does not mean anything is drawn in it, and
 * this check spent a version believing that it did. The control group found
 * three separate ways for the belief to be wrong, none of which is visible in
 * the computed style of the text's own element:
 *
 *   - stripe.com had "Sign in" inside `<svg><defs><mask><text>`. Text in a
 *     `<defs>`, `<mask>`, `<clipPath>` or `<symbol>` has a layout box and is
 *     never painted -- it is a stencil for something else.
 *   - stripe.com had a product card translated out of a carousel whose
 *     `overflow: hidden` ancestor ends 370px to its left. Clipped away, still
 *     fully laid out.
 *   - tailwindcss.com had ghost frames of its hero typing animation, and a
 *     `<span>` at `opacity: 0` that exists only to measure a width. `opacity`
 *     does not inherit as a computed value, so an ancestor at 0 leaves the
 *     text's own style reading `opacity: 1`.
 *
 * Enumerating those cases in CSS is a losing game; every one of them was found
 * by a stranger's page doing something reasonable that the rule had not
 * imagined. So do not enumerate: ask the compositor. Screenshot the page once
 * normally and once with the glyphs made transparent. Pixels that CHANGED are
 * exactly the pixels where a glyph was painted, whatever the reason it was or
 * was not drawn. Where nothing changed, nothing is painted, and there is no
 * contrast question to answer.
 *
 * The mask also makes the measurement itself sharper: the background is now
 * sampled under the strokes rather than across the whole line box, so the
 * leading above and below a line can no longer supply a comfortable pixel that
 * a glyph never actually sat on.
 *
 * Text painted in EXACTLY its own background colour produces no change and is
 * therefore skipped. That is deliberate: invisible-on-solid is the one contrast
 * case static analysis handles perfectly, so axe and IBM already own it. This
 * check exists for backdrops they cannot resolve.
 */
async function measureAgainst(input: {
  hiddenUrl: string;
  shownUrl: string;
  candidates: Candidate[];
  viewportWidth: number;
  minDelta: number;
  maxCoverage: number;
  maxSamples: number;
}): Promise<Measured[]> {
  const { hiddenUrl, shownUrl, candidates, viewportWidth, minDelta, maxCoverage, maxSamples } =
    input;

  const load = async (src: string): Promise<HTMLImageElement> => {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  };
  const [hidden, shown] = await Promise.all([load(hiddenUrl), load(shownUrl)]);

  // One small scratch canvas, resized per rect, instead of two full-page
  // canvases. A 1280x14600 page would otherwise cost ~150MB of bitmap in a
  // worker budgeted at ~300MB.
  const scratch = document.createElement('canvas');
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  // The screenshot may be captured at a different device scale than CSS pixels.
  const scale = hidden.naturalWidth / viewportWidth;

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
      const w = Math.min(hidden.naturalWidth - x0, Math.ceil(rect.w * scale));
      const h = Math.min(hidden.naturalHeight - y0, Math.ceil(rect.h * scale));
      if (w <= 0 || h <= 0) continue;

      scratch.width = w;
      scratch.height = h;
      ctx.drawImage(hidden, x0, y0, w, h, 0, 0, w, h);
      const back = ctx.getImageData(0, 0, w, h).data;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(shown, x0, y0, w, h, 0, 0, w, h);
      const front = ctx.getImageData(0, 0, w, h).data;

      const stride = Math.max(1, Math.ceil(Math.sqrt((w * h) / maxSamples)));
      const delta = (i: number): number =>
        Math.abs((front[i] ?? 0) - (back[i] ?? 0)) +
        Math.abs((front[i + 1] ?? 0) - (back[i + 1] ?? 0)) +
        Math.abs((front[i + 2] ?? 0) - (back[i + 2] ?? 0));

      // Pass 1: how strongly did hiding the glyphs change this box at all?
      let peak = 0;
      for (let y = 0; y < h; y += stride) {
        for (let x = 0; x < w; x += stride) {
          const d = delta((y * w + x) * 4);
          if (d > peak) peak = d;
        }
      }
      if (peak < minDelta) continue; // nothing is painted here

      // Pass 2: measure at the glyph core only. Half of peak keeps the strokes
      // and drops the antialiased edges, which blend toward the background and
      // would drag every ratio toward 1:1.
      const cut = Math.max(minDelta, peak * 0.5);
      let visited = 0;
      let hits = 0;
      let rectWorst = Infinity;
      let rectBg = '';
      let rectFg = '';

      for (let y = 0; y < h; y += stride) {
        for (let x = 0; x < w; x += stride) {
          const i = (y * w + x) * 4;
          visited += 1;
          if (delta(i) < cut) continue;
          hits += 1;

          const br = back[i] ?? 0;
          const bg = back[i + 1] ?? 0;
          const bb = back[i + 2] ?? 0;

          // The text is semi-transparent, so what the eye sees is the text
          // composited ONTO this exact pixel. Compute that, then compare it
          // with the pixel it sits on. Taken from the declared colour rather
          // than from the screenshot, because a sampled glyph pixel carries
          // the antialiasing with it.
          const fr = ta * tr + (1 - ta) * br;
          const fg2 = ta * tg + (1 - ta) * bg;
          const fb = ta * tb + (1 - ta) * bb;

          const ratio = contrast(luminance(fr, fg2, fb), luminance(br, bg, bb));
          if (ratio < rectWorst) {
            rectWorst = ratio;
            rectBg = `rgb(${br}, ${bg}, ${bb})`;
            rectFg = `rgb(${Math.round(fr)}, ${Math.round(fg2)}, ${Math.round(fb)})`;
          }
        }
      }

      // Glyphs cover part of a line box, never all of it. If nearly every pixel
      // changed, the BACKGROUND moved between the two screenshots -- a canvas
      // animation, a video, a JS-driven gradient -- and the mask means nothing.
      // Say nothing rather than something unfounded.
      if (hits === 0 || hits > visited * maxCoverage) continue;

      samples += hits;
      if (rectWorst < worst) {
        worst = rectWorst;
        worstBg = rectBg;
        worstFg = rectFg;
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

  const collected = await page.evaluate(collectCandidates, { maxElements: MAX_ELEMENTS });

  if (collected.candidates.length === 0) return [];

  // Two captures of the same page, identical but for the glyphs. Animations are
  // frozen for both, so the only thing that may differ is the text -- which is
  // the whole basis of the mask that follows.
  const shown = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' });
  await page.evaluate(hideGlyphs);
  let hiddenShot: Buffer;
  try {
    hiddenShot = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' });
  } finally {
    await page.evaluate(showGlyphs);
  }

  const measured = await page.evaluate(measureAgainst, {
    hiddenUrl: `data:image/png;base64,${hiddenShot.toString('base64')}`,
    shownUrl: `data:image/png;base64,${shown.toString('base64')}`,
    candidates: collected.candidates,
    viewportWidth: collected.viewportWidth,
    minDelta: GLYPH_MIN_DELTA,
    maxCoverage: GLYPH_MAX_COVERAGE,
    maxSamples: MAX_SAMPLES_PER_RECT,
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

    /**
     * Where on the page, in document coordinates.
     *
     * Not decoration. Fifteen identical star glyphs in three testimonial cards
     * generate the same short CSS path, the same snippet and the same measured
     * ratio, so the deduper -- correctly, on the information it had -- merged
     * all fifteen into one row. The count stayed truthful and every location
     * but one was lost. The position is what makes two genuinely different
     * elements different, and it is also the only answer this check can give to
     * "where do I look" when a page repeats one component down the page.
     */
    const first = candidate.rects[0];
    const at = first ? ` at ${Math.round(first.x)},${Math.round(first.y)} on the page` : '';

    failures.push({
      selector: candidate.selector,
      snippet: candidate.snippet,
      message: `"${candidate.text}"${at} - ${candidate.reason}; measured against the rendered pixels at its worst point`,
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
        'These are the elements the other engines could not judge: the text is semi-transparent, or sits on a gradient, a photo, or a stack of translucent layers, so its real colour only exists once the page is composited. Note that the layer behind the text is often not one of its ancestors -- in the usual hero the photo and its scrim are absolutely-positioned siblings of the text container -- so the answer cannot be read off the markup at all. Measured here by hiding the glyphs, screenshotting the page, and sampling the actual pixels behind each line of text.' +
        (collected.capped
          ? ` Only the first ${MAX_ELEMENTS} eligible text runs on this page were measured, so there may be more below this list.`
          : ''),
      remedy:
        'Raise the text opacity, darken or lighten the layer behind it, or place a solid backing behind the text. Check the worst point reported, not the average -- a scrim over a photo is only as good as its lightest region under light text, and the same sentence can measure 16:1 where the photo is dark and 1.8:1 forty pixels to the right.',
      standards: ['WCAG SC 1.4.3 Contrast (Minimum)'],
      instances: failures,
      count: failures.length,
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html',
      ...(evidence ? { evidence } : {}),
    }),
  ];
}
