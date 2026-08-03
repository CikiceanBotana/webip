/**
 * scripts/smoke.ts -- tooling smoke test.
 *
 * Proves that every installed tool is actually callable. This file deliberately
 * contains NO crawler, audit, or check logic; it only answers the question
 * "does each tool run at all?".
 *
 * It mirrors the project's two-lane architecture:
 *
 *   BROWSER LANE (steps 1-5)  one Chromium instance, driven sequentially
 *                             because every step shares the same page.
 *   FAST LANE    (steps 6-8)  no browser at all; the three checks are mutually
 *                             independent and run concurrently.
 *
 * The two lanes are independent, so they run at the same time. Output from each
 * step is buffered and flushed in step order at the end, so concurrency never
 * scrambles the report.
 *
 * Run: npm run smoke
 * Exits non-zero if any step fails. Skipped steps (missing optional runtime)
 * do not fail the run, but are reported loudly.
 */

import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as aChecker from 'accessibility-checker';
import axe from 'axe-core';
import * as cheerio from 'cheerio';
import lighthouse from 'lighthouse';
import { chromium, type Browser, type Page } from 'playwright';

const require = createRequire(import.meta.url);

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EVIDENCE_DIR = path.join(ROOT, 'out', 'evidence');
const LYCHEE_BIN = process.env.WEBIP_LYCHEE_BIN ?? path.join(ROOT, 'bin', 'lychee');

const TARGET = 'https://example.com';

/** Fixed by default so runs are reproducible; override if 9333 is taken. */
const CDP_PORT = Number(process.env.WEBIP_CDP_PORT ?? 9333);

/**
 * The Nu validator is a Java process. Cap its heap so it can run alongside
 * Chromium + Lighthouse on memory-constrained machines without the OOM killer
 * picking a winner.
 */
const JVM_ARGS = ['-Xmx256m'];

/** Deliberately invalid: <head> has no <title>, and </p> closes nothing. */
const INVALID_HTML =
  '<!DOCTYPE html><html><head></head><body><p><div>bad</div></p></body></html>';

// -----------------------------------------------------------------------------
// Step plumbing
// -----------------------------------------------------------------------------

interface StepResult {
  n: number;
  tool: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  lines: string[];
}

type Logger = (line: string) => void;

/**
 * Runs one step, capturing its output instead of printing it, so that lanes
 * running concurrently still produce an ordered report. Returning the string
 * 'skip' marks the step skipped rather than passed.
 */
async function step(
  n: number,
  tool: string,
  fn: (log: Logger) => Promise<'skip' | void>,
): Promise<StepResult> {
  const lines: string[] = [];
  const log: Logger = (line) => lines.push(line);
  try {
    const outcome = await fn(log);
    return { n, tool, status: outcome === 'skip' ? 'SKIP' : 'PASS', lines };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    lines.push(...message.split('\n').slice(0, 5).map((l) => l.trim()));
    return { n, tool, status: 'FAIL', lines };
  }
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Minimal process runner with optional stdin and a hard timeout. */
function exec(
  cmd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`Timed out after ${opts.timeoutMs}ms: ${cmd}`));
          }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (!settled) reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!settled) resolve({ code, stdout, stderr });
    });

    child.stdin.end(opts.stdin ?? '');
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// -----------------------------------------------------------------------------
// BROWSER LANE -- steps 1-5. Sequential: they share one page.
// -----------------------------------------------------------------------------

