// Runs before first paint (classic blocking script) so the resolved theme is
// on <html data-theme> without a flash of the wrong theme.
// Kept CSP-friendly: external file, no inline script.
(function () {
  var pref = "system";
  try {
    var raw = localStorage.getItem("nothing.theme") || "system";
    if (raw === "light" || raw === "dark" || raw === "system") {
      // Older builds stored a bare preference string.
      pref = raw;
    } else {
      // Newer builds stored JSON; a removed `scheme` field is ignored.
      var parsed = JSON.parse(raw);
      if (parsed && (parsed.preference === "light" || parsed.preference === "dark" || parsed.preference === "system")) {
        pref = parsed.preference;
      }
    }
  } catch (e) {
    // Storage unavailable or malformed: fall back to the system preference.
  }
  var dark =
    pref === "dark" ||
    (pref === "system" &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();