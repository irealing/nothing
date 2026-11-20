# AGENTS.md

本文件是 AI 协作代理（及人类开发者）在 nothing 代码库中工作的规范。**违反"铁律"章节的规则可能直接导致用户数据损坏，任何改动前请先通读。**

## 项目简介

nothing 是一个 Tauri v2 桌面应用：本地优先、SQLCipher 加密的 Notion 式**纯表格**工具。核心思想是把 Notion 的表格体验映射到真实 SQLite 特性上（真实列类型、CHECK 约束、Generated Column、FTS5、真外键级联、真 VIEW），拒绝 EAV 反模式。

产品范围：**只做表格**。不要引入文档、看板、日历等其他 block 类型的功能。

## 目录结构（现状）

Cargo workspace：存储内核是独立 crate，**不依赖 Tauri**，可单独编译测试；Tauri 壳（M3）只做薄转发。

```
Cargo.toml               workspace 根
crates/nothing-core/     存储内核（纯 Rust，M1/M2 的主战场）
  src/
    db/                  Workspace：加密连接管理（单写者 Mutex）、密码、迁移入口
      migrate.rs         _nothing 清单表、V1 元数据 schema、format_version 迁移
    schema/
      ident.rs           ULID、t_/c_/r_/v_ 物理命名、quote_ident/quote_literal（唯二转义原语）
      mod.rs             元数据类型（TableMeta/ColumnMeta/ViewMeta、ColumnOpts、视图配置）
      table.rs           表/列 CRUD、12 步表重建（fk off）、级联清理
      column.rs          物理 DDL 生成、junction 表、类型转换表达式
      formula.rs         公式白名单编译器（递归下降 → SQL 表达式）
      fts.rs             FTS5 外部内容表 + 触发器（trigram 分词，支持中文子串）
      view.rs            grid/SQL 视图 CRUD、SQL 语句白名单校验
    query/
      mod.rs             Row/RowPage/SqlResult 类型、JSON↔SQLite 值转换
      compiler.rs        grid 视图筛选树/排序 → 参数化 SQL（值永不进 SQL 文本）
      rows.rs            行 CRUD、junction 关系写入、批量更新
      run.rs             run_view/run_sql/search、关联批量标题解析（防 N+1）
  tests/                 集成测试（直接操作真实加密临时库）
src-tauri/               （M3 添加）Tauri 薄壳：commands/ 只做参数校验与转发
/                        （M3 添加）前端 React + TS + Vite
  src/components/        业务组件（表格、视图标签、弹窗内容、筛选面板…）
  src/ui/                浮层与表单原语（Radix 驱动的 Dialog/Menu/Popover/Tooltip/Field）
  src/stores/            zustand store（workspace 数据、theme 外观偏好）
  src/theme/             CSS token ↔ Glide Data Grid 主题桥接、列调色板
  src/i18n/              唯一文案来源（zh.ts）+ t() + 日期/数字格式化
  src/ipc/               前端唯一与后端通信的入口
```

## 数据库 Schema 与命名约定

每个工作区 = 一个 `.nothing` 文件（SQLCipher 加密的 SQLite 库）。

| 对象 | 命名 | 说明 |
|---|---|---|
| 清单表 | `_nothing` | key-value：`magic`（固定 `nothing-db`）、`format_version`、`created_at`、`created_by`。文件身份识别与迁移入口 |
| 元数据表 | `_tables` `_columns` `_views` | `_` 前缀，全部 `STRICT` 模式 |
| 用户表 | `t_<table_id>` | `table_id` 为 ULID |
| 用户表列 | `_rid` `_created` `_updated` + `c_<column_id>` | `_rid` 为 TEXT PRIMARY KEY（ULID），行身份永久稳定 |
| FTS 表 | `t_<table_id>_fts` | FTS5，`content=` 外部内容表 + 触发器同步 |
| 关联表 | `r_<column_id>` | 每个关联列一张：`a`(源行) `b`(目标行) `ord`，双外键 `ON DELETE CASCADE`，`PRIMARY KEY(a,b)`，反向索引 `r_<column_id>_rev(b)` |
| SQL 视图 | `v_<view_id>` | 真实 `CREATE VIEW` |

关键元数据字段：

- `_tables.title_col_id`：每表的标题列（一个文本列），关联选择器与关联单元格显示都依赖它
- `_columns.sql_name`：物理列名 `c_xxxx`，与 UI 列名（`_columns.name`）解耦
- `_columns.opts`：JSON，按类型存选项（单选选项、公式表达式、关联目标表、是否单选等）
- `_columns.icon` / `_columns.color`：列外观（format v2 起）。`icon` 为 emoji，`color` 为调色板 token；仅影响展示，不参与 SQL
- `_columns` 反向关联列：`is_reverse: true` + `reverse_of: <column_id>`，与源列共享同一张 `r_xxxx` 表
- `_views.kind`：`grid`（config 存筛选树/排序/隐藏列 JSON）或 `sql`（config 存语句）

