/**
 * HTML validity, browser-free.
 *
 * Two validators, deliberately:
 *   html-validate -- in-process, fast, opinionated, runs per page.
 *   vnu (W3C Nu)  -- the reference implementation, but it is a JVM process.
 *
 * The Nu validator is BATCHED: every page of a site is written to a temp file
 * and validated in ONE java invocation. JVM startup is ~1.5s, so per-page
 * invocation would cost more than the validation itself -- on 6,800 pages that
 * is nearly three hours of pure process startup.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HtmlValidate } from 'html-validate';

import { makeFinding, truncate } from '../../core/finding.js';
import type { FetchedPage } from '../../core/net.js';
import type { Finding, PageTarget, Severity } from '../../core/types.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// html-validate
// ---------------------------------------------------------------------------

/** One shared instance; constructing it parses the rule config. */
const htmlValidate = new HtmlValidate({
  extends: ['html-validate:recommended'],
  rules: {
    // Void-element style and attribute quoting are formatting opinions, not
    // defects. Silence them so real problems stay visible.
    'void-style': 'off',
    'attribute-boolean-style': 'off',
    'no-trailing-whitespace': 'off',
    'attr-quotes': 'off',
    'long-title': 'off',
  },
});

/** html-validate severity: 2 = error, 1 = warning. */
function severityFromHtmlValidate(severity: number): Severity {
  return severity >= 2 ? 'moderate' : 'minor';
}

export async function checkHtmlValidate(
  target: PageTarget,
  page: FetchedPage,
): Promise<Finding[]> {
  if (page.body.trim() === '') return [];

  const report = await htmlValidate.validateString(page.body);
  const findings: Finding[] = [];

  for (const result of report.results) {
    for (const message of result.messages) {
      findings.push(
        makeFinding({
          site: target.site,
          url: target.url,
          lane: 'http',
          tool: 'html-validate',
          rule: message.ruleId,
          severity: severityFromHtmlValidate(message.severity),
          title: message.message,
          instances: [
            {
              line: message.line,
              column: message.column,
              ...(message.selector ? { selector: message.selector } : {}),
              message: message.message,
            },
          ],
          helpUrl: `https://html-validate.org/rules/${message.ruleId}.html`,
        }),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// vnu (W3C Nu validator)
// ---------------------------------------------------------------------------

export interface NuMessage {
  type: string;
  subType?: string;
  url?: string;
  message: string;
  firstLine?: number;
  lastLine?: number;
  firstColumn?: number;
  lastColumn?: number;
  extract?: string;
}

function severityFromNu(message: NuMessage): Severity {
  if (message.type === 'error') return message.subType === 'fatal' ? 'serious' : 'moderate';
  if (message.subType === 'warning') return 'minor';
  return 'info';
}

/** Nu emits a long sentence; the first clause is enough to group on. */
function ruleIdFromNuMessage(message: string): string {
  return truncate(
    message
      .replace(/“[^”]*”/g, '<x>')
      .replace(/"[^"]*"/g, '<x>')
      .replace(/\d+/g, 'N'),
    80,
  );
}

function runJava(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('java', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`vnu timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (!settled) resolve({ stdout, stderr });
    });
  });
}

/** True when a JRE is on PATH. Probed once and cached. */
let javaAvailable: boolean | undefined;
export async function hasJava(): Promise<boolean> {
  if (javaAvailable !== undefined) return javaAvailable;
  try {
    await runJava(['-version'], 20_000);
    javaAvailable = true;
  } catch {
    javaAvailable = false;
  }
  return javaAvailable;
}

/**
 * Validates a whole batch of pages in one JVM.
 *
 * Each page is written to `<n>.html` in a temp dir; Nu reports the file URL,
 * which maps back to the originating page by index.
 */
export async function checkNuValidator(
  pages: ReadonlyArray<{ target: PageTarget; page: FetchedPage }>,
  opts: { timeoutMs: number; heapMb: number },
): Promise<Finding[]> {
  const withBody = pages.filter((p) => p.page.body.trim() !== '');
  if (withBody.length === 0) return [];
  if (!(await hasJava())) return [];

  const dir = await mkdtemp(path.join(tmpdir(), 'webip-vnu-'));
  const byFile = new Map<string, PageTarget>();

  try {
    await Promise.all(
      withBody.map(async ({ target, page }, index) => {
        const file = path.join(dir, `${index}.html`);
        byFile.set(file, target);
        await writeFile(file, page.body, 'utf8');
      }),
    );

    const jar = String(require('vnu-jar'));
    const { stdout } = await runJava(
      [
        `-Xmx${opts.heapMb}m`,
        '-jar',
        jar,
        '--format',
        'json',
        '--stdout',
        '--exit-zero-always',
        '--skip-non-html',
        dir,
      ],
      opts.timeoutMs,
    );

    const payload = stdout.trim();
    if (payload === '') return [];

    const parsed = JSON.parse(payload) as { messages?: NuMessage[] };
    const findings: Finding[] = [];

    for (const message of parsed.messages ?? []) {
      // Nu reports "file:/tmp/webip-vnu-xxx/0.html".
      const filePath = (message.url ?? '').replace(/^file:/, '');
      const target = byFile.get(filePath) ?? byFile.get(path.normalize(filePath));
      if (!target) continue;

      findings.push(
        makeFinding({
          site: target.site,
          url: target.url,
          lane: 'http',
          tool: 'nu-validator',
          rule: ruleIdFromNuMessage(message.message),
          severity: severityFromNu(message),
          title: message.message,
          instances: [
            {
              ...(message.lastLine !== undefined ? { line: message.lastLine } : {}),
              ...(message.firstColumn !== undefined ? { column: message.firstColumn } : {}),
              ...(message.extract ? { snippet: truncate(message.extract, 120) } : {}),
              message: message.message,
            },
          ],
        }),
      );
    }

    return findings;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
