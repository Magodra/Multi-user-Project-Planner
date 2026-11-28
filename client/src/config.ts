/** Read once at startup from client-config.js; the server URL is never hard-coded. */
import { apiUrlError } from "./apiUrlCheck";

declare global {
  interface Window {
    PLANNING_CLIENT_CONFIG?: { apiUrl?: string };
  }
}

export const isFileMode = window.location.protocol === "file:";

function resolveApiUrl(): string {
  const configured = window.PLANNING_CLIENT_CONFIG?.apiUrl?.trim() ?? "";
  return configured.replace(/\/+$/, "");
}

/** Base URL of the application server; empty = same origin. */
export const apiUrl = resolveApiUrl();

/**
 * Set when the client must not talk to the server: no server URL in file mode, or one
 * that would send passwords and tokens unencrypted. Requests are refused while it is set.
 */
export const configError =
  isFileMode && !apiUrl
    ? "Set apiUrl in client-config.js to the planning server URL to use the client from the file system."
    : apiUrlError(apiUrl);

export function webSocketUrl(): string {
  const base = apiUrl || window.location.origin;
  return `${base.replace(/^http/, "ws")}/ws`;
}