async function browserLane(): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let browser: Browser | undefined;
  let page: Page | undefined;

  // 1. Playwright / Chromium
  results.push(
    await step(1, 'playwright + chromium', async (log) => {
      browser = await chromium.launch({
        args: [`--remote-debugging-port=${CDP_PORT}`],
      });
      log(`chromium build      ${browser.version()}`);
      page = await browser.newPage();
      const response = await page.goto(TARGET, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      log(`http status         ${response?.status() ?? 'n/a'}`);
      const title = (await page.title()).trim();
      assert(title.length > 0, `Expected a non-empty <title> at ${TARGET}`);
      log(`page title          "${title}"`);
    }),
  );

  // Steps 2-5 all need a live page. If step 1 failed there is nothing to do.
  const pageReady = (): Page => {
    assert(page, 'Skipped: Chromium never reached a usable page (step 1 failed)');
    return page;
  };

  // 2. axe-core, injected into the page
  results.push(
    await step(2, 'axe-core (injected)', async (log) => {
      const p = pageReady();
      await p.addScriptTag({ content: axe.source });
      // Reading the count from inside the page proves the injection landed,
      // rather than just proving the npm package parses in Node.
      const ruleCount = await p.evaluate(() => {
        const w = window as unknown as { axe?: { getRules(): unknown[] } };
        if (!w.axe) throw new Error('axe-core did not attach to window');
        return w.axe.getRules().length;
      });
      assert(ruleCount > 0, 'axe-core reported zero rules');
      log(`axe-core version    ${axe.version}`);
      log(`rules loaded        ${ruleCount}`);
    }),
  );

  // 3. IBM equal-access (accessibility-checker)
  results.push(
    await step(3, 'accessibility-checker (IBM)', async (log) => {
      const p = pageReady();
      const rules = await aChecker.getRules();
      assert(Array.isArray(rules) && rules.length > 0, 'IBM checker reported zero rules');
      log(`rules loaded        ${rules.length}`);

      const rulesets = await aChecker.getRulesets();
      log(`rulesets available  ${Array.isArray(rulesets) ? rulesets.length : 'n/a'}`);

      // Actually execute against the live page, not just enumerate rules.
      // getCompliance resolves to ICheckerReport | ICheckerError, so narrow to
      // the success shape instead of asserting straight through the union.
      const result = await aChecker.getCompliance(p, 'smoke');
      const counts = (
        result?.report as { summary?: { counts?: Record<string, number> } } | undefined
      )?.summary?.counts;
      assert(
        counts,
        `IBM checker returned no summary counts: ${JSON.stringify(result?.report).slice(0, 200)}`,
      );
      log(`executed on page    pass=${counts['pass']} violation=${counts['violation']}`);
    }),
  );

  // 4. Lighthouse, over the CDP port opened in step 1
  results.push(
    await step(4, 'lighthouse', async (log) => {
      pageReady();
      const run = await lighthouse(TARGET, {
        port: CDP_PORT,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance'],
      });
      const score = run?.lhr?.categories?.['performance']?.score;
      assert(typeof score === 'number', 'Lighthouse returned no performance score');
      log(`lighthouse version  ${run?.lhr?.lighthouseVersion ?? 'n/a'}`);
      log(`performance score   ${(score * 100).toFixed(0)}/100`);
    }),
  );

  // 5. Screenshot evidence.
  //    Evidence only -- this project never diffs images.
  results.push(
    await step(5, 'screenshot evidence', async (log) => {
      const p = pageReady();
      await mkdir(EVIDENCE_DIR, { recursive: true });
      const file = path.join(EVIDENCE_DIR, 'smoke-example-com.png');
      await p.screenshot({ path: file, fullPage: true });
      const info = await stat(file);
      assert(info.isFile(), `Screenshot was not written: ${file}`);
      assert(info.size > 0, `Screenshot is zero bytes: ${file}`);
      log(`file                ${path.relative(ROOT, file)}`);
      log(`size                ${info.size} bytes`);
    }),
  );

  try {
    await aChecker.close();
  } catch {
    /* checker was never started; nothing to close */
  }
  if (browser) await browser.close();

  return results;
}

// -----------------------------------------------------------------------------
// FAST LANE -- steps 6-8. No browser. Mutually independent, so run together.
// -----------------------------------------------------------------------------

