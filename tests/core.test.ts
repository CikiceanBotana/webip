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
import { parseStream } from '../src/core/stream.js';
import type { Finding, FindingInstance, ToolName } from '../src/core/types.js';

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
