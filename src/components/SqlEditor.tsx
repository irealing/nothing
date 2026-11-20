import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";

/** Small shared CodeMirror 6 editor preset for SQL. */
export function SqlEditor({
  value,
  onChange,
  height = "120px",
}: {
  value: string;
  onChange: (v: string) => void;
  height?: string;
}) {
  return (
    <div className="sql-editor">
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
