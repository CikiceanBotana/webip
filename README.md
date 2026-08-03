# webip

A two-lane web inspection tool.

| Lane | Browser? | Handles |
| --- | --- | --- |
| **Fast HTTP lane** (`src/lanes/http/`) | No | links, assets, HTML validity, static semantics |
| **Slow browser lane** (`src/lanes/browser/`) | Chromium | anything needing layout: geometry, contrast, overlap, overflow |

**There is no image diffing in this project.** Screenshots are captured only as
evidence attached to findings, and are never compared against a baseline.

Eleven checks across both lanes normalise into one vocabulary, so a finding from
the W3C validator and a finding from a hand-written geometry probe are sorted,
deduplicated and explained the same way.

**What it detects, with real output for every claim:
[`docs/CAPABILITIES.md`](./docs/CAPABILITIES.md).** Every example there is
lifted verbatim from a scan of four live sites — none of it is illustrative.

---

## Prerequisites

| Requirement | Needed for | Notes |
| --- | --- | --- |
| **Node.js 22.23.2** | everything | Exact version in `.nvmrc`. Use `nvm use`. |
| **Java 17+** (`java` on `PATH`) | `vnu-jar` only | **Optional.** Not installed system-wide by this project. Without it the Nu validator step skips with a clear message; everything else still runs. The Docker image bundles a JRE, so the container never needs a host JRE. |
| **Docker** | container runs only | Optional. |

```bash
nvm use            # reads .nvmrc -> 22.23.2
```

## Install

```bash
nvm use
npm ci                        # exact versions from package-lock.json
npx playwright install chromium
./scripts/install-lychee.sh   # fetches the pinned lychee binary into ./bin/
```

> **Gotcha:** if `NODE_ENV=production` is exported in your shell, npm treats it
> as `--omit=dev` and **silently skips devDependencies** — including `tsx`,
> which `npm run smoke` needs. It still writes them into `package.json`, so the
> failure looks like `tsx: not found`. Use `npm ci --include=dev`, or unset
> `NODE_ENV` first.

### On system browser dependencies

The documented command is:

```bash
npx playwright install --with-deps chromium
```

`--with-deps` shells out to `sudo apt-get` to install Chromium's shared
libraries. **On a machine without passwordless sudo it fails before downloading
anything.** If that happens, install the browser alone:

```bash
npx playwright install chromium
```

…and then confirm Chromium actually launches (`npm run smoke`, step 1). On a
normal Ubuntu desktop the libraries are already present, so the apt step is a
no-op. If Chromium fails to launch, install the libraries once, manually:

```bash
sudo npx playwright install-deps chromium
```

## Commands

