# AGENTS.md

本文件是 AI 协作代理（及人类开发者）在 Nothing 代码库中工作的规范。**违反"铁律"章节的规则可能直接导致用户数据损坏，任何改动前请先通读。**

## 项目简介与状态

Nothing 是一个 Tauri v2 桌面应用：本地优先、SQLCipher 加密的 Notion 式**纯表格**工具。核心思想是把 Notion 的表格体验映射到真实 SQLite 特性上（真实列类型、CHECK 约束、Generated Column、FTS5、真外键级联、只读 SQL 查询），拒绝 EAV 反模式。

产品范围：**只做表格**，不要引入文档、看板、日历等其他 block 类型。当前处于**易用性打磨期**：核心功能已完成，优先改交互、提示、性能与文档，不新增大块功能。改动前确认基线：`cargo test`、`pnpm test`、`pnpm build` 全绿且 clippy 零 warning。本文件只记录约束，不记录进度。

## 目录结构（现状）

Cargo workspace：存储内核是独立 crate，**不依赖 Tauri**，可单独编译测试；Tauri 壳只做薄转发。

```
Cargo.toml                 workspace 根
crates/nothing-core/       存储内核（纯 Rust，不依赖 Tauri）
  db/                      加密连接（单写 + 只读）、密码、_nothing 清单与 v4→v6 迁移
  schema/                  元数据、表/列/视图 DDL、公式编译、FTS、junction
  query/                   视图/汇总编译器、行 CRUD、run_view/run_sql/search
  import.rs                CSV/TSV 预览与导入
  tests/                   真实加密临时库集成测试
src-tauri/                 Tauri 薄壳：命令转发、settings.rs、单实例/文件打开
src/                       前端（React + TS + Vite）：components/（网格、汇总/图表、行详情）、ui/、stores/（zustand，含 history）、theme/、i18n/、ipc/
```

## 数据库 Schema 与命名约定

每个工作区 = 一个 `.nothing` 文件（SQLCipher 加密的 SQLite 库）。

| 对象 | 命名 | 说明 |
|---|---|---|
| 清单表 | `_nothing` | key-value：`magic`（固定 `nothing-db`）、`format_version`、`created_at`、`created_by`。文件身份识别与格式校验入口 |
| 元数据表 | `_meta` | **单张**自关联节点表（`kind` = `table`/`column`/`option`/`view`/`view_column`），`STRICT`；Rust 侧 `*Meta`/`*Data` 类型是对象模型与不变量来源 |
| 用户表 | `t_<table_id>` | `table_id` 为 ULID |
| 用户表列 | `_rid` `_created` `_updated` + `c_<column_id>` | `_rid` 为 TEXT PRIMARY KEY（ULID），行身份永久稳定 |
| FTS 表 | `t_<table_id>_fts` | FTS5，`content=` 外部内容表 + 触发器同步 |
| 关联表 | `r_<column_id>` | 每个关联列一张：`a`(源行) `b`(目标行) `ord`，双外键 `ON DELETE CASCADE`，`PRIMARY KEY(a,b)`，反向索引 `r_<column_id>_rev(b)` |
| SQL 视图 | 无物理对象 | 语句存于 `_meta`，在只读连接上直接执行 |

关键元数据字段（全部在 `_meta` 中）：

- `kind` + `parent_id`：逻辑树（表 → 列 → 选项；表 → 网格视图 → 视图列）。`parent_id` 同时是生命周期所有者，`ON DELETE CASCADE`
- `table` 节点：`sql_name`（`t_xxxx`）、`title_col_id`（自引用 FK，标题列）、`icon`/`color`
- `column` 节点：`col_type`、`sql_name`（**仅物理列**，关联/反向列为 NULL）、`align`、`default_value`、`formula_expr`/`formula_result_type`；`target_table_id`/`single`/`origin_id` 仅关联列使用
- `option` 节点：`name`/`icon`/`color`/`position`
- `view` 节点：`view_kind`（`grid`/`sql`），`filters`/`sorts` 只存筛选树与排序；SQL 视图只存 `statement`；`aggregate` 存汇总配置（仍是 grid 视图，存在即为只读汇总）
- `view_column` 节点：`ref_id`（基列）、`width`、`position`、`hidden`、`frozen`（冻结左前缀）。**宽度/顺序/隐藏/冻结按视图隔离**
- 反向关联列：`origin_id` 指向源列（FK 级联），与源列共享 `r_xxxx` 表
- JSON 字段：`default_value`（单元格值）、`filters`、`sorts`、`aggregate`、`format`（列展示格式）；`format` 只影响展示（数字/日期及其公式列），不改单元格存储值

## 铁律（数据安全，不可违反）

