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
  **Must be serialised PROCESS-WIDE, not per worker.** `performance` is one global object
  per Node process, so two workers running Lighthouse concurrently erase each other's User
  Timing marks and the loser dies with *"the 'start lh:driver:navigate' performance mark has
  not been set"*. On the 120-page pilot with 2 workers this was **56 failures — 100% of all
  scan errors in the run**. `performance.clearMarks()` alone does NOT fix it (it is part of
  the cause) and the retry cannot help, because the competing worker is still running. The
  lock is in `src/lanes/browser/lighthouse.ts`.
  Also read `audit.details.items` — that is where the specifics live (which image, how many
  bytes, which node). Reading only the score throws away everything actionable.
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

### The specificity rule — a count is not a defect report

**Adapters MUST emit every occurrence, never just the first.** Each one becomes a
`FindingInstance` carrying `selector / snippet / line / column / target / measured / expected`.
`collapse()` merges instance lists; it never keeps one and drops the rest.

This is not stylistic. Before it was enforced, one pilot produced:
- 242 broken links → 62 rows naming 62 URLs. **180 dead URLs existed only as a number.**
- 697 contrast failures → 120 rows. axe had measured every ratio and colour pair; the
  adapter kept the first and discarded 577.
- 24,649 real occurrences → 5,372 rows. **78% of findings had no "where".**

`count` is always the TRUE total; `instances` is capped at 50 and sets `instancesTruncated`
when it drops any (never set when `instances` is empty — a page-level rule legitimately has
nothing below the URL to point at).

### The verification rule — a measurement is not a defect

Five reported "defects" were rejected by the site owner on sight, and **every one of them was
his**. The scan measured correctly each time and concluded wrongly, because a number was
treated as a verdict:

| Reported | Reality |
|---|---|
| 72 tap targets below 24px | Conforming under SC 2.5.8's **spacing** exception — nav links sat 47–110px apart |
| Content clipped by 40px | An `aria-hidden` decorative blur blob; the text ended 56px *above* the crop |
| 12 clipped card teasers | `-webkit-line-clamp: 2` — deliberate truncation, the design |
| 242 broken links incl. `/api/waitlist` | A `<form action>`, POST-only. A GET from a link checker proves nothing |
| 3 controls "blocked" by the sogood badge | Two were clickable **where they stood**; the third was free 200px down a 722px page |

The pattern is always the same: **geometry that looks wrong at one instant, reported as a
permanent fact.** The corrections are not special cases, they are the rule doing its job —
so before adding any geometric check, ask what makes the number *not* a defect, and encode
that first. Concretely, what the fixes look like:

- **Ask the browser, do not infer.** `document.elementFromPoint` at nine points across a
  control answers "can this be clicked" definitively. Overlapping boxes never did.
- **A `position: fixed` overlay covers whatever is under it AT THIS SCROLL OFFSET.** Scroll
  the full range before claiming anything is blocked. `layout.ts` §5 does, and it is
  deliberately the LAST section because it is the only one that moves the page — scrolling
  loads lazy images and fires reveal animations that would corrupt every rule above it.
- **Click the thing.** `no-mobile-navigation` finds every plausible hamburger, clicks it,
  and re-counts, so "there is no menu" is a demonstrated fact and not a failure to recognise
  someone's class names.
- **Prove the negative on a control group.** tailwindcss.com, getbootstrap.com,
  developer.mozilla.org, stripe.com, github.com, wikipedia.org and news.ycombinator.com all
  pass the mobile-nav check. Any rule that will fire across 357 templated sites gets this
  treatment before it ships — the control group caught **three** false positives that the
  target sites never would have (see below).

### Clicking a stranger's page: what the control group caught

`no-mobile-navigation` clicks candidate menu buttons to prove a hamburger is missing rather
than assuming it. Three separate bugs, none visible on the target sites:

