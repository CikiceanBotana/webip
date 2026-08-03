/**
 * Guards on the invariants that make a report worth reading.
 *
 * Every assertion here corresponds to a defect that actually shipped and had to
 * be found by hand in the output of a 17-minute scan. They are cheap to keep and
 * expensive to rediscover:
 *
 *   - an adapter that emits only the first occurrence turns 242 broken links
 *     into 62 URLs and a number
 *   - a collapse that drops instance lists does the same thing one layer later
 *   - a truncation flag on an empty instance list claims hidden occurrences
 *     that do not exist
 *   - a tool that fails on every page looks exactly like a clean site
 *
 * Uses node:test, so there is no test framework to install or pin.
 * Run: npm test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classify } from '../src/core/catalog.js';
import { CoverageTracker, assessIntegrity, summariseByTool } from '../src/core/coverage.js';
import { MAX_INSTANCES, collapse, countOccurrences, makeFinding } from '../src/core/finding.js';
import { rollupIssues, scopeFor } from '../src/core/issues.js';
import { fetchPage } from '../src/core/net.js';
import { parseStream } from '../src/core/stream.js';
import type { Finding, FindingInstance, ToolName } from '../src/core/types.js';
import {
  assessCrowding,
  compareNavigation,
  type NavSurvey,
} from '../src/lanes/browser/navigation.js';

function finding(over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({
    site: 'https://a.example',
    url: 'https://a.example/',
    lane: 'http',
    tool: 'semantics',
    rule: 'form-label',
    severity: 'serious',
    title: 'unlabelled control',
    ...over,
  });
}

const inst = (selector: string, extra: FindingInstance = {}): FindingInstance => ({
  selector,
  ...extra,
});

describe('findings keep every occurrence', () => {
  it('retains all instances an adapter emits', () => {
    const f = finding({ instances: [inst('.a'), inst('.b'), inst('.c')] });
    assert.equal(f.instances.length, 3);
    assert.equal(f.count, 3, 'count defaults to the number of occurrences');
  });

  it('deduplicates identical occurrences but keeps ones that only differ by measurement', () => {
    const f = finding({
      instances: [
        inst('.x', { measured: '2.4:1' }),
        inst('.x', { measured: '2.4:1' }), // true duplicate
        inst('.x', { measured: '3.1:1' }), // same generated path, different element
      ],
    });
    assert.equal(f.instances.length, 2, 'a shallow selector must not merge distinct elements');
  });

  it('caps retained instances but never understates the true total', () => {
    const many = Array.from({ length: MAX_INSTANCES + 25 }, (_, i) => inst(`.n${i}`));
    const f = finding({ instances: many });
    assert.equal(f.instances.length, MAX_INSTANCES);
    assert.equal(f.count, MAX_INSTANCES + 25, 'count is the truth, instances are the sample');
    assert.equal(f.instancesTruncated, true);
  });

  it('never claims truncation when there was nothing to pinpoint', () => {
    // Page-level rules ("no meta description", "page returned 404") have no
    // sub-location. Flagging them truncated invents hidden occurrences.
    const f = finding({ rule: 'meta-description', severity: 'minor', title: 'no description' });
    assert.equal(f.instances.length, 0);
    assert.equal(f.instancesTruncated, undefined);
  });
});

describe('collapse merges rather than discards', () => {
  it('unions the occurrence lists of the same rule on the same page', () => {
    const [merged] = collapse([
      finding({ instances: [inst('.a')] }),
      finding({ instances: [inst('.b')] }),
      finding({ instances: [inst('.c')] }),
    ]);
    assert.ok(merged);
    assert.equal(merged.count, 3);
    assert.deepEqual(
      merged.instances.map((i) => i.selector),
      ['.a', '.b', '.c'],
      'losing these is how 180 broken URLs became a number',
    );
  });

  it('keeps rules on different pages apart', () => {
    const rows = collapse([
      finding({ url: 'https://a.example/one', instances: [inst('.a')] }),
      finding({ url: 'https://a.example/two', instances: [inst('.a')] }),
    ]);
    assert.equal(rows.length, 2);
  });

  it('adopts the most severe classification and backfills missing evidence', () => {
    const [merged] = collapse([
      finding({ severity: 'minor', instances: [inst('.a')] }),
      finding({ severity: 'critical', instances: [inst('.b')], evidence: 'shot.png' }),
    ]);
    assert.ok(merged);
    assert.equal(merged.severity, 'critical');
    assert.equal(merged.evidence, 'shot.png');
  });

  it('recomputes the truncation flag after merging', () => {
    const [merged] = collapse([
      finding({ instances: [inst('.a')], count: 100 }),
      finding({ instances: [inst('.b')], count: 1 }),
    ]);
    assert.ok(merged);
    assert.equal(merged.count, 101);
    assert.equal(merged.instancesTruncated, true);
  });

  it('counts occurrences, not rows', () => {
    const rows = collapse([finding({ instances: [inst('.a')], count: 40 })]);
    assert.equal(rows.length, 1);
    assert.equal(countOccurrences(rows), 40);
  });
});

describe('the catalog resolves every rule', () => {
  const tools: ToolName[] = [
    'axe-core',
    'ibm-equal-access',
    'lighthouse',
    'layout',
    'html-validate',
    'nu-validator',
    'lychee',
    'semantics',
    'fetch',
  ];

  it('gives an unknown rule from any tool a category and guidance', () => {
    for (const tool of tools) {
      const info = classify({ tool, rule: 'a-rule-nobody-catalogued' });
      assert.ok(info.category, `${tool} produced no category`);
    }
  });

  it('decodes axe tags into success criteria without a per-rule table', () => {
    const info = classify({
      tool: 'axe-core',
      rule: 'anything',
      tags: ['cat.color', 'wcag2aa', 'wcag143'],
    });
    assert.ok(info.standards?.some((s) => s.includes('1.4.3')));
    assert.ok(info.standards?.some((s) => s.includes('Level AA')));
  });

  it('explains the rules this project invented', () => {
    for (const [tool, rule] of [
      ['fetch', 'head-get-mismatch'],
      ['layout', 'tap-target-too-small'],
      ['semantics', 'form-label'],
      ['lychee', 'broken-link-404'],
    ] as Array<[ToolName, string]>) {
      const info = classify({ tool, rule });
      assert.ok(info.whatIsWrong, `${rule} has no explanation`);
      assert.ok(info.howToFix, `${rule} has no fix`);
    }
  });

  it('carries the explanation onto the finding', () => {
    const f = finding({ tool: 'fetch', rule: 'head-get-mismatch', title: 'HEAD 404 vs GET 200' });
    assert.equal(f.category, 'transport');
    assert.ok(f.remedy?.includes('HEAD'));
  });
});

describe('coverage makes silence unambiguous', () => {
  it('fails the run when a tool failed on everything it attempted', () => {
    const tracker = new CoverageTracker();
    for (const n of [1, 2, 3]) {
      tracker.record(`https://a.example/${n}`, 'https://a.example', 'axe-core', 'error', {
        reason: 'browser died',
      });
    }
    const verdict = assessIntegrity(tracker.list());
    assert.equal(verdict.ok, false, 'a dead tool must not read as a clean site');
    assert.ok(verdict.warnings.some((w) => w.includes('axe-core')));
  });

  it('warns without failing when a tool is only partly broken', () => {
    const tracker = new CoverageTracker();
    for (const n of [1, 2, 3, 4]) {
      const url = `https://a.example/${n}`;
      // Every page is genuinely inspected by the rest of the lane; only
      // Lighthouse is flaky. Without this the page would also be reported as
      // wholly unassessed, which is a different (and equally true) complaint.
      tracker.record(url, 'https://a.example', 'axe-core', 'ok', { findings: 1 });
      tracker.record(url, 'https://a.example', 'lighthouse', n === 4 ? 'error' : 'ok', {
        ...(n === 4 ? { reason: 'timed out' } : { findings: 1 }),
      });
    }
    const verdict = assessIntegrity(tracker.list());
    assert.equal(verdict.ok, true, 'one flaky tool is not a failed run');
    assert.equal(verdict.warnings.length, 1);
    assert.ok(verdict.warnings[0]?.includes('lighthouse'));
  });

  it('reports a page as unassessed when nothing completed on it', () => {
    const tracker = new CoverageTracker();
    tracker.record('https://a.example/', 'https://a.example', 'axe-core', 'error', {
      reason: 'page did not load',
    });
    const verdict = assessIntegrity(tracker.list());
    assert.ok(
      verdict.warnings.some((w) => w.includes('unassessed')),
      'a page where every check died is not a clean page',
    );
  });

  it('does not count a skipped tool as a failure', () => {
    const tracker = new CoverageTracker();
    tracker.skip('https://a.example/', 'https://a.example', ['nu-validator'], 'no Java runtime');
    const verdict = assessIntegrity(tracker.list());
    const stats = summariseByTool(tracker.list());
    assert.equal(stats['nu-validator']?.skipped, 1);
    assert.equal(stats['nu-validator']?.errored, 0);
    // The page still had nothing complete on it, which is worth saying.
    assert.ok(verdict.warnings.some((w) => w.includes('unassessed')));
  });

  it('merges the two lanes without one erasing the other', () => {
    const fast = new CoverageTracker();
    fast.record('https://a.example/', 'https://a.example', 'fetch', 'ok');
    const deep = new CoverageTracker();
    deep.record('https://a.example/', 'https://a.example', 'axe-core', 'ok', { findings: 3 });

    const merged = new CoverageTracker();
    merged.merge(fast.list());
    merged.merge(deep.list());

    const [page] = merged.list();
    assert.equal(merged.list().length, 1, 'one page, not two rows');
    assert.equal(page?.checks.fetch?.status, 'ok');
    assert.equal(page?.checks['axe-core']?.status, 'ok');
  });
});

describe('issues answer "fix once or fix everywhere"', () => {
  it('classifies reach', () => {
    assert.equal(scopeFor(200, 357), 'platform');
    assert.equal(scopeFor(20, 357), 'widespread');
    assert.equal(scopeFor(2, 357), 'tenant');
  });

  it('sums occurrences across sites and prefers unseen shapes as examples', () => {
    const findings = [
      finding({ site: 'https://a.example', url: 'https://a.example/', instances: [inst('.nav')], count: 5 }),
      finding({ site: 'https://b.example', url: 'https://b.example/', instances: [inst('.foot')], count: 2 }),
    ];
    const [issue] = rollupIssues(findings, 2);
    assert.ok(issue);
    assert.equal(issue.sitesAffected, 2);
    assert.equal(issue.occurrences, 7);
    assert.deepEqual(
      issue.examples.map((e) => e.selector),
      ['.nav', '.foot'],
      'identical examples teach nothing on a templated network',
    );
    assert.ok(issue.howToFix.length > 0);
  });
});

describe('a finding keeps what was measured, not just what the rule means', () => {
  it('carries the catalog explanation AND the check\'s own detail', () => {
    const f = finding({
      tool: 'layout',
      rule: 'no-mobile-navigation',
      detail: 'The header offers 4 destination(s) at 1280px and 1 at 390px.',
    });
    assert.match(f.detail ?? '', /media query/, 'the catalog explanation is present');
    assert.match(f.detail ?? '', /4 destination/, 'the measured detail is present');
  });

  it('does not repeat an identical sentence twice', () => {
    const info = classify({ tool: 'layout', rule: 'no-mobile-navigation' });
    const f = finding({
      tool: 'layout',
      rule: 'no-mobile-navigation',
      detail: info.whatIsWrong ?? '',
    });
    assert.equal(f.detail, info.whatIsWrong);
  });
});

describe('a phone viewport that loses the navigation', () => {
  const survey = (hrefs: string[]): NavSurvey => ({
    scope: 'header',
    scopeSnippet: '<header></header>',
    links: hrefs.map((href) => ({ href, text: href })),
    hidden: [],
    toggles: [],
    pageHrefs: hrefs,
  });

  const wide = survey(['/', '/products', '/about', '/blog', '/contact']);

  it('reports a header that collapses to nothing but its own logo', () => {
    const verdict = compareNavigation(wide, survey(['/']));
    assert.equal(verdict.collapsed, true);
    assert.equal(verdict.offered.length, 4, 'the logo is not a destination');
    assert.equal(verdict.lost.length, 4);
  });

  it('reports a header left with a single destination', () => {
    // What the real template does: logo plus a bag icon, three links painted out.
    const verdict = compareNavigation(wide, survey(['/', '/products']));
    assert.equal(verdict.collapsed, true);
    assert.deepEqual(
      verdict.lost.map((l) => l.href),
      ['/about', '/blog', '/contact'],
    );
  });

  it('stays silent when the menu is merely rearranged', () => {
    assert.equal(compareNavigation(wide, survey(['/', '/products', '/about'])).collapsed, false);
    assert.equal(compareNavigation(wide, survey(wide.links.map((l) => l.href))).collapsed, false);
  });

  it('stays silent when one link is dropped, or there was no navigation at all', () => {
    const verdict = compareNavigation(wide, survey(['/', '/products', '/about', '/blog']));
    assert.equal(verdict.collapsed, false, 'one dropped link is a design choice');
    assert.equal(
      compareNavigation(survey(['/', '/only']), survey(['/'])).collapsed,
      false,
      'a one-link header cannot lose its navigation',
    );
  });
});

describe('a navigation that survives a phone viewport without adapting to it', () => {
  /** The real forkstead.sogood.business header, measured at both widths. */
  const row = (
    items: Array<[href: string, text: string, x: number, w: number, lines: number]>,
    hiddenItems: Array<[string, string]> = [],
  ): NavSurvey => ({
    scope: 'header',
    scopeSnippet: '<header></header>',
    links: items.map(([href, text, x, w, lines]) => ({
      href,
      text,
      box: { x, y: 16, w, h: lines * 20 },
      lines,
    })),
    hidden: hiddenItems.map(([href, text]) => ({ href, text })),
    toggles: [],
    pageHrefs: items.map(([href]) => href),
  });

  const wide = row([
    ['/', 'logo', 88, 172, 1],
    ['/services', 'How it works', 811, 81, 1],
    ['/products', 'Our boxes', 916, 66, 1],
    ['/about', 'About', 1006, 38, 1],
    ['/products?cta', 'See our boxes', 1068, 124, 1],
  ]);

  const narrow = row(
    [
      ['/', 'logo', 24, 145, 1],
      ['/services', 'How it works', 169, 61, 2],
      ['/products', 'Our boxes', 254, 50, 2],
      ['/about', 'About', 328, 38, 1],
    ],
    [['/products?cta', 'See our boxes']],
  );

  it('measures the wrapping, the touching pair and the dropped control', () => {
    const report = assessCrowding(wide, narrow);
    assert.equal(report.cramped, true);
    assert.deepEqual(
      report.wrapped.map((w) => w.link.text),
      ['How it works', 'Our boxes'],
    );
    assert.equal(report.touching.length, 1, 'the logo butts straight into the first link');
    assert.equal(report.touching[0]?.gap, 0);
    assert.deepEqual(
      report.dropped.map((d) => d.text),
      ['See our boxes'],
    );
  });

  it('stays silent when the same row simply has more room', () => {
    assert.equal(assessCrowding(wide, wide).cramped, false);
  });

  it('does not count a second row as a touching pair', () => {
    // Links stacked vertically: each starts at x=0, which is not a tiny gap.
    const stacked: NavSurvey = {
      ...narrow,
      links: [
        { href: '/a', text: 'A', box: { x: 0, y: 0, w: 100, h: 20 }, lines: 1 },
        { href: '/b', text: 'B', box: { x: 0, y: 40, w: 100, h: 20 }, lines: 1 },
      ],
      hidden: [],
    };
    assert.equal(assessCrowding(wide, stacked).touching.length, 0);
  });
});

