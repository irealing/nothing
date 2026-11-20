import { useWorkspace } from "./stores/workspace";
import Welcome from "./components/Welcome";
import Sidebar from "./components/Sidebar";
import TableView from "./components/TableView";
import SqlViewPanel from "./components/SqlViewPanel";
import ViewTabs from "./components/ViewTabs";
import ErrorToast from "./components/ErrorToast";

export default function App() {
  const info = useWorkspace((s) => s.info);
  const activeTableId = useWorkspace((s) => s.activeTableId);
  const activeViewId = useWorkspace((s) => s.activeViewId);
  const views = useWorkspace((s) => s.views);
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  if (!info) {
    return (
      <>
        <Welcome />
        <ErrorToast />
      </>
    );
  }

  return (
    <div className="layout">
      <Sidebar />
      <main className="content">
        {activeTableId && <ViewTabs />}
        {activeView?.kind === "sql" ? (
          <SqlViewPanel view={activeView} />
        ) : (
          <TableView />
        )}
      </main>
      <ErrorToast />
    </div>
  );
}