| Command | Does |
| --- | --- |
| `npm run scan -- <url\|--config f>` | Runs both lanes. Exits non-zero if anything critical or serious was found. |
| `npm run analyze -- <findings.json\|stream.jsonl>` | Prints the fix plan: platform-wide vs tenant-specific. |
| `npm run examples -- <findings.json>` | Regenerates the worked examples in `docs/examples/` from a run. |
| `npm test` | Unit tests for the report invariants (`node:test`, no framework to install). |
| `npm run smoke` | Proves every tool is callable. Exits non-zero on any failure. |
| `npm run versions` | Regenerates `versions.json` from what is installed on disk. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run install:lychee` | Re-fetches the pinned lychee binary. |

```bash
npm run scan -- https://example.com --fast-only
npm run scan -- --config config/sogood.json --out out/pilot
npm run analyze -- out/pilot/findings.json
```

## Output

Every run writes three things to `--out`:

| File | What |
| --- | --- |
| `findings.json` | The consolidated record. **This is the deliverable.** |
| `report.html` | The same data, self-contained, readable in a browser. |
| `stream.jsonl` | Write-ahead log, appended as findings are produced. |

`findings.json` (`schema: "webip/2"`) is ordered conclusion → evidence:

| Key | What it answers |
| --- | --- |
| `integrity` | *Can this run be trusted at all?* `ok: false` means a tool failed on everything it attempted — its silence means "broken", not "clean". |
| `stats` | Totals by severity, category and tool. `occurrencesTotal` is the true count; `findingsTotal` is rows. |
| `issues` | **The fix plan.** Each defect once, with `whatIsWrong`, `howToFix`, `standards`, `scope` (platform/widespread/tenant) and pinpointed `examples`. |
| `findings` | Every rule on every page, with `instances[]` — each carrying `selector`, `snippet`, `line`/`column`, `target` and `measured` vs `expected`. |
| `coverage` | Per page, per tool: `ok` / `error` / `skipped`. Proves a zero-finding page was checked rather than merely skipped. |
| `errors` | Problems with the scan itself, not with the site. |

A finding never says only *how many*. `count` is the true total and `instances`
names the occurrences (capped at 50, flagged with `instancesTruncated`), so
"14 tap targets too small" comes with the selector and measured size of each.

If a run is killed, `stream.jsonl` still holds everything produced up to that
moment — one JSON value per line, so a half-written final line costs one record.
`npm run analyze` reads it directly.

## Layout

```
src/core/            finding vocabulary, catalog, rollup, coverage, streaming, report
src/discover/        seed -> sites -> pages
src/lanes/http/      browser-free checks
src/lanes/browser/   chromium checks
src/orchestrator.ts  runs both lanes concurrently; contains no checking logic
src/fingerprint/     reserved; empty
bin/                 downloaded binaries (lychee) — gitignored
config/              per-target config
out/                 run output — gitignored
out/evidence/        screenshots attached to findings
scripts/             analyzer, smoke test, version manifest, installers
tests/               invariant tests
```

## Toolchain

Every JS dependency is pinned to an exact version. `.npmrc` sets
`save-exact=true`, so a caret range cannot leak into `package.json` even from a
future `npm install`. `package-lock.json` is committed. The authoritative,
machine-generated record is [`versions.json`](./versions.json).

| Tool | Version | Lane |
| --- | --- | --- |
| node | 22.23.2 | — |
| npm | 10.9.8 | — |
| crawlee | 3.17.0 | both |
| playwright | 1.62.1 | browser |
| @playwright/test | 1.62.1 | browser |
| Chromium (via Playwright) | **151.0.7922.34** (revision `1234`) | browser |
| cheerio | 1.2.0 | fast |
| axe-core | 4.12.1 | browser |
| @axe-core/playwright | 4.12.1 | browser |
| accessibility-checker (IBM equal-access) | 4.0.29 | browser |
| lighthouse | 13.4.1 | browser |
| html-validate | 11.6.2 | fast |
| vnu-jar (W3C Nu) | 26.7.31 | fast (needs JRE) |
| lychee | 0.24.2 | fast |
| typescript | 7.0.2 | dev |
| tsx | 4.23.5 | dev |
| @types/node | 22.20.1 | dev |

**`@types/node` is intentionally pinned to the 22.x line, not the newest
release.** The latest is 26.x, which describes APIs that do not exist in the
Node 22 runtime this project targets. Types must match the runtime.

### lychee

lychee is a Rust binary, not an npm package, so it cannot live in
`package-lock.json`. It was installed from the **official prebuilt binary**
(`github.com/lycheeverse/lychee/releases`) into `./bin/lychee`, with its
SHA-256 verified against the checksum published alongside the release. The
Docker image fallback was never needed. `scripts/install-lychee.sh` is the
reproducibility record — version and checksum are pinned there, in the
`Dockerfile`, and in `versions.json`.

`bin/` is gitignored; rerun `./scripts/install-lychee.sh` on a fresh clone.

## Docker

```bash
docker build -t webip:0.0.0 .
docker run --rm --init --shm-size=1gb webip:0.0.0
```

The base image is `mcr.microsoft.com/playwright:v1.62.1-noble` — pinned to the
exact installed Playwright version, never `:latest`. The tag was verified to
resolve on MCR before it was written into the Dockerfile.

The image adds three things the base does not have:

- **tini** as PID 1, for zombie reaping. Chromium forks aggressively and
  Playwright terminates subprocesses abruptly; with no reaper the container
  accumulates `<defunct>` processes until it hits the PID limit. `--init` does
  the same job, and both are wired up so the image is safe either way.
- **A JRE** (`openjdk-17-jre-headless`), required by `vnu-jar`. Installed only
  inside the image; the host is left alone.
- **lychee**, pinned and checksum-verified at build time.

It runs as the base image's non-root `pwuser`.

### `--shm-size=1gb` is required

Docker defaults `/dev/shm` to 64MB. Chromium maps renderer surfaces and shared
buffers there, and under load it exhausts 64MB and dies mid-navigation with
`SIGBUS` / "Target crashed". The usual workaround, `--disable-dev-shm-usage`,
moves those buffers to disk and slows down exactly the layout work the browser
lane exists to do. Raise the limit instead.

## Smoke test

`npm run smoke` mirrors the two-lane architecture: the browser lane (steps 1–5)
shares one Chromium instance and runs sequentially, while the fast lane
(steps 6–8) needs no browser and runs concurrently alongside it. Output is
buffered per step and printed in order, so concurrency never scrambles the
report.

| # | Tool | Proves |
| --- | --- | --- |
| 1 | playwright + chromium | launches, loads `example.com`, non-empty `<title>` |
| 2 | axe-core | injected into the page; rule count read from inside the page |
| 3 | accessibility-checker | rule count, and a real run against the live page |
| 4 | lighthouse | drives Chromium over CDP, returns a performance score |
| 5 | screenshot | full-page PNG written to `out/evidence/`, non-zero size |
| 6 | fetch + cheerio | **no browser** — proves the fast lane works end to end |
| 7 | lychee | binary runs against `example.com`, prints exit code |
| 8 | vnu-jar | flags ≥1 error in deliberately invalid HTML; skips without a JRE |

Steps 4 and 8 both run while memory is under contention, so the Nu validator's
JVM heap is capped (`-Xmx256m`) to keep it from competing with Chromium on small
machines.

Environment overrides: `WEBIP_CDP_PORT` (default `9333`), `WEBIP_LYCHEE_BIN`
(default `./bin/lychee`).