## 铁律（数据安全，不可违反）

1. **所有 DDL 必须在显式事务内执行**，失败必须整体回滚。禁止在事务外做多步 DDL。
2. **改列类型 = 加新列 → 回填转换 → 删旧列 → 改名**，全程一个事务。禁止任何就地破坏性类型转换。
3. **永远不要 `ALTER TABLE ... RENAME COLUMN` 物理列**。UI 重命名只改 `_columns.name`。物理列名 `c_xxxx` 一经创建不再变化，SQL 视图和公式列可能引用它们。
4. **生成 SQL 只能通过视图编译器 / 白名单模板，一律参数绑定**。禁止把用户输入（筛选值、搜索词、单元格内容）字符串拼接进 SQL。SQL 视图语句必须校验（SELECT/WITH 开头 + EXPLAIN 试跑）且只在 `PRAGMA query_only = ON` 的独立只读连接上执行。
5. **每个数据库连接必须设置**：`PRAGMA foreign_keys = ON`、`PRAGMA busy_timeout`；写连接必须 WAL 模式。
6. **删除关联列 = 同事务内 `DROP TABLE r_xxxx` + 删除 `_columns` 中源列及所有 `reverse_of` 指向它的反向列**。
7. **`_nothing.format_version` 的任何变更必须附带对应的迁移脚本**，且迁移必须幂等、事务化、可从任意旧版本逐级升级。
8. **公式列编译只放行白名单**：列引用、字面量、四则运算、白名单 SQL 函数。禁止用户公式注入子查询或任意 SQL。
9. 写操作走**单一写连接 + 队列**（Rust 侧 `Mutex<Connection>`），读可用连接池。禁止多个连接并发写。

## 架构约定

- **Rust commands 是薄层**：参数校验 + 调用内核 + 错误映射，业务逻辑一律放 `db/schema/query` 模块，保证可脱离 Tauri 单测。
- **前端只能通过 `src/ipc/` 调用后端**，组件内禁止直接 `invoke`。
- **错误处理**：Rust 侧统一 `Result<T, AppError>`，`AppError` 携带用户可读消息与错误码；前端在 ipc 层统一转 toast，组件不重复处理。
- **网格取关联数据防 N+1**：`run_view` 返回一页行后，收集本页全部关联 rid，一次 `WHERE ... IN` 批量取标题映射随结果返回。前端禁止逐行发起关联查询。
- **网格单元格编辑必须用真实 `<input>`**：Glide Data Grid 自带的 overlay 编辑器（`allowOverlay: true`）在中文输入法下不可用（editOnType 只识别 ASCII，IME 确认候选词的回车会被当作提交）。因此所有可编辑列的单元格均为 `allowOverlay: false`，编辑由 `GridEditors.tsx` 的浮动输入框完成；单击即进入编辑，提交后由 `updateCell` 写库。
- **ID 一律 ULID**（表、列、行、视图），TEXT 存储，按时间有序利于索引。
- 时间一律 ISO8601 UTC 字符串（SQLite 日期函数原生兼容），前端负责本地化显示。

### 前端 UI 约定（M6）

- **浮层只走 `src/ui/`**：`Dialog` / `PanelDialog` / `Menu` / `Popover` / `Tooltip` 由 Radix 提供行为（portal、焦点陷阱与归还、Esc、外点关闭、键盘导航），样式仍写在本项目 CSS。禁止在组件里手写 `modal-backdrop`、`dropdown-menu` + backdrop、`window.confirm`。canvas 网格没有 DOM 锚点，浮层用 `.virtual-anchor`（坐标处的 1×1 fixed 元素）挂到 Radix。
- **表单只走 `src/ui/Field.tsx`**：`Field` 管 label / hint / error，控件统一 `--control-h` 高度与 hover / focus / invalid / disabled 四态。不要在组件里写裸 `<input>`（网格内的 `.cell-editor` 与搜索框除外，它们有特殊焦点语义）。
- **颜色只能引用 token**：组件与 CSS 禁止写 hex/rgba，一律用 `--bg / --text / --accent / --tag-*` 等变量；主题切换只改 `[data-theme]`。Glide 的 `Theme` 由 `src/theme/grid.ts` 从 CSS 变量推导，切主题后必须重算（`useMemo` 依赖 `resolved`）。
- **列外观**：`_columns.icon` 是 emoji 字符串，`_columns.color` 是 9 色调色板 token（gray/blue/green/yellow/orange/red/purple/pink/brown），**不是 hex**；暗色主题靠 token 的另一套值。列颜色作用于列头与单元格底色，不改文字颜色。
- **文案只走 `src/i18n/`**：组件禁止新增中文字面量，用 `t("ns.key")`（键由 `zh.ts` 推导，拼错 = 编译失败）。新增语言只需加 `en.ts` 并在 `i18n/index.ts` 注册。用户数据（表名/列名/选项/视图名）不翻译。日期与数字展示走 `src/i18n/format.ts`，存储格式不变。
- **外观偏好存 `localStorage`**（`nothing.theme`），不进加密库——它不是工作区数据，不应触发 `format_version` 迁移。

