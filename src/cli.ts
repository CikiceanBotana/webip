/**
 * CLI entrypoint. Argument plumbing and progress printing only -- all real work
 * happens in the orchestrator.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CONFIG,
  HELP_TEXT,
  loadConfigFile,
  mergeConfig,
  parseArgs,
} from './core/config.js';
import { printSummary, writeReport } from './core/report.js';
import type { RunConfig } from './core/types.js';
import { runScan } from './orchestrator.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function timestamp(started: number): string {
  const seconds = Math.round((Date.now() - started) / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  let config: RunConfig = DEFAULT_CONFIG;
  if (args.config) {
    config = mergeConfig(config, await loadConfigFile(args.config));
  }
  config = mergeConfig(config, args.overrides);
  if (args.seeds.length > 0) {
    config = { ...config, seeds: args.seeds };
  }

  if (config.seeds.length === 0) {
    console.error('No seed URL. Pass one as an argument or use --config.\n');
    console.error(HELP_TEXT);
    process.exitCode = 2;
    return;
  }

  const started = Date.now();
  console.log(`\nwebip · scanning ${config.seeds.join(', ')}`);
  console.log(
    `deep sites: ${config.deepSites} · max pages/site: ${config.maxPagesPerSite} · ` +
      `browser workers: ${config.browserConcurrency} · lighthouse: ${config.tools.lighthouse ? 'on' : 'off'}\n`,
  );

  const report = await runScan(config, ROOT, {
    onPhase: (phase, detail) => {
      console.log(`\n[${timestamp(started)}] ── ${phase.toUpperCase()}${detail ? ` · ${detail}` : ''}`);
    },
    onProgress: (message) => {
      console.log(`[${timestamp(started)}]    ${message}`);
    },
  });

  const outDir = path.resolve(ROOT, config.outDir);
  const { json, html } = await writeReport(report, outDir);

  printSummary(report);
  console.log(`  JSON  ${path.relative(ROOT, json)}`);
  console.log(`  HTML  ${path.relative(ROOT, html)}\n`);

  // Non-zero when something genuinely broken was found, so CI can gate on it.
  const blocking = report.stats.bySeverity.critical + report.stats.bySeverity.serious;
  process.exitCode = blocking > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error('\nFATAL:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
