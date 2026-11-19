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
  tests/                 集成测试（直接操作真实加密临时库）
src-tauri/               （M3 添加）Tauri 薄壳：commands/ 只做参数校验与转发
/                        （M3 添加）前端 React + TS + Vite
  src/components/ src/stores/ src/ipc/（前端唯一与后端通信的入口）
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
- **ID 一律 ULID**（表、列、行、视图），TEXT 存储，按时间有序利于索引。
- 时间一律 ISO8601 UTC 字符串（SQLite 日期函数原生兼容），前端负责本地化显示。

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

**当前状态：M1 已完成**（nothing-core：加密库、`_nothing` 清单与迁移框架、表/列/视图 DDL、公式白名单编译器、FTS5、junction 关联与级联、47 个测试全绿）。下一步 M2：行 CRUD、grid 视图 JSON→参数化 SQL 编译器、FTS 搜索接口（trigram 需 ≥3 字符，短词回退 LIKE）、SQL 视图只读执行、关联批量标题解析（防 N+1）。
