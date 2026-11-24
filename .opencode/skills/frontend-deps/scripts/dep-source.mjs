#!/usr/bin/env node
// Print the original source of a dependency package.
//
// Prefers `sourcesContent` embedded in the package's source maps (Radix and
// react-colorful ship those), and falls back to the package's own `src/`
// directory (Glide Data Grid ships it). Never prints minified bundles.
//
// Usage (from the repository root):
//   node .opencode/skills/frontend-deps/scripts/dep-source.mjs <pkg> [options]
//
//   --list                 List source files (default when no action is given)
//   --find <text>          Show matching lines with context
//   --file <substring>     Print a whole file whose path contains <substring>
//   --full                 Do not cap --file output
//   --max-chars <n>        Override the total output cap (default 60000)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const MAX_OUTPUT = 60000;
const FILE_LINE_CAP = 400;
const CONTEXT = 3;
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage"]);
const SKIP_FILE = /\.(test|spec)\.[jt]sx?$/;

const require = createRequire(import.meta.url);

function usage(stream = console.log) {
  stream(
    [
      "Usage: dep-source.mjs <pkg> [--list | --find <text> | --file <substring>] [--full] [--max-chars <n>]",
      "",
      "  --list               列出可读源码文件（默认动作）",
      "  --find <text>        打印命中行及其上下文（不区分大小写）",
      "  --file <substring>   打印路径包含该串的完整文件",
      "  --full               取消 --file 的行数上限",
      "  --max-chars <n>      输出总字符上限（默认 60000）",
    ].join("\n"),
  );
}

function fail(message) {
  console.error(`dep-source: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { pkg: null, action: "list", find: null, file: null, full: false, maxChars: MAX_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--list") {
      out.action = "list";
    } else if (arg === "--find" || arg === "--file" || arg === "--max-chars") {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} 缺少参数值`);
      if (arg === "--find") {
        out.action = "find";
        out.find = value;
      } else if (arg === "--file") {
        out.action = "file";
        out.file = value;
      } else {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) fail(`--max-chars 需要正数，收到 ${value}`);
        out.maxChars = n;
      }
    } else if (arg === "--full") {
      out.full = true;
    } else if (arg.startsWith("-")) {
      fail(`未知选项 ${arg}`);
    } else if (out.pkg === null) {
      out.pkg = arg;
    } else if (out.action === "find" && out.find === null) {
      out.find = arg;
    } else {
      fail(`多余的参数 ${arg}`);
    }
  }
  if (!out.pkg) {
    usage(console.error);
    process.exit(1);
  }
  return out;
}

function resolveEntry(name) {
  try {
    return require.resolve(name);
  } catch {
    return fail(`找不到包 ${name}。先在仓库根目录执行 pnpm install？`);
  }
}

// Walk up from the resolved entry until package.json declares the requested
// name. Stopping at the first package.json is wrong: packages such as
// @uiw/react-codemirror ship a nested `cjs/package.json`.
function packageRoot(name) {
  let dir = path.dirname(fs.realpathSync(resolveEntry(name)));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === name) return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail(`解析不到 ${name} 的包根目录`);
}

function walk(root, visit, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(root, entry.name), visit, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      visit(path.join(root, entry.name));
    }
  }
}

function normalizeDisplay(source) {
  return source.replace(/\\/g, "/").replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
}

