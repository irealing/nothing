import { useWorkspace } from "./stores/workspace";
import { useTheme } from "./stores/theme";
import Welcome from "./components/Welcome";
import Sidebar from "./components/Sidebar";
import TableView from "./components/TableView";
import SqlViewPanel from "./components/SqlViewPanel";
import ViewTabs from "./components/ViewTabs";
import ErrorToast from "./components/ErrorToast";
import { ConfirmHost } from "./ui/ConfirmDialog";
import { TooltipProvider } from "./ui/Tooltip";

export default function App() {
  const info = useWorkspace((s) => s.info);
  const tables = useWorkspace((s) => s.tables);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const views = useWorkspace((s) => s.views);
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  // Subscribing here keeps the document theme in sync with the preference.
  useTheme((s) => s.resolved);

  if (!info) {
    return (
      <TooltipProvider delayDuration={400}>
        <Welcome />
        <ErrorToast />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div className="layout">
        <Sidebar />
        <main className="content">
          {(activeTableId || views.some((v) => v.kind === "sql")) && (
            <ViewTabs hasTable={tables.length > 0} />
          )}
          {activeView?.kind === "sql" ? <SqlViewPanel view={activeView} /> : <TableView />}
        </main>
        <ErrorToast />
      </div>
      <ConfirmHost />
    </TooltipProvider>
  );
}