/**
 * Refuses an apiUrl that would send passwords and session tokens unencrypted.
 * Pure (no window access), so it can be unit tested; config.ts applies it.
 */

/** Hosts whose traffic never leaves the machine, so plain http:// is acceptable. */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Returns an error message when `apiUrl` is not safe to use, or null.
 * Empty means "same origin as the page" and is checked by the page's own protocol.
 */
export function apiUrlError(apiUrl: string): string | null {
  if (!apiUrl) return null;
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return `apiUrl in client-config.js is not a valid URL: "${apiUrl}".`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    if (isLoopback(url.hostname)) return null;
    return (
      `apiUrl in client-config.js uses unencrypted http:// (${url.origin}). ` +
      `Use https:// so that passwords and sessions are not sent in clear text.`
    );
  }
  return `apiUrl in client-config.js must start with https:// (got ${url.protocol}//).`;
}
