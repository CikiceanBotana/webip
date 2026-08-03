/**
 * Finding construction, collapsing and summarising.
 *
 * Adapters never build a Finding literal by hand -- they call `makeFinding`,
 * which computes the stable id. That id is a content hash, so the same issue
 * gets the same id on every run, which is what makes run-to-run comparison and
 * "is this new?" possible later without any image diffing.
 */

import { createHash } from 'node:crypto';

import { audienceFor, classify } from './catalog.js';
import {
  SEVERITIES,
  type Audience,
  type Category,
  type Finding,
  type FindingInstance,
  type LaneName,
  type Severity,
  type ToolName,
} from './types.js';

/**
 * How many concrete occurrences to retain per finding.
 *
 * A page can carry hundreds of instances of one rule. Keeping every one turns
 * the report into a memory problem; keeping only the first turns it back into
 * the statistic this whole design exists to avoid. Fifty is enough to fix from,
 * and `count` always carries the true total so nothing is silently understated.
 */
export const MAX_INSTANCES = 50;

export interface FindingInput {
  site: string;
  url: string;
  lane: LaneName;
  tool: ToolName;
  rule: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** Every occurrence, pinpointed. Adapters must pass all of them. */
  instances?: FindingInstance[];
  evidence?: string;
  helpUrl?: string;
  /** True total occurrences. Defaults to the instance count. */
  count?: number;
  /** axe rule tags, used to decode the WCAG criteria the rule implements. */
  tags?: readonly string[];
  /** Lighthouse category id, used to classify the audit. */
  lighthouseCategory?: string;
  /** Overrides for the catalog lookup. */
  category?: Category;
  audience?: Audience;
  remedy?: string;
  standards?: string[];
}

/**
 * Identity of one occurrence, used to dedupe when merging.
 *
 * Includes the measurement and the message, not just the position: a generated
 * selector is only a few levels deep, so two genuinely different elements can
 * share one path. Keying on what was observed as well as where keeps them
 * apart, and the cost of being wrong in this direction is a duplicate row
 * rather than a silently dropped defect.
 */
function instanceKey(instance: FindingInstance): string {
  return [
    instance.selector ?? '',
    instance.line ?? '',
    instance.column ?? '',
    instance.target ?? '',
    instance.snippet ?? '',
    instance.measured ?? '',
    instance.message ?? '',
  ].join('|');
}

/** Drops duplicate occurrences while preserving order. */
export function dedupeInstances(instances: readonly FindingInstance[]): FindingInstance[] {
  const seen = new Set<string>();
  const out: FindingInstance[] = [];
  for (const instance of instances) {
    const key = instanceKey(instance);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(instance);
  }
  return out;
}

/** Keeps report output readable when a tool hands back a whole DOM subtree. */
export function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function makeFinding(input: FindingInput): Finding {
  const instances = dedupeInstances(input.instances ?? []);
  const first = instances[0];

  const fingerprint = [
    input.url,
    input.tool,
    input.rule,
    first?.selector ?? '',
    first?.line ?? '',
    first?.column ?? '',
    input.title,
  ].join('\u0000');

  const info = classify({
    tool: input.tool,
    rule: input.rule,
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.lighthouseCategory !== undefined
      ? { lighthouseCategory: input.lighthouseCategory }
      : {}),
  });

  /**
   * The catalog explains what the RULE means. A check may additionally report
   * what it measured on THIS page. Both are kept, in that order.
   *
   * The catalog used to win outright, which quietly deleted the only per-page
   * reasoning a finding carried: the mobile-navigation check computes how many
   * destinations the header offers at each width, whether a menu button was
   * found and clicked, and whether the lost links survive in the footer -- and
   * all of it was replaced by the generic paragraph. A reader needs the second
   * sentence more than the first.
   */
  const parts = [info.whatIsWrong, input.detail].filter(
    (part): part is string => part !== undefined && part.trim() !== '',
  );
  const detail = parts.length > 0 ? [...new Set(parts)].join(' ') : undefined;
  const remedy = input.remedy ?? info.howToFix;
  const standards = input.standards ?? info.standards;
  const count = Math.max(input.count ?? instances.length, 1);
  const kept = instances.slice(0, MAX_INSTANCES);

  const category = input.category ?? info.category;
  const audience = input.audience ?? info.audience ?? audienceFor(input.tool, input.rule, category);

  /**
   * Severity means "how much is a human affected", so a rule that affects no
   * human cannot outrank one that does. Developer-only spec deviations are
   * capped at info: still reported, still counted, never at the top of the
   * list ahead of a dead link. Before this, one sweep ranked 13,858 harmless
   * trailing slashes above 170 broken URLs.
   */
  const severity: Severity =
    audience === 'developer' && severityRank(input.severity) < severityRank('info')
      ? 'info'
      : input.severity;

  return {
    id: createHash('sha1').update(fingerprint).digest('hex').slice(0, 16),
    site: input.site,
    url: input.url,
    lane: input.lane,
    tool: input.tool,
    rule: input.rule,
    category,
    audience,
    severity,
    title: input.title,
    ...(detail !== undefined ? { detail } : {}),
    ...(remedy !== undefined ? { remedy } : {}),
    ...(standards !== undefined && standards.length > 0 ? { standards } : {}),
    instances: kept,
    // Only meaningful when occurrences were actually dropped. A page-level rule
    // ("no meta description", "page returned 404") legitimately has nothing to
    // pinpoint below the URL, and flagging it as truncated would claim hidden
    // occurrences that do not exist.
    ...(kept.length > 0 && count > kept.length ? { instancesTruncated: true } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.helpUrl !== undefined ? { helpUrl: input.helpUrl } : {}),
    count,
  };
}