/** 6. Plain fetch + cheerio. Proves the browser-free lane works end to end. */
function stepFetchCheerio(): Promise<StepResult> {
  return step(6, 'fetch + cheerio (no browser)', async (log) => {
    const response = await fetch(TARGET, {
      headers: { 'user-agent': 'webip-smoke/0.0.0' },
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `Fetch failed: HTTP ${response.status}`);
    const html = await response.text();
    log(`bytes fetched       ${html.length}`);

    const $ = cheerio.load(html);
    const title = $('title').first().text().trim();
    assert(title.length > 0, 'cheerio extracted an empty <title>');
    log(`cheerio <title>     "${title}"`);
    log(`links seen          ${$('a[href]').length}`);
  });
}

/** 7. lychee link checker. */
function stepLychee(): Promise<StepResult> {
  return step(7, 'lychee', async (log) => {
    const version = await exec(LYCHEE_BIN, ['--version'], { timeoutMs: 30_000 }).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          throw new Error(
            `lychee binary not found at ${LYCHEE_BIN}. Run ./scripts/install-lychee.sh`,
          );
        }
        throw err;
      },
    );
    log(`version             ${version.stdout.trim() || version.stderr.trim()}`);

    const run = await exec(
      LYCHEE_BIN,
      ['--no-progress', '--max-retries', '1', TARGET],
      { timeoutMs: 120_000 },
    );
    log(`exit code           ${run.code}`);
    const summary = run.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('Total'));
    if (summary) log(`summary             ${summary}`);
    assert(run.code === 0, `lychee exited ${run.code} (expected 0 for ${TARGET})`);
  });
}

/** 8. vnu-jar (W3C Nu validator). Requires a JRE; skips cleanly without one. */
function stepVnu(): Promise<StepResult> {
  return step(8, 'vnu-jar (W3C Nu)', async (log) => {
    try {
      const java = await exec('java', ['-version'], { timeoutMs: 30_000 });
      const banner = (java.stderr || java.stdout).split('\n')[0]?.trim();
      log(`java                ${banner ?? 'present'}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log('SKIPPED: no `java` on PATH. vnu-jar needs a JRE (Java 17+).');
        log('Install one, or run the Docker image, which bundles it.');
        return 'skip';
      }
      throw err;
    }

    const jar = String(require('vnu-jar'));
    log(`jar                 ${path.relative(ROOT, jar)}`);

    const run = await exec(
      'java',
      [...JVM_ARGS, '-jar', jar, '--format', 'json', '--stdout', '--exit-zero-always', '-'],
      { stdin: INVALID_HTML, timeoutMs: 180_000 },
    );

    const payload = run.stdout.trim();
    assert(payload.length > 0, `vnu produced no output. stderr: ${run.stderr.slice(0, 300)}`);

    const parsed = JSON.parse(payload) as {
      messages?: Array<{ type: string; message: string }>;
    };
    const errors = (parsed.messages ?? []).filter((m) => m.type === 'error');
    assert(
      errors.length >= 1,
      `Expected >=1 error from deliberately invalid HTML, got ${errors.length}`,
    );
    log(`errors reported     ${errors.length}`);
    log(`first error         ${errors[0]?.message ?? ''}`);
  });
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

function report(results: StepResult[]): number {
  const ordered = [...results].sort((a, b) => a.n - b.n);
  const width = 68;

  console.log('');
  console.log('='.repeat(width));
  console.log('  webip -- tooling smoke test');
  console.log(`  node ${process.version}  |  target ${TARGET}`);
  console.log('='.repeat(width));

  for (const r of ordered) {
    console.log('');
    console.log(`${r.status}  [${r.n}] ${r.tool}`);
    for (const line of r.lines) console.log(`        ${line}`);
  }

  const passed = ordered.filter((r) => r.status === 'PASS').length;
  const failed = ordered.filter((r) => r.status === 'FAIL');
  const skipped = ordered.filter((r) => r.status === 'SKIP');

  console.log('');
  console.log('-'.repeat(width));
  console.log(
    `  ${passed} passed, ${failed.length} failed, ${skipped.length} skipped  (of ${ordered.length})`,
  );
  if (failed.length > 0) {
    console.log(`  FAILED: ${failed.map((r) => `[${r.n}] ${r.tool}`).join(', ')}`);
  }
  if (skipped.length > 0) {
    console.log(`  SKIPPED: ${skipped.map((r) => `[${r.n}] ${r.tool}`).join(', ')}`);
  }
  console.log('-'.repeat(width));
  console.log('');

  return failed.length > 0 ? 1 : 0;
}

// -----------------------------------------------------------------------------
// Main -- both lanes at once
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });

  const [browserResults, ...fastResults] = await Promise.all([
    browserLane(),
    stepFetchCheerio(),
    stepLychee(),
    stepVnu(),
  ]);

  process.exitCode = report([...browserResults, ...fastResults]);
}

main().catch((err: unknown) => {
  console.error('\nFATAL: the smoke harness itself crashed.');
  console.error(err);
  process.exitCode = 1;
});
