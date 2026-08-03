/**
 * Run configuration: defaults, file loading, and CLI overrides.
 *
 * Defaults are tuned for a laptop, not a server. The browser lane in particular
 * is memory-bound -- each worker is a full Chromium -- so `browserConcurrency`
 * defaults to 2 rather than to the core count.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunConfig } from './types.js';

export const DEFAULT_CONFIG: RunConfig = {
  seeds: [],
  maxSites: 500,
  maxPagesPerSite: 8,
  deepSites: 10,
  httpConcurrency: 8,
  browserConcurrency: 2,
  tools: {
    axe: true,
    ibm: true,
    lighthouse: true,
    layout: true,
    contrast: true,
    branding: true,
    htmlValidate: true,
    nuValidator: true,
    lychee: true,
    semantics: true,
  },
  screenshots: true,
  pageTimeoutMs: 60_000,
  cdpBasePort: 9400,
  outDir: 'out',
};

/** How many pages one fast-lane batch carries into a single java/lychee call. */
export const HTTP_BATCH_SIZE = 40;

/** How many fast-lane batches run at once. Each batch owns a JVM + a lychee. */
export const HTTP_BATCH_CONCURRENCY = 2;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export function mergeConfig(base: RunConfig, override: DeepPartial<RunConfig>): RunConfig {
  return {
    ...base,
    ...override,
    tools: { ...base.tools, ...(override.tools ?? {}) },
  } as RunConfig;
}

export async function loadConfigFile(file: string): Promise<DeepPartial<RunConfig>> {
  const raw = await readFile(path.resolve(file), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  // JSON has no comments, so config files use "_"-prefixed keys for prose.
  // Strip them here rather than letting them leak into the report's config echo.
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('_')) delete parsed[key];
  }
  return parsed as DeepPartial<RunConfig>;
}

export interface CliOptions {
  config?: string;
  seeds: string[];
  overrides: DeepPartial<RunConfig>;
  help: boolean;
}

/** Minimal flag parser. No dependency needed for a dozen options. */
export function parseArgs(argv: readonly string[]): CliOptions {
  const seeds: string[] = [];
  const overrides: DeepPartial<RunConfig> = {};
  const tools: Partial<RunConfig['tools']> = {};
  let config: string | undefined;
  let help = false;

  const next = (i: number): string => argv[i + 1] ?? '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '-c':
      case '--config':
        config = next(i);
        i += 1;
        break;
      case '--seed':
        seeds.push(next(i));
        i += 1;
        break;
      case '--max-sites':
        overrides.maxSites = Number(next(i));
        i += 1;
        break;
      case '--deep-sites':
        overrides.deepSites = Number(next(i));
        i += 1;
        break;
      case '--max-pages':
        overrides.maxPagesPerSite = Number(next(i));
        i += 1;
        break;
      case '--http-concurrency':
        overrides.httpConcurrency = Number(next(i));
        i += 1;
        break;
      case '--browser-concurrency':
        overrides.browserConcurrency = Number(next(i));
        i += 1;
        break;
      case '--timeout':
        overrides.pageTimeoutMs = Number(next(i));
        i += 1;
        break;
      case '--out':
        overrides.outDir = next(i);
        i += 1;
        break;
      case '--no-screenshots':
        overrides.screenshots = false;
        break;
      case '--no-lighthouse':
        tools.lighthouse = false;
        break;
      case '--no-browser':
        tools.axe = false;
        tools.ibm = false;
        tools.lighthouse = false;
        tools.layout = false;
        tools.contrast = false;
        tools.branding = false;
        break;
      case '--no-links':
        tools.lychee = false;
        break;
      case '--no-nu':
        tools.nuValidator = false;
        break;
      case '--fast-only':
        overrides.deepSites = 0;
        break;
      default:
        if (!arg.startsWith('-') && arg !== '') seeds.push(arg);
        break;
    }
  }

  if (Object.keys(tools).length > 0) overrides.tools = tools;

  return { ...(config !== undefined ? { config } : {}), seeds, overrides, help };
}

export const HELP_TEXT = `
webip -- two-lane web inspection

USAGE
  npm run scan -- [seed-url...] [options]

OPTIONS
  -c, --config <file>          JSON config file (see config/sogood.json)
      --seed <url>             Seed URL; repeatable. A hub's sitemap index is
                               expanded into all of its sites.
      --max-sites <n>          Cap on sites taken from the seeds
      --deep-sites <n>         How many sites also get the browser lane
      --max-pages <n>          Pages per site for the deep scan
      --http-concurrency <n>   Parallel fetches (default 8)
      --browser-concurrency <n> Parallel Chromium instances (default 2, memory-bound)
      --timeout <ms>           Per-page timeout (default 60000)
      --out <dir>              Output directory (default out)
      --no-screenshots         Skip evidence capture
      --no-lighthouse          Skip Lighthouse (it is ~80% of browser-lane cost)
      --no-browser             Fast lane only
      --no-links               Skip lychee
      --no-nu                  Skip the Nu validator
      --fast-only              Alias for --deep-sites 0
  -h, --help                   This text

EXAMPLES
  npm run scan -- https://example.com
  npm run scan -- --config config/sogood.json
  npm run scan -- https://example.com --fast-only
`;
