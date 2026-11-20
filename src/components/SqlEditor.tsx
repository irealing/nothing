import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";

/** Small shared CodeMirror 6 editor preset for SQL. */
export function SqlEditor({
  value,
  onChange,
  onRun,
  height = "120px",
}: {
  value: string;
  onChange: (v: string) => void;
  /** Ctrl/Cmd + Enter. Optional so the create-view dialog stays edit-only. */
  onRun?: () => void;
  height?: string;
}) {
  return (
    <div
      className="sql-editor"
      onKeyDown={(e) => {
        if (onRun && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          onRun();
        }
      }}
    >
      <CodeMirror
        value={value}
        height={height}
        extensions={[sql()]}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          bracketMatching: true,
          autocompletion: true,
        }}
      />
    </div>
  );
}
