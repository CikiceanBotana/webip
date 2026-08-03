/**
 * The answer layer.
 *
 * `findings` is an evidence archive: every rule, on every page, with every
 * occurrence pinpointed. It is supposed to be large -- four sites of one
 * template at ten pages each produced 770 rows and 3,191 occurrences, and all
 * of it is true. But the person who owns the site opened that file looking for
 * what to fix and could not find it, which means the archive was answering a
 * question nobody asked first.
 *
 * `issues` was meant to be that answer and was not, for three reasons:
 *
 *   1. It ranks a trailing slash on a void element beside "there is no
 *      navigation on a phone", because both are rules that fired.
 *   2. It is keyed by `tool/rule`, so the SAME defect reported by three
 *      engines is three rows. Text contrast alone appeared as
 *      `contrast/contrast-over-image`, `axe-core/color-contrast` and
 *      `ibm-equal-access/text_contrast_sufficient`.
 *   3. It sits below `integrity`, `stats` and 1.9MB of everything else.
 *
 * So this module produces a short list, at the very top of the file, of what a
 * visitor to the site would actually notice -- grouped by WHAT IS WRONG rather
 * than by which engine noticed it. Everything it drops is still in `issues` and
 * `findings`; nothing is lost, it is only ordered.
 */

import { describeLocation, locationScore } from './finding.js';
import type { Finding, Headline, HeadlineWhere, Issue, Severity } from './types.js';

/** Only these reach the headline. `minor` and `info` are real but not news. */
const HEADLINE_SEVERITIES: readonly Severity[] = ['critical', 'serious', 'moderate'];

/** How many to show before saying "and N more". */
export const MAX_HEADLINE = 10;

/**
 * A defect a human would name in one breath, and the rules that all mean it.
 *
 * Grouping by theme rather than by rule is the difference between a list of
 * ten things and a list of thirty. Three engines independently reporting the
 * same faint text is one problem to fix, not three -- and when they disagree
 * slightly (2.43:1 from pixel sampling, 2.45:1 from axe) that agreement is
 * corroboration, not two separate work items.
 *
 * Order matters: the first theme whose pattern matches wins, so put the
 * specific ones above the general ones.
 */
interface Theme {
  id: string;
  /** What to call it in front of a non-specialist. */
  title: string;
  /** Matched against `tool/rule`. */
  pattern: RegExp;
}

const THEMES: readonly Theme[] = [
  {
    id: 'mobile-navigation-missing',
    title: 'There is no way to navigate the site on a phone',
    pattern: /no-mobile-navigation|mobile-navigation-does-not-open/,
  },
  {
    id: 'mobile-navigation-cramped',
    title: 'The phone header is the desktop navigation squeezed to fit',
    pattern: /mobile-navigation-cramped/,
  },
  {
    id: 'text-contrast',
    title: 'Text is too faint to read against what is behind it',
    pattern: /contrast/i,
  },
  {
    id: 'horizontal-overflow',
    title: 'The page scrolls sideways on a phone',
    pattern: /horizontal-overflow|element-overflows-viewport/,
  },
  {
    id: 'content-hidden',
    title: 'Content is cut off or cannot be reached',
    pattern: /content-clipped|control-unclickable|tap-target/,
  },
  {
    id: 'colour-only',
    title: 'Colour or position is the only thing telling the user what to do',
    pattern: /style_color_misuse|use[_-]?of[_-]?colou?r|link-in-text-block|sensory/i,
  },
  {
    id: 'focus-invisible',
    title: 'Keyboard users cannot see what is selected',
    pattern: /focus[_-]?visible|focus[_-]?indicator/i,
  },
  {
    id: 'broken-links',
    title: 'Links lead to pages that do not exist',
    pattern: /broken-link|^lychee\//,
  },
  {
    id: 'branding',
    title: 'The site has no icon in the browser tab',
    pattern: /favicon|apple-touch-icon/,
  },
  {
    id: 'slow',
    title: 'Pages are slow to show their main content',
    pattern: /largest-contentful-paint|first-contentful-paint|category-performance|speed-index|total-blocking/,
  },
];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
  info: 4,
};

function themeFor(key: string): Theme | undefined {
  return THEMES.find((theme) => theme.pattern.test(key));
}

/** Concrete locations shown per headline line. */
const WHERE_SHOWN = 4;