## 常用命令

```bash
cargo test                              # 内核全部测试（workspace 根目录）
cargo test -p nothing-core --test relation   # 只跑某个集成测试文件
cargo fmt --all && cargo clippy -p nothing-core --all-targets   # 风格 + 零 warning
pnpm install              # 安装前端依赖（M3 起）
pnpm tauri dev            # 开发运行（M3 起；首次会静态编译 SQLCipher，耗时数分钟）
pnpm tauri build          # 打包（M5）
```

注意：本机缺少 webkit2gtk-4.1 时无法编译 Tauri 壳，但 nothing-core 与其测试完全不受影响——这正是内核独立成 crate 的原因。

## 测试要求

- **存储内核（schema/ 与 query/）的任何改动必须有 Rust 集成测试**，测试直接操作临时加密库文件，覆盖：DDL 事务回滚、列类型迁移、外键级联删除、视图编译器输出正确性、`_nothing` 校验与迁移。
- 视图编译器测试需包含恶意输入用例（引号、`--`、`;`、SQL 关键字），验证参数绑定不被绕过。
- 前端对 stores 和 ipc 层做单测；UI 组件测试非强制。

## 代码风格

- Rust：`cargo fmt` + `cargo clippy`（零 warning 目标）；错误用 `thiserror` 定义。
- TypeScript：严格模式；ESLint + Prettier；组件函数式，禁止 class 组件。
- 提交信息：Conventional Commits（`feat:` `fix:` `refactor:` `test:` `docs:` `chore:`）。

## 里程碑上下文

M1 存储内核 → M2 查询层 → M3 UI 骨架 → M4 视图 UI → M5 收尾打包。当前进度见 README 路线图。在里程碑未完成前，不要提前实现后续里程碑的功能（例如 M1 阶段不要开始写前端）。

**当前状态：M1–M5 完成，M6 前端体验升级进行中。**

- M1/M2（nothing-core）：68 个内核测试全绿（另 1 个 10 万行性能冒烟默认 `--ignored`），含 v1→v2 迁移与列外观用例；clippy 零警告。10 万行性能冒烟（release，`cargo test --release --test query perf_100k -- --ignored --nocapture`）：筛选视图 236ms、FTS 搜索 1.7ms、聚合 64ms。
- M3（src-tauri + 前端骨架）：Tauri v2 薄壳 27 个 command；React 18 + TS 严格模式 + Glide Data Grid v6；`src/ipc` 唯一后端入口。
- M4（视图 UI）：ViewTabs / FilterSortPanel（嵌套筛选树）/ CellEditors（单选/多选气泡、关联选择器）/ ColumnDialogs（全类型列编辑含公式编辑器）/ SqlViewPanel（CodeMirror 6）/ 列头右键菜单。
- M5（收尾）：正式图标（AI 生成 → `tauri icon` 全套尺寸，bundle.active=true）；README 三平台打包文档（Windows 为主要目标）；**大表窗口化加载**——store 重构为 `rowsCache(Map<行号,Row>) + total + dataVersion` 模型，200 行/页按需拉取 + overscan 预取 + 过期响应丢弃，TableView `rows={total}` + Loading cell；同时修复隐藏列 bug（网格改用后端返回的 `visibleColumns`）。
- M6（前端体验）：Radix 原语层 `src/ui/`；亮/暗/跟随系统主题与 token 化；表 / 列 emoji 图标（创建表、侧边栏与列头点击修改）与 9 色调色板（format v2 迁移）；表单控件统一；zh 单语言 i18n 字典 + 日期格式化；修复视图标签页「＋」菜单被 `overflow` 裁剪（此前看起来没有新建视图入口）。
- 质量门禁：tsc 零错误、vitest 全绿、vite build 通过。
- 无头冒烟脚本：`/tmp/opencode/smoke.sh`（Linux；检测 `target/debug/nothing-app` 出现 + 进程存活，结束自动清理进程组）。

后续 backlog（非里程碑）：Windows 真机打包验收、日期选择器/富文本单元格编辑器打磨、错误提示细化、滚动窗口内搜索高亮、en/ja 等语言包。
