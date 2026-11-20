// Runs before first paint (classic blocking script) so the resolved theme is
// on <html data-theme> without a flash of the wrong theme.
// Kept CSP-friendly: external file, no inline script.
(function () {
  try {
    var pref = localStorage.getItem("nothing.theme") || "system";
    var dark =
      pref === "dark" ||
      (pref === "system" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();