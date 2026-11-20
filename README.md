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
- Windows 下需要一个**原生 Windows Perl**（vendored OpenSSL 源码构建使用），见下文 Windows 打包一节
- Linux 下需要 Tauri 的系统依赖（webkit2gtk 等），见 [Tauri 官方文档](https://tauri.app/start/prerequisites/)

### 开发

```bash
pnpm install
pnpm tauri dev
```

> 首次构建会静态编译 SQLCipher 与 OpenSSL（`bundled-sqlcipher-vendored-openssl`，无需系统预装 OpenSSL），耗时较长（可达十余分钟），属正常现象。机器上没有 nasm 时 OpenSSL 自动以 `no-asm` 模式构建，不影响正确性。

### 打包

Tauri **不支持交叉打包**——必须在目标操作系统上构建。打包前先同步修改 `src-tauri/tauri.conf.json` 与 `Cargo.toml`（workspace 根）中的版本号。

#### Windows（主要目标平台）

前置条件：

1. [Rust MSVC 工具链](https://rustup.rs/)（`stable-x86_64-pc-windows-msvc`）
2. Visual Studio Build Tools（含「使用 C++ 的桌面开发」工作负载）
3. WebView2 Runtime —— Windows 10/11 通常已预装；旧系统从 [微软官网](https://developer.microsoft.com/microsoft-edge/webview2/) 安装
4. Node.js ≥ 20 + pnpm
5. 原生 Windows Perl —— vendored OpenSSL 的 `Configure` 脚本使用，二选一：
   - msys2：`pacman -S mingw-w64-x86_64-perl`（**必须是 mingw64 版**，msys 层的 `perl` 不行，见下文排错）
   - [Strawberry Perl](https://strawberryperl.com/)

```powershell
pnpm install
pnpm tauri build
```

产物在 workspace 根的 `target\release\bundle\`：`msi\`（MSI 安装包）与 `nsis\`（NSIS 安装程序）。绿色版可执行文件在 `target\release\nothing-app.exe`。

##### Windows 构建排错（OpenSSL / msys2）

| 症状 | 原因 | 处理 |
|---|---|---|
| `Missing environment variable OPENSSL_DIR` | rusqlite 的 feature 被改回了 `bundled-sqlcipher`（该模式要求系统预装 OpenSSL） | 保持根 `Cargo.toml` 中 feature 为 `bundled-sqlcipher-vendored-openssl`，无需安装任何 OpenSSL |
| OpenSSL Configure 报 `This perl implementation doesn't produce Windows like paths` | PATH 里的 `perl` 是 msys 层 Perl（如 `C:\msys64\usr\bin\perl.exe`，`x86_64-msys` 构建），生成 Unix 风格路径，无法用于 `VC-WIN64A` 目标 | 安装原生 win32 Perl（`pacman -S mingw-w64-x86_64-perl` 或 Strawberry Perl），并确保其目录（如 `C:\msys64\mingw64\bin`）在 PATH 中**先于** `C:\msys64\usr\bin`；用 `perl -v` 验证输出含 `MSWin32-x64` |
| `perl.exe`（或 g++ 等 mingw64 程序）启动即退出，退出码 `0xC0000139`（STATUS_ENTRYPOINT_NOT_FOUND） | mingw64 环境新旧包混装：典型为升级 gcc 后，新 `libstdc++-6.dll` 需要新版 `libwinpthread-1.dll` 的 time64 符号（`clock_gettime64` 等），而后者仍是旧版 | msys2 是滚动发行版，**不支持部分升级**。执行完整升级（两阶段：第一阶段升级 msys2-runtime 后会要求关闭所有 MSYS2 终端，之后继续第二阶段）：`pacman -Syu` → 关闭终端重开 → `pacman -Su` |
| 构建日志出现 `no-asm`、OpenSSL 编译很慢 | 机器上没有 nasm，openssl-src 自动退回纯 C 构建 | 正常现象，无需处理；对本项目的加密吞吐量无感知差异 |

排错时可用 `where.exe perl` 与 `perl -v` 快速确认当前解析到的 Perl；用 `pacman -Qs winpthread`、`pacman -Q mingw-w64-x86_64-gcc-libs` 检查 mingw64 运行时包版本是否一致。

#### Linux

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
pnpm install && pnpm tauri build
```

产物：workspace 根的 `target/release/bundle/` 下的 `appimage\`（AppImage）与 `deb\`（.deb）。

#### macOS

```bash
xcode-select --install
pnpm install && pnpm tauri build
```

产物：workspace 根的 `target/release/bundle/dmg\` 与 `macos\`（.app）。Apple Silicon 与 Intel 需分别在对应架构上构建（或用 `--target` 指定已安装的 Rust 目标）。

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