function fromSourceMaps(root) {
  const maps = [];
  walk(root, (file) => {
    if (file.endsWith(".map")) maps.push(file);
  });
  const seen = new Set();
  const entries = [];
  for (const mapFile of maps) {
    let text;
    try {
      text = fs.readFileSync(mapFile, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("sourcesContent")) continue;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const sources = Array.isArray(json.sources) ? json.sources : [];
    const contents = Array.isArray(json.sourcesContent) ? json.sourcesContent : [];
    sources.forEach((source, index) => {
      const content = contents[index];
      if (typeof content !== "string" || content.length === 0) return;
      const display = normalizeDisplay(source);
      if (seen.has(display)) return;
      seen.add(display);
      entries.push({ source: display, content, from: path.relative(root, mapFile) });
    });
  }
  return entries;
}

function fromSrcDir(root) {
  const srcDir = path.join(root, "src");
  if (!fs.existsSync(srcDir)) return [];
  const entries = [];
  walk(srcDir, (file) => {
    if (!SOURCE_EXT.has(path.extname(file)) || SKIP_FILE.test(file)) return;
    try {
      const content = fs.readFileSync(file, "utf8");
      entries.push({ source: normalizeDisplay(path.relative(root, file)), content, from: "src" });
    } catch {
      // unreadable file, skip
    }
  });
  return entries;
}

function loadSources(root) {
  const mapped = fromSourceMaps(root);
  if (mapped.length > 0) return { mode: "map", entries: mapped };
  const shipped = fromSrcDir(root);
  if (shipped.length > 0) return { mode: "src", entries: shipped };
  return { mode: "none", entries: [] };
}

function lineCount(content) {
  return content.length === 0 ? 0 : content.split("\n").length;
}

function printList(entries) {
  const lines = entries.map((entry) => {
    const kb = (Buffer.byteLength(entry.content, "utf8") / 1024).toFixed(1);
    return `${kb.padStart(7)} KB ${String(lineCount(entry.content)).padStart(6)} 行  ${entry.source}`;
  });
  return emit(lines.join("\n"));
}

function rangesFor(lineIndexes, total) {
  const ranges = [];
  for (const index of lineIndexes) {
    const start = Math.max(0, index - CONTEXT);
    const end = Math.min(total - 1, index + CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
}

function printFind(entries, needle) {
  const lower = needle.toLowerCase();
  const blocks = [];
  let matchedFiles = 0;
  for (const entry of entries) {
    if (!entry.content.toLowerCase().includes(lower)) continue;
    matchedFiles++;
    const lines = entry.content.split("\n");
    const hits = [];
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(lower)) hits.push(index);
    });
    const width = String(lines.length).length;
    const body = rangesFor(hits, lines.length).map(({ start, end }) => {
      const slice = lines
        .slice(start, end + 1)
        .map((line, offset) => `${String(start + offset + 1).padStart(width)}: ${line}`)
        .join("\n");
      return `${"-".repeat(3)} lines ${start + 1}-${end + 1}\n${slice}`;
    });
    blocks.push(`=== ${entry.source}  (${hits.length} 处命中)\n${body.join("\n")}`);
  }
  if (matchedFiles === 0) {
    console.error(`没有源码包含 "${needle}"。用 --list 看有哪些文件，或改用 --file。`);
    return 0;
  }
  return emit(blocks.join("\n\n"));
}

function printFile(entries, substring, full) {
  const needle = substring.toLowerCase();
  const matches = entries.filter((entry) => entry.source.toLowerCase().includes(needle));
  if (matches.length === 0) {
    console.error(`没有文件路径包含 "${substring}"。用 --list 查看可读文件。`);
    return 0;
  }
  const blocks = matches.map((entry) => {
    const lines = entry.content.split("\n");
    const cap = full ? lines.length : Math.min(lines.length, FILE_LINE_CAP);
    const width = String(lines.length).length;
    const body = lines
      .slice(0, cap)
      .map((line, index) => `${String(index + 1).padStart(width)}: ${line}`)
      .join("\n");
    const omitted = lines.length > cap ? `\n… 省略 ${lines.length - cap} 行（加 --full 查看全部）` : "";
    return `=== ${entry.source}\n${body}${omitted}`;
  });
  return emit(blocks.join("\n\n"));
}

let emitted = 0;
let outputCap = MAX_OUTPUT;
function emit(text) {
  const remaining = Math.max(0, outputCap - emitted);
  if (remaining === 0) {
    console.error("dep-source: 输出已达上限，后续内容被省略（用 --max-chars 调整）");
    return 1;
  }
  if (text.length > remaining) {
    console.log(text.slice(0, remaining));
    console.log(`\n… dep-source: 输出被截断（上限 ${outputCap} 字符，用 --max-chars 调整）`);
    emitted = outputCap;
    return 0;
  }
  console.log(text);
  emitted += text.length + 1;
  return 0;
}

const options = parseArgs(process.argv.slice(2));
outputCap = options.maxChars;
const root = packageRoot(options.pkg);
const { mode, entries } = loadSources(root);

if (entries.length === 0) {
  const dts = [];
  walk(root, (file) => {
    if (file.endsWith(".d.ts")) dts.push(normalizeDisplay(path.relative(root, file)));
  });
  console.error(`${options.pkg} 没有可读源码（source map 无 sourcesContent，也没有 src/ 目录）。`);
  console.error(`改用类型声明：${dts.slice(0, 12).join(", ") || "（未找到 .d.ts）"}`);
  process.exit(1);
}

if (options.action === "list") {
  console.log(`# ${options.pkg} — ${entries.length} 个源文件（来源：${mode === "map" ? "source map" : "src/"}）`);
  process.exit(printList(entries));
}

if (options.action === "find") {
  if (!options.find) fail("--find 需要匹配文本");
  process.exit(printFind(entries, options.find));
}

if (options.action === "file") {
  if (!options.file) fail("--file 需要路径片段");
  process.exit(printFile(entries, options.file, options.full));
}