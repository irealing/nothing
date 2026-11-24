# 前端依赖速查表

版本以 `node_modules/<pkg>/package.json` 的实际安装值为准（`pnpm deps:check` 会校验）。路径都相对于 `node_modules/<pkg>/`，除非显式写了仓库内路径。

## 总表

| 包 | 已安装版本 | 类型入口 | 行为源码 | 备注 |
|---|---|---|---|---|
| `@glideapps/glide-data-grid` | 6.0.3 | `dist/dts/index.d.ts`（216 KB / 164 文件） | `API.md`（74 KB）→ `src/docs/*.stories.tsx` → `src/data-editor/data-editor.tsx`、`src/cells/`、`src/common/styles.ts` | 直接发布 `src/`（973 KB）；`dist` 里 246 个 `.map` **没有** `sourcesContent` |
| `@radix-ui/react-dialog` | 1.3.1 | `dist/index.d.ts` | `dep-source.mjs`（`dist/index.mjs.map` 带原始 TSX） | 不发 `src/` |
| `@radix-ui/react-dropdown-menu` | 2.2.1 | `dist/index.d.ts` | 同上 | 同上 |
| `@radix-ui/react-popover` | 1.3.1 | `dist/index.d.ts` | 同上 | 同上 |
| `@radix-ui/react-select` | 2.4.1 | `dist/index.d.ts` | 同上 | 同上 |
| `@radix-ui/react-tooltip` | 1.4.1 | `dist/index.d.ts` | 同上 | 同上 |
| `@uiw/react-codemirror` | 4.25.12 | `esm/index.d.ts`、`esm/useCodeMirror.d.ts` | `src/useCodeMirror.ts`（源码随包发布，`dep-source.mjs` 可读） | 别读 `dist/codemirror.min.js` |
| `@codemirror/lang-sql` | 6.10.0 | `dist/index.d.ts` | `dist/index.js` | 只用 `sql()` 扩展 |
| `@codemirror/language` | 6.13.1 | `dist/index.d.ts` | `dist/index.js` | 只用 `HighlightStyle` / `syntaxHighlighting` |
| `@lezer/highlight` | 1.2.5 | `dist/index.d.ts` | `dist/index.js` | 只用 `tags` |
| `zustand` | 5.1.0 | `react.d.ts`、`vanilla.d.ts`、`middleware.d.ts`、`react/shallow.d.ts` | `esm/*.mjs` | `package.json` 写 `^5.0.8`，实际 5.1.0 |
| `react-colorful` | 5.8.1 | `dist/index.d.ts` | `dep-source.mjs react-colorful` | 只用 `HexColorPicker` |
| `@tauri-apps/api` | 2.12.5 | `core.d.ts`、`event.d.ts` 等 | 客户端契约；**真源是 `src-tauri/commands.rs`** | `package.json` 写 `^2.9.0` |
| `@tauri-apps/plugin-dialog` | 2.8.4 | `dist-js/index.d.ts` | 同上 | 只用 `open` / `save` |

## 本项目用法与已知坑

### @glideapps/glide-data-grid

- 现有用法集中在 `src/components/TableView.tsx`（约 1500 行），自定义选项胶囊在 `src/components/OptionCell.tsx`，主题桥接在 `src/theme/grid.ts`。
- 回调一览（`API.md` 的 “Full API Docs” 比 `d.ts` 更好搜）：`getCellContent`、`onCellEdited`、`onCellsEdited`、`onCellClicked`、`onCellActivated`、`onCellContextMenu`、`onPaste`、`onDelete`、`onHeaderClicked`、`onHeaderContextMenu`、`onHeaderMenuClick`、`onColumnResize(Start|End)`、`onColumnMoved`、`onVisibleRegionChanged`、`onItemHovered`、`onRowAppended`、`onGridSelectionChange`、`customRenderers`、`rowMarkers`、`freezeColumns`。
- 列头三角菜单：必须是列定义 `hasMenu: true` **且** 传 `onHeaderMenuClick`；缺任一都不会有反馈（只在 `hasMenu` 为真时渲染三角）。
- 编辑器：默认 overlay 编辑器（`provideEditor`）在中文 IME 下不可用，本项目所有可编辑列 `allowOverlay: false`，改用 `GridEditors.tsx` 浮层输入框。要加新列类型时先确认这一条。
- `Theme` 全部字段在 `src/common/styles.ts:51`；默认值由 `getDataEditorTheme` 提供，经 `src/index.ts:41` 重导出为 `getDefaultTheme`。Glide 不读 CSS 变量，切主题必须重算 `Theme`（`TableView.tsx` 的 `useMemo(..., [resolvedTheme])`）。
- Custom cell：`isMatch` 只按 `cell.kind === GridCellKind.Custom` + `data.kind` 判别；`copyData` 决定复制到剪贴板的内容；`draw` 里的 `args.theme` 是合并后的主题，`rect` 已含单元格边界。
- `src/docs/*.stories.tsx` 是官方示例（编辑、主题、菜单、搜索、复制粘贴），查用法比读 `data-editor.tsx` 快一个数量级。

