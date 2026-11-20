# nothing

> 一个真正属于用户的本地数据表格工具。

做 nothing 的理由很简单：Notion、飞书多维表格这类在线工具确实好用，但数据不在自己手里。导出之后想拿到别处分析很费劲；筛选和排序只能按它们给的方式做，离真正的数据库查询差得很远；AI 之类的功能什么时候上、怎么收费，也由对方的闭环决定。

后来我换用 Access，又发现数据库对个人用户来说太"技术流"。但它让我想通一件事：**如果我只想要一个表格工具，底层放一个嵌入式数据库就够了**——能力足够强，同步交给 OneDrive 就行，别的应用要读数据也随时能读。

nothing 就是这句话的实现：**熟悉的表格界面 + 一个标准、加密的本地 SQLite 文件**。没有服务端，没有账号，也没有会在某天变掉的规则。

## 我们在坚持什么

- **数据存在标准 SQLite 数据库里。** 不是私有格式，也不是"导出时才给你数据"——你磁盘上那个文件本身就是数据库，任何 SQLite / SQLCipher 工具都能直接打开。
- **不依赖任何云平台。** 没有账号、没有订阅、没有服务端；断网或服务端停服，都不影响你打开自己的文件。
- **加密是默认的，且不可关闭。** 每个工作区都是一个带密码的加密文件。
- **用熟悉的表格界面管理数据。** 会 Excel / Notion 就能上手，日常操作不需要写一行 SQL。
- **随时可以用 SQL 和其它工具使用数据。** 想写查询就写查询，想接 BI、脚本或别的应用，用任何支持 SQLCipher 的工具直接读文件，不设壁垒。
- **同步、分析、自动化、AI，由你自己决定。** 文件放进你信任的同步盘、版本库或备份方案即可；用什么工具处理数据由你选，而不是由应用替你绑一个闭环。

## 特性

- **上手就是表格**：建表、改列、双击单元格直接编辑。文本、数字、日期、单选、多选、复选框、关联、公式都能用，日常操作不需要写 SQL。
- **列有真实类型**：每张表就是一张真实的数据表，类型与约束由数据库执行，而不是应用层"猜"。
- **公式列**：用四则运算和常用函数派生新列，数据一变自动重算，可排序、可筛选。
- **筛选排序按数据库的方式做**：支持 and/or 嵌套条件组、多列排序、隐藏列；条件在数据库里执行（编译成参数化查询），十万行也准确，不是对当前页做内存过滤。
- **SQL 视图是随时可以走的出口**：手写 SELECT，跨表 JOIN、聚合、窗口函数都能用；在只读连接里执行，写坏不了数据。
- **跨表关联**：像 Notion 一样把两张表连起来，删除被引用的行不会留下空引用；可选反向列，在对端表里看到对应关系。
- **中文友好的全文搜索**：输入任意片段即可命中，不必从词首开始匹配。
- **十万行也流畅**：表格按需加载，滚动、筛选、排序都不必等全表读入。
- **本地加密**：工作区是一个带密码的文件，不上传任何服务器，支持随时改密。
- **外观随你**：浅色 / 深色 / 跟随系统；表和列都能配 emoji 图标与 9 种底色。
- **中文界面**：文案与日期格式按中文习惯显示，其它语言可低成本补充。
- **接着上次用**：安装版会把 `.nothing` 关联到本应用（双击即开）；启动时直接列出上次打开的工作区，输入密码后可一键回到上次的表与视图。

## 界面与编辑

- **单击单元格直接编辑**：文本 / 数字 / 日期列使用应用内的浮动输入框，中文输入法可正常组合输入；`Enter` 提交、`Tab` 提交并跳到下一个可编辑列、`Esc` 取消
- **单选 / 多选**：点击单元格弹出选项气泡，多选可连续勾选
- **关联**：点击打开可搜索的行选择器，支持单选 / 多选
- **复选框**：单击方框直接切换
- 其余列（公式、反向关联列）只读；点击列头图标即可改 emoji（有 emoji 时不再显示类型图标），列头右键可编辑列、设为标题列、复制 SQL 引用名或删除列
- 表格图标可在侧边栏或表格标题前点击修改，新建表时也可直接选择

## 技术栈

| 层 | 选型 |
|---|---|
| 外壳 | Tauri v2 |
| 数据库 | rusqlite + bundled-sqlcipher（SQLCipher 社区版，BSD 协议） |
| 前端 | React 18 + TypeScript + Vite |
| 表格 | Glide Data Grid |
| 状态 | Zustand |
| UI 原语 | Radix UI（无样式，行为与可访问性） |
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

> **文件关联只由安装包建立**，开发运行与绿色版都不写注册表。安装后 `.nothing` 会关联到 nothing，双击即打开（NSIS 安装程序在安装时写入 `HKCU\Software\Classes\.nothing`，卸载时自动清除）；MSI 只把 nothing 注册为「打开方式」候选，若系统里 `.nothing` 已被其它程序占用，需要在 Windows 设置里手动指定默认应用。
>
> 最近打开的工作区与每个工作区上次停留的表 / 视图记录在 `%APPDATA%\app.nothing.desktop\settings.json`（明文，等同于系统「最近使用的文档」）。删掉该文件只会丢失最近列表，不影响任何工作区数据。

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
cargo test                            # Rust 存储内核
pnpm test                             # 前端 stores / ipc / 组件单测（vitest）
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

因为底层是标准 SQLite 结构，你随时可以拿着密码、用任何支持 SQLCipher 的工具打开自己的数据——**数据属于你，不被应用绑架**。

### 关于同步

工作区是单个文件，可以放在 OneDrive / iCloud / Syncthing 或 git 里同步，适合"同一时间只在一台设备上编辑"的用法。多台设备同时编辑同一文件会互相覆盖，这不是本工具能解决的问题——真正的多端并发同步需要一个服务端，而那与"不依赖云"相悖。

## 路线图

- [x] M1 存储内核：加密库、元数据、表/列 DDL、关联表、迁移
- [x] M2 查询层：行 CRUD、视图 SQL 编译器、FTS、SQL 视图执行
- [x] M3 UI 骨架：侧边栏、网格渲染、行内编辑
- [x] M4 视图 UI：筛选/排序面板、SQL 编辑器、公式列、关联选择器
- [x] M5 收尾：正式图标、各平台打包文档、大表窗口化加载
- [x] M6 前端体验：浅色 / 深色主题、表与列的 emoji 图标和配色、统一表单控件、界面文案集中管理
- [x] 最近文件与文件关联：启动即回到上次的工作区与视图，双击 `.nothing` 直接打开
- [x] CSV 导入：首行作表头可编辑，自动推断列类型

### 下一步：易用性打磨

- [ ] 日期选择器与富文本单元格编辑器
- [ ] 错误提示细化（说清原因和下一步怎么做）
- [ ] 滚动窗口内的搜索命中高亮
- [ ] en / ja 等语言包
- [ ] Windows 真机打包验收

## License

TBD
