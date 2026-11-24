// CodeMirror theme for the SQL editor.
//
// Every colour is a CSS variable, so light/dark switching is instant and needs
// no editor reconfiguration. `@uiw/react-codemirror`'s built-in "light" theme
// hard-codes a white background, which is why the editor used to stay white in
// dark mode — passing this extension replaces it entirely.

import { EditorView, type Extension } from "@uiw/react-codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const editorChrome = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg)",
      color: "var(--text)",
      fontSize: "13px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      lineHeight: "1.6",
    },
    ".cm-content": {
      caretColor: "var(--text)",
      padding: "8px 0",
    },
    ".cm-gutters": {
      backgroundColor: "var(--surface-sunken)",
      color: "var(--text-weak)",
      borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--bg-hover)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--bg-active)",
      color: "var(--text-mid)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "var(--selection)",
      },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--text)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "var(--accent-weak)",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--search-highlight)",
      outline: "1px solid var(--accent-border)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "var(--selection)",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "var(--accent-weak)",
      outline: "1px solid var(--accent-border)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--surface-raised)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      color: "var(--text)",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--accent-weak)",
      color: "var(--text)",
    },
    ".cm-panels": {
      backgroundColor: "var(--surface-sunken)",
      color: "var(--text)",
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: "1px solid var(--border)",
    },
    ".cm-textfield": {
      backgroundColor: "var(--bg)",
      border: "1px solid var(--border)",
      color: "var(--text)",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--bg-hover)",
      border: "1px solid var(--border)",
      color: "var(--text)",
    },
  },
  { dark: false },
);

const syntax = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier],
    color: "var(--syntax-keyword)",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "var(--syntax-string)",
  },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: "var(--syntax-number)",
  },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: "var(--text-weak)",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--syntax-function)",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: "var(--syntax-type)",
  },
  {
    tag: [tags.operator, tags.punctuation, tags.bracket],
    color: "var(--text-mid)",
  },
  {
    tag: [tags.variableName, tags.propertyName, tags.attributeName],
    color: "var(--text)",
  },
  {
    tag: tags.invalid,
    color: "var(--danger)",
  },
]);

/** Token-driven SQL editor theme shared by every CodeMirror surface. */
export const nothingEditorTheme: Extension = [editorChrome, syntaxHighlighting(syntax)];