### @radix-ui/*

- 项目封装：`src/ui/Dialog.tsx`（Dialog + 派生 `PanelDialog`）、`Menu.tsx`、`Popover.tsx`、`Tooltip.tsx`、`Field.tsx`（Select）。业务里 `src/components/CellEditors.tsx`、`src/ui/ColumnPickers.tsx` 直接用 Popover 原语。
- canvas 网格里没有 DOM 锚点：Popover 的 trigger 用 `.virtual-anchor`（`src/styles.css:4034`），位置由单元格坐标算出。
- 查 dismiss / focus / pointer 行为：`node .../dep-source.mjs @radix-ui/react-popover --find <symbol>`，源码里会看到依赖 `DismissableLayer`、`FocusScope`、`Popper`，需要时再对这些包执行同一命令。
- 包装约定：浮层只走 `src/ui/`，禁止组件里手写 `modal-backdrop` / `dropdown-menu` / `window.confirm`。

### @uiw/react-codemirror + CodeMirror

- 只有 `src/components/SqlEditor.tsx` 用它；主题在 `src/theme/codemirror.ts`，颜色全走 CSS 变量，切主题无需重建编辑器。
- 包内直接带 `src/`（7 个文件），查 `useCodeMirror` 的 props 合并逻辑用 `dep-source.mjs @uiw/react-codemirror --file useCodeMirror.ts`。
- `EditorView.theme()` 里的选择器作用于编辑器内部 DOM；`HighlightStyle` 用 `@lezer/highlight` 的 `tags` 映射 token。

### zustand

- `src/stores/workspace.ts` 是裸 `create<WorkspaceState>()`，没有中间件；选择器返回对象时默认 `Object.is` 比较，会每次渲染都变。需要浅比较时用 `useShallow`（`zustand/react/shallow`），但当前项目里没有先例，优先拆成多个单值选择器。
- 持久化不走 zustand：本地偏好在 `theme.ts` / `layout.ts` 里直接读写 `localStorage`。

### react-colorful

- 只用 `HexColorPicker`（`src/ui/ColumnPickers.tsx`）。颜色值的规范化（`#rrggbb`、非法输入、预设 token 判定）在 `src/theme/color.ts`，不在依赖里。

### @tauri-apps/api

- 前端只通过 `src/ipc/` 调用；命令签名与参数校验的真源是 `src-tauri/commands.rs`，`@tauri-apps/api` 的 `.d.ts` 只有 invoke/channel 等基础设施。
- 文件对话框走 `@tauri-apps/plugin-dialog`（`open` / `save`）。

## 升级依赖后的流程

1. `pnpm install`
2. `pnpm deps:check`，按报错改 `references/deps.json` 的版本 / 路径
3. 复核本文件里对应的“坑”是否还成立（尤其 Glide 回调名与 `Theme` 字段）
4. 跑 `pnpm test` 与 `pnpm build`

## 维护约定

- 新增强依赖时，在 `deps.json` 加条目（版本 + 至少一个类型入口路径），并在本文件补一行表格。
- 只写“指路 + 坑”，不复制函数签名；签名以 `.d.ts` 为准。
- `deps.json` 里 `"ignore"` 列出不打算纳入速查表的运行时依赖（如 `react`、`react-dom`、`@radix-ui/colors`）。