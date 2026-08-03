/**
 * axe-core, driven through @axe-core/playwright.
 *
 * AxeBuilder is used rather than hand-injecting axe.source because it also
 * walks same-origin iframes and handles the frame messaging, which a manual
 * addScriptTag does not.
 */

// Named import, not default: the shipped .d.ts is resolved as CJS under
// NodeNext, so `import AxeBuilder from ...` types as the whole module namespace
// and is not constructable. The named export is correct at both type and
// runtime level.
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';

import { makeFinding, severityFromImpact, truncate } from '../../core/finding.js';
import type { Finding, FindingInstance, PageTarget } from '../../core/types.js';

/** One `any`/`all`/`none` check axe ran against a node. */
interface AxeCheck {
  id?: string;
  message?: string;
  /**
   * Whatever the check measured. For colour-contrast this carries the exact
   * ratio and both colours -- the difference between "contrast is wrong
   * somewhere" and "2.45:1, #a6a09b on #fbf9f3, needs 4.5:1".
   */
  data?: {
    contrastRatio?: number;
    expectedContrastRatio?: string | number;
    fgColor?: string;
    bgColor?: string;
    fontSize?: string;
    fontWeight?: string;
  } | null;
}

interface AxeNode {
  html?: string;
  target?: unknown[];
  failureSummary?: string;
  any?: AxeCheck[];
  all?: AxeCheck[];
  none?: AxeCheck[];
}

interface AxeResult {
  id: string;
  impact?: string | null;
  help?: string;
  description?: string;
  helpUrl?: string;
  tags?: string[];
  nodes?: AxeNode[];
}

function selectorOf(node: AxeNode | undefined): string | undefined {
  const first = node?.target?.[0];
  if (typeof first === 'string') return first;
  if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
  return undefined;
}

/**
 * Turns one axe node into a pinpointed occurrence.
 *
 * axe already knows exactly what is wrong with each element; the job here is to
 * carry that across instead of collapsing it into a rule name. Reporting
 * "697 contrast failures" when axe measured every single ratio wastes the only
 * part of the output a developer can act on.
 */
function instanceOf(node: AxeNode): FindingInstance {
  const checks = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])];
  const withData = checks.find((c) => c.data && c.data.contrastRatio !== undefined);
  const data = withData?.data;

  const instance: FindingInstance = {};

  const selector = selectorOf(node);
  if (selector !== undefined) instance.selector = selector;
  if (node.html) instance.snippet = truncate(node.html, 160);

  // Prefer the per-check message: it names this element's actual problem,
  // where failureSummary is identical for every node of the rule.
  const message = checks.find((c) => (c.message ?? '').trim() !== '')?.message;
  if (message) instance.message = truncate(message, 220);
  else if (node.failureSummary) instance.message = truncate(node.failureSummary, 220);

  // A ratio of 0 is not a measurement -- it is axe's placeholder for "I could
  // not work this out", which it reports when the background is a gradient or
  // an image. Presenting it as "0:1" would claim invisible text where axe
  // actually said it could not judge.
  if (data?.contrastRatio !== undefined && data.contrastRatio > 0) {
    const colours =
      data.fgColor && data.bgColor ? ` (${data.fgColor} on ${data.bgColor})` : '';
    instance.measured = `${data.contrastRatio}:1${colours}`;
    if (data.expectedContrastRatio !== undefined) {
      instance.expected = String(data.expectedContrastRatio).replace(/:1$/, '') + ':1';
    }
  }

  return instance;
}

/**
 * `evidence` is attached to every finding this page produced. It is a
 * screenshot used purely as proof for a human reader -- this project never
 * compares images.
 */
export async function checkAxe(
  target: PageTarget,
  page: Page,
  evidence?: string,
): Promise<Finding[]> {
  const results = await new AxeBuilder({ page }).analyze();
  const findings: Finding[] = [];

  const emit = (
    result: AxeResult,
    severity: ReturnType<typeof severityFromImpact> | 'info',
    kind: 'violation' | 'needs-review',
  ): void => {
    const nodes = result.nodes ?? [];
    const review = kind === 'needs-review';
    findings.push(
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'browser',
        tool: 'axe-core',
        // Kept as a DISTINCT rule id. `collapse` groups by url+tool+rule and
        // adopts the most severe label, so sharing an id with the violation
        // would silently relabel "axe could not judge this" as "this is
        // broken" -- on one page that turned 1 real contrast failure and 41
        // undecidable ones into a single row reading "70 serious failures".
        rule: review ? `${result.id}-needs-review` : result.id,
        severity,
        title: review
          ? `Needs human review: ${result.help ?? result.description ?? result.id}`
          : (result.help ?? result.description ?? result.id),
        detail: truncate(result.description ?? '', 300) || undefined,
        // EVERY failing node, not just the first.
        instances: nodes.map(instanceOf),
        // axe's own tags decode into the WCAG criteria the rule implements.
        ...(result.tags ? { tags: result.tags } : {}),
        ...(result.helpUrl ? { helpUrl: result.helpUrl } : {}),
        ...(evidence ? { evidence } : {}),
        count: Math.max(1, nodes.length),
      }),
    );
  };

  for (const violation of results.violations as unknown as AxeResult[]) {
    emit(violation, severityFromImpact(violation.impact), 'violation');
  }

  // `incomplete` = axe ran the check and could not decide. Contrast over a
  // gradient or an image lands here. Worth surfacing so a human can look, but
  // it is evidence of uncertainty, not of a defect.
  for (const incomplete of results.incomplete as unknown as AxeResult[]) {
    emit(incomplete, 'info', 'needs-review');
  }

  return findings;
}
