import { useWorkspace } from "./stores/workspace";
import Welcome from "./components/Welcome";
import Sidebar from "./components/Sidebar";
import TableView from "./components/TableView";
import SqlResultTable from "./components/SqlResultTable";
import ErrorToast from "./components/ErrorToast";

export default function App() {
  const info = useWorkspace((s) => s.info);
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
        {activeView?.kind === "sql" ? <SqlResultTable /> : <TableView />}
      </main>
      <ErrorToast />
    </div>
  );
}
