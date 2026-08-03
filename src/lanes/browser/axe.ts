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
import type { Finding, PageTarget } from '../../core/types.js';

interface AxeNode {
  html?: string;
  target?: unknown[];
  failureSummary?: string;
}

interface AxeResult {
  id: string;
  impact?: string | null;
  help?: string;
  description?: string;
  helpUrl?: string;
  nodes?: AxeNode[];
}

function selectorOf(node: AxeNode | undefined): string | undefined {
  const first = node?.target?.[0];
  if (typeof first === 'string') return first;
  if (Array.isArray(first) && typeof first[0] === 'string') return first[0];
  return undefined;
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

  const emit = (result: AxeResult, severity: ReturnType<typeof severityFromImpact> | 'info'): void => {
    const nodes = result.nodes ?? [];
    const first = nodes[0];
    findings.push(
      makeFinding({
        site: target.site,
        url: target.url,
        lane: 'browser',
        tool: 'axe-core',
        rule: result.id,
        severity,
        title: result.help ?? result.description ?? result.id,
        detail: truncate(first?.failureSummary ?? result.description ?? '', 300) || undefined,
        location: {
          ...(selectorOf(first) ? { selector: selectorOf(first) } : {}),
          ...(first?.html ? { snippet: truncate(first.html, 160) } : {}),
        },
        ...(result.helpUrl ? { helpUrl: result.helpUrl } : {}),
        ...(evidence ? { evidence } : {}),
        count: Math.max(1, nodes.length),
      }),
    );
  };

  for (const violation of results.violations as unknown as AxeResult[]) {
    emit(violation, severityFromImpact(violation.impact));
  }

  // `incomplete` = axe could not decide automatically. Colour contrast over a
  // background image lands here, so it is worth surfacing, but quietly.
  for (const incomplete of results.incomplete as unknown as AxeResult[]) {
    emit(incomplete, 'info');
  }

  return findings;
}
