/**
 * The browser-free HTTP primitive.
 *
 * Used by both URL discovery and the fast lane, so a page is never fetched
 * twice with subtly different headers or timeouts.
 */

export const USER_AGENT = 'webip/0.1 (+web inspection tool)';

export interface FetchedPage {
  url: string;
  /** After redirects. Differs from `url` when the server redirected. */
  finalUrl: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  /** Total wall-clock for the request, ms. */
  durationMs: number;
  /** Bytes of the decoded body. */
  bytes: number;
}

export interface FetchOptions {
  timeoutMs?: number;
  /** HEAD is useful for probing; the fast lane always uses GET. */
  method?: 'GET' | 'HEAD';
  accept?: string;
}

/**
 * Fetches a URL and returns a normalised result. Network-level failures throw;
 * HTTP error statuses do not (a 404 is data the fast lane wants to report on,
 * not an exception).
 */
export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const started = Date.now();
  const response = await fetch(url, {
    method: opts.method ?? 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': USER_AGENT,
      accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const body = opts.method === 'HEAD' ? '' : await response.text();

  return {
    url,
    finalUrl: response.url || url,
    status: response.status,
    ok: response.ok,
    headers,
    body,
    durationMs: Date.now() - started,
    bytes: Buffer.byteLength(body),
  };
}

/** Origin of a URL, or the input unchanged if it will not parse. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Short human label for a site, e.g. "https://pawdium.sogood.business" -> "pawdium". */
export function labelOf(siteUrl: string): string {
  try {
    const { hostname } = new URL(siteUrl);
    const first = hostname.replace(/^www\./, '').split('.')[0];
    return first && first.length > 0 ? first : hostname;
  } catch {
    return siteUrl;
  }
}

/** True when the URL is http(s) and parseable. */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Resolves `href` against `base`, returning null when it is not a usable page link. */
export function resolveLink(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '' || /^(#|mailto:|tel:|javascript:|data:)/i.test(trimmed)) return null;
  try {
    const resolved = new URL(trimmed, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}
