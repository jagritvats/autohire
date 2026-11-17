// Shared extension settings (ES module: imported by the service worker, popup and
// options page). Stored in chrome.storage.local — never synced to other browsers.

export const DEFAULT_SERVER = "http://localhost:3000";

/** http(s) origin + optional path prefix, no trailing slash; null if unusable. */
export function normalizeServer(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** The host-permission pattern for a server URL. */
export function originPattern(serverUrl) {
  return `${new URL(serverUrl).origin}/*`;
}

/** Stored settings, normalised (blank → default server, no token). */
export async function getSettings() {
  const { serverUrl, apiToken } = await chrome.storage.local.get(["serverUrl", "apiToken"]);
  return {
    serverUrl: normalizeServer(serverUrl) ?? DEFAULT_SERVER,
    apiToken: typeof apiToken === "string" ? apiToken.trim() : "",
  };
}

export async function hasHostPermission(serverUrl) {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(serverUrl)] });
  } catch {
    return false;
  }
}