1. **所有 DDL 必须在显式事务内执行**，失败必须整体回滚。禁止在事务外做多步 DDL。
2. **改列类型必须走整表重建**：临时表 → 按转换表达式回填 → 替换旧表（12 步、fk off），全程一个事务。禁止任何就地破坏性类型转换。
3. **永远不要 `ALTER TABLE ... RENAME COLUMN` 物理列**。UI 重命名只改 `_meta` 中列节点的 `name`。物理列名 `c_xxxx` 一经创建不再变化，SQL 视图和公式列可能引用它们。
4. **生成 SQL 只能通过视图编译器 / 白名单模板，一律参数绑定**。禁止把用户输入（筛选值、搜索词、单元格内容）字符串拼接进 SQL；标识符/字面量只经 `ident::quote_ident`/`quote_literal` 转义。SQL 视图语句必须校验（SELECT/WITH 开头 + EXPLAIN 试跑）且只在 `PRAGMA query_only = ON` 的独立只读连接上执行。
5. **每个数据库连接必须设置**：`PRAGMA foreign_keys = ON`、`PRAGMA busy_timeout`；写连接必须 WAL 模式。
6. **删除关联列 = 同事务内 `DROP TABLE r_xxxx`**；反向列由 `origin_id` 上的 `ON DELETE CASCADE` 清理，源列与反向列共享同一张 `r_xxxx` 表。
7. **`_nothing.format_version` 的任何变更必须附带对应的迁移脚本**，且迁移必须幂等、事务化、可从任意旧版本逐级升级。当前格式版本为 v6：v4 库在打开时事务内补上 `_meta.format` / `_meta.frozen` 两列，v5 库补上 `_meta.aggregate` 列，然后升级版本号；v1–v3（三张独立元数据表）仍明确拒绝、不提供数据迁移。
8. **公式列编译只放行白名单**：列引用、字面量、四则运算、白名单 SQL 函数。禁止用户公式注入子查询或任意 SQL。
9. 写操作走**单一写连接 + 队列**（Rust 侧 `Mutex<Connection>`），读操作走**单一只读连接**（`PRAGMA query_only = ON`，同样由 `Mutex` 串行化）。禁止多个连接并发写。

## 架构约定

- **Rust commands 是薄层**：参数校验 + 调用内核 + 错误映射，业务逻辑一律放 `db/schema/query` 模块，保证可脱离 Tauri 单测。
- **前端只能通过 `src/ipc/` 调用后端**，组件内禁止直接 `invoke`。
- **错误处理**：Rust 侧统一 `Result<T, AppError>`，`AppError` 携带用户可读消息与错误码（命令层映射为 `kind`）；前端 ipc 层统一转 `IpcError`，由 store 或调用方转 toast，组件不重复处理。
- **网格取关联数据防 N+1**：`run_view` 返回一页行后，收集本页全部关联 rid，一次 `WHERE ... IN` 批量取标题映射随结果返回。前端禁止逐行发起关联查询。
- **网格单元格编辑必须用真实 `<input>`**：Glide Data Grid 自带的 overlay 编辑器（`allowOverlay: true`）在中文输入法下不可用（editOnType 只识别 ASCII，IME 确认候选词的回车会被当作提交）。因此所有可编辑列的单元格均为 `allowOverlay: false`，编辑由 `GridEditors.tsx` 的浮动输入框完成；单击即进入编辑，提交后由 `updateCell` 写库。
- **应用级设置在加密库外**：`settings.json`（最近文件、上次表/视图）明文存储，因为它要在输入密码前可读；损坏时降级默认值、绝不阻塞启动，也不得触发 `format_version` 迁移。
- **汇总视图与图表**：汇总仍是 `grid` 视图 + `_meta.aggregate`，存在即为只读；图表是前端从 `AggregateResult` 派生的展示层，后端 `ViewKind` 只有 `grid`/`sql`，不新增 chart 类型、不持久化图表配置，图表模式仅会话内。
- **撤销/重做是会话内栈**（上限 50，不落库）：列类型/选项/公式变更、删列删表、切工作区会清栈；删除的撤销用快照原样恢复 `_rid` 与关联。新增写操作要明确记录逆操作或清栈。
- **ID 一律 ULID**（表、列、行、视图、选项），TEXT 存储，按时间有序利于索引。
- 时间一律 ISO8601 UTC 字符串（SQLite 日期函数原生兼容），前端负责本地化显示。

### 前端 UI 约定

