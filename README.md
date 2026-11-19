# nothing

> 本地优先、端到端加密的 Notion 式表格数据库工具。

nothing 是一个只做一件事并把它做好的桌面应用：**表格**。它把 Notion / Airtable 式的表格体验直接建立在真实的 SQLite（SQLCipher 加密）数据库之上，而不是用黑盒格式模拟——你的数据始终是标准、可迁移、可被任何 SQL 工具读取的数据库结构。

## 特性

- 🔐 **强制加密**：每个工作区是一个 `.nothing` 文件（SQLCipher），打开需要密码，支持改密
- 🗃️ **真实数据库映射**：每个表格就是一张真实的 SQLite 表，列有真实类型，拒绝 EAV 反模式
- 🧮 **公式列**：基于 SQLite Generated Column 实现，由数据库自动维护，可索引、可参与筛选
- 🔍 **全文搜索**：FTS5 虚拟表 + 触发器自动同步
- 🧩 **关联表**：员工 ↔ 任务式的跨表关联，独立关联表 + 真外键 `ON DELETE CASCADE`，数据库保证永远不会出现悬空引用；支持 Notion 式可选反向列
- 📋 **两类视图**：
  - **网格视图**：Notion 式筛选（and/or 条件组）、排序、隐藏列，配置编译为参数化 SQL
  - **SQL 视图**：直接编写 SELECT，跨表 JOIN、聚合、窗口函数，在只读连接中安全执行
- ⚡ **高性能网格**：Glide Data Grid canvas 渲染，10 万行流畅滚动

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Tauri v2 |
| 数据库 | rusqlite + bundled-sqlcipher（SQLCipher 社区版，BSD 协议） |
| 前端 | React 18 + TypeScript + Vite |
| 表格 | Glide Data Grid |
| 状态 | Zustand |
| SQL 编辑器 | CodeMirror 6 |

## 构建与运行

### 环境要求

- [Rust](https://rustup.rs/)（stable）
- [Node.js](https://nodejs.org/) ≥ 20 与 pnpm
- Linux 下需要 Tauri 的系统依赖（webkit2gtk 等），见 [Tauri 官方文档](https://tauri.app/start/prerequisites/)

### 开发

```bash
pnpm install
pnpm tauri dev
```

> 首次构建会静态编译 SQLCipher，耗时较长（数分钟），属正常现象。

### 测试

```bash
pnpm test          # 前端测试
cargo test         # Rust 存储内核测试（在 src-tauri 目录下）
```

### 打包

```bash
pnpm tauri build   # 产出 AppImage / dmg / msi
```

## `.nothing` 文件格式

一个 `.nothing` 文件就是一个标准的 SQLCipher 加密 SQLite 数据库，内部结构：

```
_nothing        清单表（magic 身份标识 + format_version 格式版本）
_tables         元数据：表定义（含标题列）
_columns        元数据：列定义（UI 名称与物理列名解耦）
_views          元数据：视图定义（网格配置 JSON / SQL 语句）
t_xxxx          用户表（每张表一个真实 SQLite 表）
t_xxxx_fts      全文搜索虚拟表
r_xxxx          关联表（每个关联列一张，含级联外键）
```

打开文件时，nothing 先解密、再校验 `_nothing.magic`，能明确区分"密码错误"与"不是 nothing 的文件"。格式版本升级由启动时的自动迁移完成。

因为底层是标准 SQLite 结构，你随时可以用任何支持 SQLCipher 的工具打开自己的数据——**数据属于你，不被应用绑架**。

## 路线图

- [x] M1 存储内核：加密库、元数据、表/列 DDL、关联表、迁移
- [x] M2 查询层：行 CRUD、视图 SQL 编译器、FTS、SQL 视图执行
- [x] M3 UI 骨架：侧边栏、网格渲染、行内编辑
- [ ] M4 视图 UI：筛选/排序面板、SQL 编辑器、公式列、关联选择器
- [ ] M5 收尾：改密、打包、性能验证

## License

TBD
