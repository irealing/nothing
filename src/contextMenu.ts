// The desktop shell is a WebView, so right-click falls through to WebView2's
// own menu (refresh, print, save as, inspect…). None of that belongs to the
// app; in-app menus are Radix portals opened by React handlers and keep working
// because this only cancels the native default action.

/** Suppress the native context menu for the lifetime of the document. */
export function installContextMenuGuard(): () => void {
  const block = (event: MouseEvent) => event.preventDefault();
  // Capture phase: still runs if a component stops propagation later.
  document.addEventListener("contextmenu", block, { capture: true });
  return () => document.removeEventListener("contextmenu", block, { capture: true });
}