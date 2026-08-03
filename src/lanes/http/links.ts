/**
 * Broken link and asset detection, via lychee.
 *
 * lychee is given the page URLs directly and does its own extraction, so it
 * covers <a href>, <img src>, stylesheets and scripts in one pass. It is
 * BATCHED per site: one process checks every page of a site, which lets lychee
 * dedupe repeated links (nav, footer) across those pages instead of re-checking
 * the same footer link on all 19 pages.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFinding } from '../../core/finding.js';
import { originOf } from '../../core/net.js';
import type { Finding, PageTarget, Severity } from '../../core/types.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export const DEFAULT_LYCHEE_BIN = process.env['WEBIP_LYCHEE_BIN'] ?? path.join(ROOT, 'bin', 'lychee');

/** One failed link as lychee reports it. */
interface LycheeEntry {
  url?: string;
  status?: {
    text?: string;
    code?: number;
    details?: string;
  };
}

interface LycheeReport {
  total?: number;
  successful?: number;
  errors?: number;
  timeouts?: number;
  error_map?: Record<string, LycheeEntry[]>;
  timeout_map?: Record<string, LycheeEntry[]>;
}

/**
 * lychee prints a human "Hint:" line after the JSON, so the payload cannot be
 * JSON.parse'd wholesale. Extract the first balanced object instead of
 * regex-guessing, and stay string-aware so a brace inside a URL cannot
 * unbalance the scan.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function severityForStatus(code: number | undefined, text: string): Severity {
  if (code === undefined) {
    // Connection refused / DNS failure / TLS error.
    return /timeout|timed out/i.test(text) ? 'moderate' : 'serious';
  }
  if (code >= 500) return 'serious';
  if (code === 404 || code === 410) return 'serious';
  if (code === 403 || code === 401) return 'minor'; // often bot protection, not a real break
  if (code === 429) return 'info';
  return 'moderate';
}

function runLychee(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`lychee timed out after ${timeoutMs}ms`));
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
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) resolve({ stdout, stderr, code });
    });
  });
}

export interface LinkCheckOptions {
  bin?: string;
  timeoutMs: number;
  /** Parallel in-flight requests inside lychee itself. */
  maxConcurrency: number;
  /** Skip link checking entirely for these hosts. Regex, passed to lychee. */
  exclude?: string[];
  /**
   * Exact URLs to drop from the results.
   *
   * lychee extracts every URL-shaped attribute it finds, including form
   * actions, and then GETs them. A POST-only endpoint answers 400 to that and
   * looks identical to a dead link. The caller knows which URLs are form
   * targets; this is where they are removed.
   */
  ignoreUrls?: readonly string[];
}

/**
 * Checks every link found on `targets`. Returns findings attributed to the page
 * the broken link was found on.
 */
export async function checkLinks(
  targets: readonly PageTarget[],
  opts: LinkCheckOptions,
): Promise<Finding[]> {
  if (targets.length === 0) return [];

  const bin = opts.bin ?? DEFAULT_LYCHEE_BIN;
  const args = [
    '--no-progress',
    '--format',
    'json',
    '--max-retries',
    '1',
    '--max-concurrency',
    String(opts.maxConcurrency),
    '--timeout',
    '20',
    // Bot-protected social endpoints return 999/403 for every crawler and are
    // pure noise in a report about the site's own health.
    '--exclude',
    '(facebook|instagram|linkedin|twitter|x)\\.com',
    ...(opts.exclude ?? []).flatMap((pattern) => ['--exclude', pattern]),
    ...targets.map((t) => t.url),
  ];

  const { stdout } = await runLychee(bin, args, opts.timeoutMs);
  const payload = extractFirstJsonObject(stdout);
  if (!payload) return [];

  let report: LycheeReport;
  try {
    report = JSON.parse(payload) as LycheeReport;
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  const knownUrls = new Set(targets.map((t) => t.url));
  const ignored = new Set(opts.ignoreUrls ?? []);
  const fallbackSite = targets[0]?.site ?? '';

  const consume = (
    map: Record<string, LycheeEntry[]> | undefined,
    kind: 'broken-link' | 'link-timeout',
  ): void => {
    for (const [source, entries] of Object.entries(map ?? {})) {
      // `source` is the page the link was found on.
      const sourceUrl = knownUrls.has(source) ? source : (targets[0]?.url ?? source);
      const site = originOf(source) || fallbackSite;

      for (const entry of entries) {
        if (entry.url !== undefined && ignored.has(entry.url)) continue;
        const statusText = entry.status?.text ?? entry.status?.details ?? 'unknown error';
        const code = entry.status?.code;
        const isExternal = originOf(entry.url ?? '') !== site;

        findings.push(
          makeFinding({
            site,
            url: sourceUrl,
            lane: 'http',
            tool: 'lychee',
            rule: kind === 'link-timeout' ? 'link-timeout' : `broken-link-${code ?? 'network'}`,
            // A broken link to your own page is worse than a dead third party.
            severity:
              kind === 'link-timeout'
                ? 'minor'
                : isExternal
                  ? 'minor'
                  : severityForStatus(code, statusText),
            // The URL lives in the instance, not the title. A page with 20
            // dead links collapses to ONE row, and a title naming just one of
            // them would hide the other 19 behind a count.
            title: `${isExternal ? 'External' : 'Internal'} link ${code ? `returns ${code}` : 'fails'}`,
            detail: statusText,
            instances: [
              {
                target: entry.url ?? '(unknown)',
                message: statusText,
                measured: code !== undefined ? `HTTP ${code}` : statusText,
                expected: 'HTTP 200',
              },
            ],
          }),
        );
      }
    }
  };

  consume(report.error_map, 'broken-link');
  consume(report.timeout_map, 'link-timeout');

  return findings;
}
