---
name: Frontend Dependencies
description: 查询 node_modules 中 Glide Data Grid、Radix、CodeMirror、zustand、react-colorful、Tauri API 的类型签名、源码与真实行为；改网格/浮层/编辑器/store、追查怪行为或升级依赖时使用。
---

# 前端依赖速查

改网格、浮层、SQL 编辑器、store 之前先按这里的顺序查，不要直接翻 `node_modules`。

## 查询决策树

1. **查签名 / 枚举 / 必填属性** → 只读类型声明
   - Glide：`node_modules/@glideapps/glide-data-grid/dist/dts/index.d.ts`
   - 其余包：包根 `index.d.ts`，或 `dist/index.d.ts`
2. **查“怎么用”** → Glide 依次读 `API.md`、`src/docs/*.stories.tsx`（官方示例比源码短得多）
3. **查“为什么行为不对”** → 才进源码
   - Glide：`src/data-editor/data-editor.tsx`（prop 与回调语义）、`src/cells/`（draw / measure / overlay）、`src/common/styles.ts`（`Theme` 全部字段）、`CHANGELOG.md`
   - Radix / react-colorful：脚本从 source map 还原原始 TSX（仓库根目录执行）
     ```bash
     node .opencode/skills/frontend-deps/scripts/dep-source.mjs @radix-ui/react-popover --list
     node .opencode/skills/frontend-deps/scripts/dep-source.mjs @radix-ui/react-popover --find onPointerDownOutside
     node .opencode/skills/frontend-deps/scripts/dep-source.mjs @radix-ui/react-popover --file popover.tsx
     ```
   - Glide 等没有内嵌源码的包，同一个脚本会自动退回读包内 `src/**/*.tsx`
4. 版本、具体路径、本项目踩过的坑 → `references/frontend.md`

## 硬性规则

- **永远不要读** `dist/**/*.min.js`、`.cjs` bundle，也不要直接进 `node_modules/.pnpm` 的缓存路径。
- **不要凭记忆写依赖 API**：签名以 `.d.ts` 为准。本 skill 只记指路和坑，不复制签名。
- 先用 `--find` 定位行，再决定是否 `--file` 整篇读；不要一上来读完整个 `src/`。
- 查到非显然行为后，把结论写回 `references/frontend.md` 对应包下，让 skill 越用越省。

## 本项目既有约束（改依赖用法前先确认没违背）

- 网格单元格编辑用真实 `<input>`（`src/components/GridEditors.tsx`），所有可编辑列 `allowOverlay: false`：Glide 自带 overlay 编辑器在中文 IME 下不可用。
- canvas 没有 DOM 锚点：Radix 浮层用 `.virtual-anchor`（`src/styles.css`）当 trigger，浮层统一走 `src/ui/` 包装。
- Glide 不读 CSS 变量：`Theme` 由 `src/theme/grid.ts` 从 token 推导，`TableView.tsx` 按 `resolvedTheme` 重算。
- 颜色只引用 token；`ColumnColor` 为 18 色预设 + `#rrggbb`（自定义色推导在 `src/theme/color.ts`）。
- zustand 是裸 `create<State>()`，没有 persist / subscribeWithSelector 中间件；本地偏好写 `localStorage`（`src/stores/theme.ts`、`layout.ts`）。

## 版本守卫

`pnpm deps:check` 校验 `references/deps.json` 记录的版本与路径是否仍准确。升级依赖后：

```bash
pnpm deps:check             # 看哪些包 / 路径对不上
pnpm deps:check --update    # 只刷新版本号；路径与说明仍需人工复核
```

然后按提示核对 `references/frontend.md` 里的说明是否还成立。