/**
 * Picks the places to look: the most specific occurrences, spread across
 * different pages rather than four from whichever page happened to be first.
 *
 * One example is not enough when a defect spans four sites. The person reading
 * this already knows about the faint stars on one page and is looking for
 * confirmation plus whatever else shares the cause -- so show a handful, from
 * different places, each naming the actual text.
 */
function locate(issues: readonly Issue[]): HeadlineWhere[] {
  const ranked = issues
    .flatMap((issue) => issue.examples)
    .map((sample) => ({ sample, score: locationScore(sample) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen: HeadlineWhere[] = [];
  const seenPages = new Set<string>();

  // Two passes: one location per page first, then fill any remaining slots.
  for (const pass of [1, 2]) {
    for (const { sample } of ranked) {
      if (chosen.length >= WHERE_SHOWN) break;
      if (pass === 1 && seenPages.has(sample.url)) continue;
      seenPages.add(sample.url);

      const what = describeLocation(sample);
      if (chosen.some((c) => c.page === sample.url && c.what === what)) continue;

      chosen.push({
        page: sample.url,
        ...(what ? { what } : {}),
        ...(sample.selector ? { selector: sample.selector } : {}),
        ...(sample.snippet ? { snippet: sample.snippet } : {}),
        ...(sample.measured ? { measured: sample.measured } : {}),
        ...(sample.expected ? { expected: sample.expected } : {}),
      });
    }
  }

  return chosen;
}

/**
 * Reduces the issue list to the handful of things a site owner would recognise.
 *
 * `findings` is passed only to pull one concrete, pinpointed example per theme:
 * a headline that says "text is too faint" and cannot say WHERE is a slogan,
 * not a work item.
 */
export function buildHeadline(
  issues: readonly Issue[],
  findings: readonly Finding[],
): { headline: Headline[]; omitted: number } {
  const eligible = issues.filter(
    (issue) =>
      issue.audience === 'visitor' &&
      HEADLINE_SEVERITIES.includes(issue.severity) &&
      // An engine that could not decide is not evidence of a defect.
      !issue.rule.endsWith('-needs-review'),
  );

  const grouped = new Map<
    string,
    { theme: Theme; issues: Issue[]; severity: Severity; occurrences: number }
  >();

  for (const issue of eligible) {
    const theme = themeFor(`${issue.tool}/${issue.rule}`);
    if (!theme) continue;

    const entry = grouped.get(theme.id);
    if (!entry) {
      grouped.set(theme.id, {
        theme,
        issues: [issue],
        severity: issue.severity,
        occurrences: issue.occurrences,
      });
      continue;
    }
    entry.issues.push(issue);
    entry.occurrences += issue.occurrences;
    if (SEVERITY_RANK[issue.severity] < SEVERITY_RANK[entry.severity]) {
      entry.severity = issue.severity;
    }
  }

  const ranked = [...grouped.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.occurrences - a.occurrences,
  );

  const located = ranked
    .map((entry) => ({ entry, where: locate(entry.issues) }))
    // A line that cannot name one place to look is not a work item. Everything
    // dropped here is still in issues[] and findings[] with its full evidence.
    .filter((candidate) => candidate.where.length > 0);

  const headline: Headline[] = located.slice(0, MAX_HEADLINE).map(({ entry, where }) => {
    const sites = new Set<string>();
    const pages = new Set<string>();
    const rules = new Set<string>();
    for (const issue of entry.issues) {
      rules.add(`${issue.tool}/${issue.rule}`);
      for (const site of issue.sites) sites.add(site);
    }
    for (const finding of findings) {
      if (rules.has(`${finding.tool}/${finding.rule}`)) {
        pages.add(finding.url);
        sites.add(finding.site);
      }
    }

    // The most severe issue in the theme owns the wording of the fix.
    const lead = [...entry.issues].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    )[0] as Issue;

    return {
      title: entry.theme.title,
      severity: entry.severity,
      sitesAffected: sites.size,
      pagesAffected: pages.size,
      occurrences: entry.occurrences,
      howToFix: lead.howToFix,
      /** Every rule folded into this one line, so the detail stays findable. */
      rules: [...rules].sort(),
      where,
    };
  });

  return { headline, omitted: Math.max(0, located.length - headline.length) };
}
