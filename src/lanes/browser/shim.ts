/**
 * Making `page.evaluate` safe for compiled functions.
 *
 * tsx/esbuild compiles with keepNames, which rewrites every inner function as
 * `__name(fn, "fn")` to preserve `Function.prototype.name`. That helper is
 * defined in the Node module scope, so when Playwright serialises one of our
 * functions into the browser the reference is dangling and the whole evaluate
 * dies with "__name is not defined" -- inside the page, where the stack trace
 * is useless.
 *
 * Every module that evaluates a compiled function must install this first.
 */

import type { Page } from 'playwright';

/**
 * Installs an identity `__name` shim in the page.
 *
 * Passed as a STRING expression on purpose: a function argument would itself be
 * compiled by esbuild and could reference the very helper it is trying to
 * define. Playwright runs it through the debugger protocol, so it is not
 * subject to the page's Content-Security-Policy.
 */
export async function ensureNameShim(page: Page): Promise<void> {
  await page.evaluate(
    '(() => { if (typeof globalThis.__name !== "function") { globalThis.__name = function (f) { return f; }; } })()',
  );
}
