// Options page: configure the JobFlow server URL + API token (chrome.storage.local).
// A non-default server needs a runtime host permission (optional_host_permissions),
// requested here inside the Save click so Chrome shows its prompt.
import { DEFAULT_SERVER, getSettings, normalizeServer, originPattern } from "./settings.js";

const $ = (id) => document.getElementById(id);

function status(text, ok) {
  const el = $("status");
  el.textContent = text; // textContent: never HTML
  el.className = ok ? "ok" : "err";
}

async function load() {
  const { serverUrl, apiToken } = await getSettings();
  $("server").value = serverUrl;
  $("token").value = apiToken;
}

async function save(e) {
  e.preventDefault();
  const raw = $("server").value.trim() || DEFAULT_SERVER;
  const serverUrl = normalizeServer(raw);
  if (!serverUrl) return status("Enter an http(s) URL, e.g. http://localhost:3000", false);
  const token = $("token").value.trim();
  const insecure =
    !!token && serverUrl.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(serverUrl);
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern(serverUrl)] });
  } catch (err) {
    return status(`Permission request failed: ${err?.message ?? err}`, false);
  }
  if (!granted) return status(`Permission to contact ${new URL(serverUrl).origin} was not granted — not saved.`, false);
  await chrome.storage.local.set({ serverUrl, apiToken: token });
  $("server").value = serverUrl;
  if (insecure) status("Saved — but the token travels over plain http to a non-local host; prefer https.", false);
  else status("Saved.", true);
}

async function test() {
  status("Testing…", true);
  const res = await chrome.runtime.sendMessage({ type: "config" }).catch(() => null);
  if (res?.ok) status("Connected — the server answered.", true);
  else status(res?.error ?? "No answer from the extension's service worker.", false);
}

$("form").addEventListener("submit", save);
$("test").addEventListener("click", test);
load();