const SEVERITY_RANK = new Map<Severity, number>(SEVERITIES.map((s, i) => [s, i]));

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK.get(severity) ?? SEVERITIES.length;
}

/**
 * Maps the impact vocabularies used by axe-core and IBM equal-access onto our
 * scale. Shared here rather than duplicated in each adapter.
 */
export function severityFromImpact(impact: string | null | undefined): Severity {
  switch ((impact ?? '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'serious':
      return 'serious';
    case 'moderate':
      return 'moderate';
    case 'minor':
      return 'minor';
    default:
      return 'moderate';
  }
}

/**
 * Collapses repeats of the same rule on the same page into one row carrying a
 * count.
 *
 * Without this a single page with 60 unlabelled images produces 60 identical
 * rows and drowns out everything else.
 *
 * It MERGES the occurrence lists rather than keeping the first and discarding
 * the rest. An earlier version summed counts and kept one location, which
 * turned 242 broken links into 62 rows naming 62 URLs -- the other 180 existed
 * in the report only as a number. A count is not a defect report. Every
 * occurrence kept here is one a developer can go and fix.
 */
export function collapse(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, Finding>();

  for (const finding of findings) {
    const key = `${finding.url}\u0000${finding.tool}\u0000${finding.rule}`;
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, { ...finding, instances: [...finding.instances] });
      continue;
    }

    existing.count += finding.count;
    existing.instances = dedupeInstances([
      ...existing.instances,
      ...finding.instances,
    ]).slice(0, MAX_INSTANCES);

    // Keep the most severe classification seen for this rule on this page.
    if (severityRank(finding.severity) < severityRank(existing.severity)) {
      existing.severity = finding.severity;
    }
    // A later occurrence may carry evidence or docs the first one lacked.
    if (existing.evidence === undefined && finding.evidence !== undefined) {
      existing.evidence = finding.evidence;
    }
    if (existing.helpUrl === undefined && finding.helpUrl !== undefined) {
      existing.helpUrl = finding.helpUrl;
    }
  }

  for (const finding of groups.values()) {
    if (finding.instances.length > 0 && finding.count > finding.instances.length) {
      finding.instancesTruncated = true;
    } else {
      delete finding.instancesTruncated;
    }
  }

  return [...groups.values()];
}

/** Most severe first, then widest blast radius, then stable by url/rule. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.count - a.count ||
      a.site.localeCompare(b.site) ||
      a.url.localeCompare(b.url) ||
      a.rule.localeCompare(b.rule),
  );
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) out[f.severity] += 1;
  return out;
}

export function countByTool(findings: readonly Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.tool] = (out[f.tool] ?? 0) + 1;
  return out;
}

export function countByCategory(findings: readonly Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.category] = (out[f.category] ?? 0) + 1;
  return out;
}

/** Occurrences, not rows: the point is how much of the report each audience owns. */
export function countByAudience(findings: readonly Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.audience] = (out[f.audience] ?? 0) + f.count;
  return out;
}

/** True total occurrences, not row count. */
export function countOccurrences(findings: readonly Finding[]): number {
  return findings.reduce((total, f) => total + f.count, 0);
}

/** Groups findings by site, most-affected site first. */
export function groupBySite(findings: readonly Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = groups.get(f.site);
    if (list) list.push(f);
    else groups.set(f.site, [f]);
  }
  return new Map(
    [...groups.entries()].sort(
      (a, b) =>
        severityRank(a[1][0]?.severity ?? 'info') - severityRank(b[1][0]?.severity ?? 'info') ||
        b[1].length - a[1].length,
    ),
  );
}