describe('audience says who actually feels it', () => {
  it('routes visual accessibility defects to the sighted visitor, not to assistive tech', () => {
    // A screen reader does not render colour. Filing contrast, focus rings and
    // tap targets under assistive-tech hides them from the one filter --
    // audience: "visitor" -- that a site owner actually uses.
    for (const [tool, rule] of [
      ['contrast', 'contrast-over-image'],
      ['axe-core', 'color-contrast'],
      ['lighthouse', 'color-contrast'],
      ['ibm-equal-access', 'text_contrast_sufficient'],
      ['ibm-equal-access', 'style_color_misuse'],
      ['ibm-equal-access', 'style_focus_visible'],
      ['ibm-equal-access', 'text_sensory_misuse'],
      ['axe-core', 'target-size'],
      ['axe-core', 'meta-viewport'],
    ] as Array<[ToolName, string]>) {
      const f = finding({ tool, rule, category: 'accessibility', title: 'x' });
      assert.equal(f.audience, 'visitor', `${tool}/${rule} was filed away from the person who sees it`);
    }
  });

  it('still routes genuinely screen-reader-only defects to assistive tech', () => {
    for (const [tool, rule] of [
      ['axe-core', 'aria-prohibited-attr'],
      ['ibm-equal-access', 'aria_navigation_label_unique'],
      ['semantics', 'form-label'],
    ] as Array<[ToolName, string]>) {
      const f = finding({ tool, rule, category: 'accessibility', title: 'x' });
      assert.equal(f.audience, 'assistive-tech', `${tool}/${rule} is not a visual defect`);
    }
  });
});