- **浮层只走 `src/ui/`**：`Dialog` / `PanelDialog` / `Menu` / `Popover` / `Tooltip` 的行为交给 Radix（portal、焦点陷阱与归还、Esc、外点关闭、键盘导航），样式仍写在本项目 CSS。禁止在组件里手写 `modal-backdrop`、`dropdown-menu` + backdrop、`window.confirm`。canvas 网格没有 DOM 锚点，浮层用 `.virtual-anchor`（坐标处的 1×1 fixed 元素）挂到 Radix。
- **表单优先走 `src/ui/Field.tsx`**：`Field` 管 label / hint / error，控件统一 `--control-h` 与 hover/focus/invalid/disabled 四态。以下是为特殊交互保留的裸 `<input>` 例外：网格 `.cell-editor`、搜索框、侧栏/视图标签的内联重命名、筛选值编辑器、CSV 表头行。新增普通表单字段仍应使用 `Field`/`Input`/`Select`。
- **颜色只能引用 token**：组件与普通 CSS 禁止硬编码配色，一律用 `--bg / --text / --accent / --tag-* / --syntax-*` 等变量。hex/rgba 只允许出现在 `styles.css` 的 token 定义、`src/theme/color.ts` 的自定义色推导，以及取色器的默认值常量中。主题切换只改 `[data-theme]`；Glide 的 `Theme` 由 `src/theme/grid.ts` 从 CSS 变量推导，切主题后必须重算（`useMemo` 依赖 `resolved`）；CodeMirror 主题（`src/theme/codemirror.ts`）同样全走变量，切主题无需重建。
- **列外观**：列节点的 `icon` 是 emoji 字符串；`color` 是 18 色预设 token（gray/brown/orange/amber/yellow/lime/green/teal/cyan/sky/blue/indigo/violet/purple/plum/pink/crimson/red）或拾色器选出的 `#rrggbb`。**预设色只能引用 token**；自定义色由 `src/theme/color.ts` 按当前主题推导出 chip / swatch / 单元格底色，组件里不写裸 hex，也不提供 hex 输入框。写入时后端严格校验，读取到未知 token 时降级为无颜色。列头保持中性，列颜色只体现在图标、选项胶囊与极淡单元格底色，不改文字色；无 emoji 的选项在胶囊内显示取文字色的圆点（两种主题都有对比）。
- **文案只走 `src/i18n/`**：组件禁止新增中文字面量，用 `t("ns.key")`（键由 `zh.ts` 推导，拼错 = 编译失败）。新增语言只需加 `en.ts` 并在 `i18n/index.ts` 注册。用户数据（表名/列名/选项/视图名）不翻译。日期展示走 `src/i18n/format.ts`；数字保持原值显示（存储与复制均不格式化）。
- **本地偏好存 `localStorage`**：`nothing.theme`（明暗模式）、`nothing.layout.sidebar`（侧栏折叠）、`nothing.layout.rowNumbers`（行号显示）、`nothing.columnIcons`（最近使用的 emoji）。这些都不是工作区数据，不进加密库，也不应触发 `format_version` 迁移。

## 常用命令

```bash
cargo test                              # 内核全部测试（workspace 根目录）
cargo test -p nothing-core --test relation   # 只跑某个集成测试文件
cargo fmt --all && cargo clippy -p nothing-core --all-targets   # 风格 + 零 warning
pnpm install              # 安装前端依赖
pnpm test                 # 前端 stores / ipc / 组件单测（vitest）
pnpm build                # tsc 类型检查 + vite 生产构建
pnpm tauri dev            # 开发运行（首次会静态编译 SQLCipher，耗时数分钟）
pnpm tauri build          # 打包
```

完成标准：`cargo test`、`pnpm test`、`pnpm build` 全绿，clippy 零 warning。较大改动要递增 tag（如 `v0.1.11`），发版时 tag 与 `Cargo.toml`（workspace）、`src-tauri/tauri.conf.json`、`package.json` 的版本号保持一致；应用内显示版本取自最近的 `v*` tag，无 tag 时回退 manifest 版本。

注意：缺少 webkit2gtk-4.1 时无法编译 Tauri 壳，但 nothing-core 与其测试完全不受影响——这正是内核独立成 crate 的原因。

## 测试要求

- **存储内核（schema/ 与 query/）的任何改动必须有 Rust 集成测试**，直接操作临时加密库文件，覆盖：DDL 事务回滚、列类型迁移、外键级联删除（含 `origin_id` 反向列）、视图与汇总编译器输出正确性、`_meta` 单表节点约束、v4→v6 迁移与格式校验；编译器用例必须包含恶意输入（引号、`--`、`;`、SQL 关键字），验证参数绑定不被绕过。
- 前端对 stores 和 ipc 层做单测；UI 组件测试非强制。

## 代码风格

- Rust：`cargo fmt` + `cargo clippy`（零 warning 目标）；错误用 `thiserror` 定义。
- TypeScript：严格模式（`noUnusedLocals` / `noUnusedParameters`）；当前未配置 ESLint / Prettier，按现有代码风格手写；组件函数式，禁止 class 组件。
- 提交信息：Conventional Commits（`feat:` `fix:` `refactor:` `test:` `docs:` `chore:`）。
