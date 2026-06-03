// Reflects the app's automation flags (read from local storage; synced from the app).
chrome.storage.local.get(["flags"], ({ flags }) => {
  if (!flags) return;
  const set = (id, on, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = on ? "on" : "off";
  };
  set("f-browser", flags.browser === "on", flags.browser ?? "off");
  set("f-mode", true, flags.mode ?? "capture");
  set("f-t3", (flags.tier3Sources ?? []).length > 0, (flags.tier3Sources ?? []).join(", ") || "none");
});
