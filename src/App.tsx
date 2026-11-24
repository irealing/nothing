import { useEffect } from "react";
import * as ipc from "./ipc";
import { baseName, samePath, useWorkspace } from "./stores/workspace";
import { useTheme } from "./stores/theme";
import { confirm } from "./ui/ConfirmDialog";
import { t } from "./i18n";
import Welcome from "./components/Welcome";
import Sidebar from "./components/Sidebar";
import TableView from "./components/TableView";
import SqlViewPanel from "./components/SqlViewPanel";
import ScratchQueryPanel from "./components/ScratchQueryPanel";
import ViewTabs from "./components/ViewTabs";
import Toasts from "./components/Toasts";
import TopProgress from "./components/TopProgress";
import { ConfirmHost } from "./ui/ConfirmDialog";
import { TooltipProvider } from "./ui/Tooltip";

export default function App() {
  const info = useWorkspace((s) => s.info);
  const tables = useWorkspace((s) => s.tables);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const views = useWorkspace((s) => s.views);
  const scratchOpen = useWorkspace((s) => s.scratch.open);
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  // Subscribing here keeps the document theme/scheme in sync with the preference.
  useTheme((s) => `${s.resolved}:${s.scheme}`);

  useEffect(() => {
    void useWorkspace.getState().boot();
    // A `.nothing` file opened from the shell while we are running: switch to
    // it (asking first when another workspace is already open).
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void ipc.onOpenRequest((path) => void handleExternalOpen(path)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function handleExternalOpen(path: string) {
    const store = useWorkspace.getState();
    // The path arrives by event; the Rust-side queue only matters for a cold
    // start, so drop it to keep that slot from going stale.
    void ipc.takeOpenRequest().catch(() => {});
    if (!store.info) {
      store.requestPath(path);
      return;
    }
    if (samePath(store.info.path, path)) return; // already open
    const ok = await confirm({
      title: t("welcome.switchTitle"),
      description: t("welcome.switchConfirm", { name: baseName(path) }),
      confirmLabel: t("welcome.switchAction"),
    });
    if (!ok) return;
    await store.closeWorkspace();
    if (!useWorkspace.getState().info) useWorkspace.getState().requestPath(path);
  }

  if (!info) {
    return (
      <TooltipProvider delayDuration={400}>
        <TopProgress />
        <Welcome />
        <Toasts />
        <ConfirmHost />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <TopProgress />
      <div className="layout">
        <Sidebar />
        <main className="content">
          {!scratchOpen && (activeTableId || views.some((v) => v.kind === "sql")) && (
            <ViewTabs hasTable={tables.length > 0} />
          )}
          {scratchOpen ? (
            <ScratchQueryPanel />
          ) : activeView?.kind === "sql" ? (
            <SqlViewPanel view={activeView} />
          ) : (
            <TableView />
          )}
        </main>
        <Toasts />
      </div>
      <ConfirmHost />
    </TooltipProvider>
  );
}