describe('one transport failure is not evidence', () => {
  /** Swaps the global fetch for the duration of one call and counts attempts. */
  async function withFetch<T>(
    impl: (url: string, init: RequestInit) => Promise<Response>,
    body: () => Promise<T>,
  ): Promise<{ result: T | Error; calls: number }> {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls += 1;
      return impl(url, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      return { result: await body(), calls };
    } catch (err) {
      return { result: err as Error, calls };
    } finally {
      globalThis.fetch = original;
    }
  }

  it('retries a reset connection and believes the eventual success', async () => {
    // Six pages of one host were reported `critical: unreachable` on a single
    // failed attempt each. All six answered 200 to curl moments later.
    let attempt = 0;
    const { result, calls } = await withFetch(
      async () => {
        attempt += 1;
        if (attempt < 3) throw new TypeError('fetch failed');
        return new Response('<html><body>fine</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
      () => fetchPage('https://example.test/contact', { attempts: 3 }),
    );

    assert.ok(!(result instanceof Error), 'a transient failure must not become a verdict');
    assert.equal(result.status, 200);
    assert.equal(calls, 3);
  });

  it('does not retry an HTTP status, because a 404 is an answer', async () => {
    const { result, calls } = await withFetch(
      async () => new Response('nope', { status: 404 }),
      () => fetchPage('https://example.test/gone', { attempts: 3 }),
    );

    assert.ok(!(result instanceof Error));
    assert.equal(result.status, 404);
    assert.equal(result.ok, false);
    assert.equal(calls, 1, 'asking again does not make a 404 a different answer');
  });

  it('gives up after the allowed attempts and says how many it made', async () => {
    const { result, calls } = await withFetch(
      async () => {
        throw new TypeError('fetch failed');
      },
      () => fetchPage('https://example.test/down', { attempts: 3 }),
    );

    assert.ok(result instanceof Error);
    assert.match(result.message, /after 3 attempts/);
    assert.equal(calls, 3);
  });

  it('classifies a fetch failure as a scan problem, never as a site defect', () => {
    // No HTTP response was received, so there is no evidence about the site.
    const info = classify({ tool: 'fetch', rule: 'unreachable' });
    assert.equal(info.category, 'scan');
  });
});

describe('the write-ahead log survives being killed', () => {
  it('recovers every complete record and drops the half-written one', () => {
    const f = finding({ instances: [inst('.a')] });
    const full =
      `${JSON.stringify({ type: 'finding', finding: f })}\n` +
      `${JSON.stringify({ type: 'error', message: 'boom' })}\n` +
      `${JSON.stringify({ type: 'finding', finding: f })}`;
    const killed = full.slice(0, full.length - 30); // chop the last record mid-way

    const recovered = parseStream(killed);
    assert.equal(recovered.findings.length, 1);
    assert.equal(recovered.errors.length, 1);
    assert.equal(recovered.findings[0]?.instances[0]?.selector, '.a');
  });
});
