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
- ⚡ **高性能网格**：Glide Data Grid canvas 渲染 + 200 行/页窗口化懒加载，10 万行表流畅滚动

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

### 打包

Tauri **不支持交叉打包**——必须在目标操作系统上构建。打包前先同步修改 `src-tauri/tauri.conf.json` 与 `Cargo.toml`（workspace 根）中的版本号。

#### Windows（主要目标平台）

前置条件：

1. [Rust MSVC 工具链](https://rustup.rs/)（`stable-x86_64-pc-windows-msvc`）
2. Visual Studio Build Tools（含「使用 C++ 的桌面开发」工作负载）
3. WebView2 Runtime —— Windows 10/11 通常已预装；旧系统从 [微软官网](https://developer.microsoft.com/microsoft-edge/webview2/) 安装
4. Node.js ≥ 20 + pnpm

```powershell
pnpm install
pnpm tauri build
```

产物在 `src-tauri\target\release\bundle\`：`msi\`（MSI 安装包）与 `nsis\`（NSIS 安装程序）。绿色版可执行文件在 `src-tauri\target\release\nothing-app.exe`。

#### Linux

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
pnpm install && pnpm tauri build
```

产物：`src-tauri/target/release/bundle/` 下的 `appimage\`（AppImage）与 `deb\`（.deb）。

#### macOS

```bash
xcode-select --install
pnpm install && pnpm tauri build
```

产物：`src-tauri/target/release/bundle/dmg\` 与 `macos\`（.app）。Apple Silicon 与 Intel 需分别在对应架构上构建（或用 `--target` 指定已安装的 Rust 目标）。

### 测试

```bash
cargo test                            # Rust 存储内核（62 个测试）
pnpm test                             # 前端 stores / ipc 单测（vitest）
cargo test --release --test query perf_100k -- --ignored --nocapture   # 10 万行性能冒烟
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
- [x] M4 视图 UI：筛选/排序面板、SQL 编辑器、公式列、关联选择器
- [x] M5 收尾：正式图标、各平台打包文档、大表窗口化加载（200 行/页懒加载）

## License

TBD
