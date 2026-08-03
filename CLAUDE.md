# webip — working notes

Two-lane web inspection tool. Fast HTTP lane (no browser) + slow Chromium lane.
**There is no image diffing.** Screenshots are evidence attached to findings only, never compared.

---

## Environment traps — do not rediscover these

| Trap | Detail |
|---|---|
| **`NODE_ENV=production` is exported in this shell** | npm reads it as `--omit=dev` and **silently skips devDependencies** — it still writes them to `package.json`, so it looks installed but `tsx: not found`. Always `unset NODE_ENV` or `npm ci --include=dev`. |
| **System node is v24; project needs 22.23.2** | Prefix every shell call: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22.23.2` |
| **No passwordless sudo** | `playwright install --with-deps` dies at the apt step *before downloading*. Use plain `playwright install chromium`; the host libs are already present. |
| **Docker is not installed on this host** | The Dockerfile cannot be built or tested locally. Base tag was verified via the MCR registry API instead. |
| **`pkill -f "tsx src/cli.ts"` kills your own shell** | `-f` matches the pattern against every command line *including the bash process running the pkill*. Exit code 144 is your own shell dying. Kill by explicit PID, or use a bracketed regex (`'cli[.]ts'`). |
| **Background runs get orphaned on session teardown** | A plain `run_in_background` shell stays a child of the harness. Launch long scans as `nohup setsid <cmd> > log 2>&1 < /dev/null &` so they reparent to PID 1 and survive. |

### Watching a detached run
```bash
tail -f --pid=<PID> out/pilot/scan.log | grep -E --line-buffered '──|batch|FATAL|Killed|out of memory'
```
`tail --pid` exits by itself when the process dies, so the watcher ends naturally.

### Silent-corruption failure mode (seen once, cost a whole run)
Killing the Chromium processes but leaving the Node parent alive did **not** crash the scan.
Per-page error handling caught every navigation failure and moved on, so the log kept
incrementing `browser N/120 · 0 findings`. **A run where every browser check fails looks
identical to progress.** If findings-per-page suddenly goes to 0, the browsers are dead —
discard the run, do not report from it.

---

## Verified API shapes (all confirmed working — do not re-derive)

- **accessibility-checker (IBM equal-access)** — CJS with **no default export** in ESM →
  `import * as aChecker`. 174 rules, 6 rulesets. `getCompliance(page, label)` works with a
  Playwright page. Returns `ICheckerReport | ICheckerError` → must narrow before reading
  `.summary`. Keeps engine state **on the module**, so concurrent calls corrupt each other —
  serialised behind a lock in `src/lanes/browser/ibm.ts`. Writes artifacts to `outputFolder`
  from `.achecker.yml` (set to `out/ibm-a11y`, else it litters `./results`).
- **`@axe-core/playwright`** — use the **named** import `{ AxeBuilder }`. The shipped `.d.ts`
  resolves as CJS under NodeNext, so a default import types as the whole module namespace and
  is not constructable.
- **axe-core** — default import; 105 rules; `axe.source` is injectable via `addScriptTag`.
- **lighthouse** — default export fn. Drive via
  `chromium.launch({args:['--remote-debugging-port=N']})` then `lighthouse(url, {port: N})`.
  **Leaks User Timing marks between runs in one process** → later runs die with
  *"the 'start lh:driver:navigate' performance mark has not been set"*. Call
  `performance.clearMarks()/clearMeasures()` before each run.
- **vnu-jar** — `String(require('vnu-jar'))` → jar path.
  `java -jar <jar> --format json --stdout --exit-zero-always -` (`-` = stdin; a directory also works).
- **lychee** — `./bin/lychee --no-progress --format json ...`. Prints a human `Hint:` line
  **after** the JSON, so the payload cannot be `JSON.parse`d wholesale — use the
  brace-balanced extractor in `src/lanes/http/links.ts`.
- **esbuild/tsx `keepNames`** — rewrites inner functions as `__name(fn,"fn")`. That helper
  lives in the Node module scope, so any function passed to `page.evaluate` throws
  `__name is not defined` **inside the browser**. Inject an identity shim as a *string*
  expression first (see `ensureNameShim` in `layout.ts`).

---

## Architecture

```
src/core/         Finding vocabulary + stable content-hash ids, collapse/sort/summarise,
                  ONE concurrency primitive (mapPool/chunk), fetch, evidence, report, config
src/discover/     seed -> sites -> pages. A <sitemapindex> means HUB (many sites)
src/lanes/http/   browser-free: semantics, html-validate, Nu validator, lychee
src/lanes/browser/ Chromium pool: axe, IBM, lighthouse, layout geometry
src/orchestrator.ts  runs BOTH LANES CONCURRENTLY; contains no checking logic
```

**The invariant that matters:** every tool normalises to `Finding[]` behind an adapter.
The orchestrator, deduper and reporters never learn a tool's native output. Adding a checker
is one new file. Removing one is a `tools.*` config flag.

Two batching rules that are load-bearing:
- The fast lane takes a **flat page list**, not a site. The JVM and lychee amortise over the
  batch, so a 357-homepage sweep is **one** java process, not 357.
- Each browser worker gets its **own CDP port** (`cdpBasePort + i`), else Lighthouse attaches
  to a peer's tabs.

---

## Target: sogood.business

Not one site — a **hub**. `/sitemap.xml` is a `<sitemapindex>` listing **357 tenant sites**,
~19 pages each (~6,800 pages). Some are on their own apex domains
(`cuddletherapyaz.com`, `guardrail.website`, `ttsphotography.co`).

Because all tenants render one platform template, the useful question is
**"is this broken once or 357 times?"** — `npm run analyze` splits findings into
platform-wide / widespread / tenant-specific.

### Confirmed defects
- **`HEAD /` returns 404 `application/json` while `GET /` returns 200 `text/html`** on the hub.
  Breaks CDN caches, uptime monitors, link checkers, social preview crawlers.
- Tenant sitemaps list pages that **404** (e.g. `pawdium.../blog`).

---

## Commands

```bash
nvm use && unset NODE_ENV
npm run smoke      # prove all 8 tools are callable
npm run scan -- --config config/sogood.json --out out/pilot
npm run analyze -- out/pilot/findings.json
npm run typecheck
```

Budget the browser lane at roughly `deepSites × maxPagesPerSite × 30s / browserConcurrency`.
`browserConcurrency` is **memory**-bound (~300MB/worker), not CPU-bound — this host has ~5.6GB.