| Symptom | Cause |
|---|---|
| stripe.com "menu does not open" | `cssPath` selectors are short and **not unique** — 5 candidates re-queried into **17 elements**, so it clicked through a testimonial carousel. Fixed by stamping `data-webip-toggle` on the exact nodes. |
| stripe.com still failing | `HTMLElement.click()` is an untrusted event with no pointer sequence; a framework menu listening for `pointerdown` never reacts. Use Playwright's real input-level click. |
| getbootstrap.com "menu does not open" | Clicking the header's **Search** button first opened a modal that covered the real "Toggle navigation" button, whose click then timed out. Fixed by ordering menu-looking candidates first and pressing Escape between attempts. |

Rules that follow from this, for any future check that interacts with a page:
- Click **one control at a time and re-check after each.** Clicking all of them and looking
  once is worse than useless — the second click closes what the first opened.
- **Undo** an attempt that did not help, Escape included, or the check's own side effects
  become the reason the next candidate fails.
- Never re-query a generated CSS path to act on an element. Mark the node, or hold a handle.
  Note `page.locator()` re-queries at click time, so it is **not** safe here: every survey
  clears and re-stamps the marks, and an index captured earlier then points somewhere else.
- "Did the menu open" must count link **elements**, not hrefs. Nearly every template repeats
  its nav in the footer, so "is /pricing visible" is already true before anything is clicked.
  A panel opening adds *another* anchor to the same href, and that increase is the signal —
  it survives both the footer copy and a menu portalled outside the header.

### findings.json layout (`schema: "webip/2"`)

Ordered conclusion → evidence: `integrity` → `stats` → `issues` → `findings` → `coverage`.
- **`issues`** — each defect ONCE, with `whatIsWrong`, `howToFix`, `standards`, `scope`
  (platform / widespread / tenant) and pinpointed `examples`. This is the fix plan.
- **`coverage`** — per page, per tool: ok / error / skipped. Kills the silent-corruption
  ambiguity below: a page with no findings is now provably clean, not merely unexamined.
- **`integrity.ok: false`** — a tool failed on *everything* it attempted, so its silence means
  "broken", not "clean". **Do not report from that run.** `printSummary` shouts it.

### Durability

`RunStream` appends every finding to `out/<dir>/stream.jsonl` as it is produced (one JSON
value per line, so a half-written final line costs one record). `npm run analyze` accepts
that `.jsonl` directly, so a run killed at hour eleven is still worth something.
The consolidated JSON is still the deliverable; the log is a write-ahead insurance policy.

### Rules the catalog owns

`src/core/catalog.ts` maps ANY rule → `{category, whatIsWrong, howToFix, standards}`.
Rules we invented (semantics/layout/fetch/lychee) are described exhaustively there because
no upstream docs exist. axe is handled by **decoding its own tags** (`wcag143` → SC 1.4.3),
which covers all 105 of its rules without a hand-written table.

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
- **No navigation on a phone.** The header ships `<div class="hidden md:flex">` around the nav
  links and **no menu button exists at any width** — 0 buttons in the header, verified by
  clicking. Below the `md` breakpoint the header is a logo and a bag icon; every other page is
  reachable only by scrolling to the footer. This is the platform template, so it is every
  tenant. Rule: `layout/no-mobile-navigation`.
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

Budget the browser lane at roughly `deepSites × maxPagesPerSite × 30s / browserConcurrency`,
**plus** `deepSites × maxPagesPerSite × ~18s` for Lighthouse, which is serialised.
`browserConcurrency` is **memory**-bound (~300MB/worker), not CPU-bound — this host has ~5.6GB.

### Known scaling limit: serialised Lighthouse

Lighthouse is process-wide serial (see above — it has to be), so it does not benefit from
`browserConcurrency` and becomes the browser lane's floor. At ~18s/page that is fine for the
current 120-page deep scan (~36 min) but would be ~34 hours if the browser lane were ever
pointed at all 6,800 pages.

The fix when that day comes is **worker_threads**, not more browsers: each thread gets its own
`perf_hooks` performance instance, so the User Timing collision disappears and Lighthouse can
run genuinely in parallel again. Do not attempt it with child browsers alone — the collision is
in the Node process, not in Chromium. Until then, `--no-lighthouse` is the escape hatch
(it is ~80% of browser-lane cost).
