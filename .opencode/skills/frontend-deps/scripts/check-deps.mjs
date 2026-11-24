#!/usr/bin/env node
// Verify that the frontend-deps skill still matches node_modules.
//
// Checks, for every package recorded in references/deps.json:
//   1. the package is installed,
//   2. the installed version equals the recorded version,
//   3. every recorded path (type entry, source entry) still exists.
//
// Usage (from the repository root):
//   node .opencode/skills/frontend-deps/scripts/check-deps.mjs [--update]
//
//   --update   rewrite the recorded versions to the installed ones; paths and
//              prose still need a manual review.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const manifestPath = path.resolve(here, "../references/deps.json");
const repoPackagePath = path.join(repoRoot, "package.json");

const update = process.argv.includes("--update");

function fail(message) {
  console.error(`check-deps: ${message}`);
  process.exit(1);
}

function readJson(file, what) {
  if (!fs.existsSync(file)) fail(`找不到${what}：${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${what} 不是合法 JSON：${error.message}`);
  }
}

const repoPackage = readJson(repoPackagePath, "仓库 package.json");
const manifest = readJson(manifestPath, "references/deps.json");

if (!manifest || typeof manifest.packages !== "object" || manifest.packages === null) {
  fail("references/deps.json 缺少 packages 对象");
}

const ignore = new Set(Array.isArray(manifest.ignore) ? manifest.ignore : []);
const nodeModules = path.join(repoRoot, "node_modules");
if (!fs.existsSync(nodeModules)) fail("没有 node_modules，先执行 pnpm install");

const problems = [];
const warnings = [];
const updated = [];

for (const [name, entry] of Object.entries(manifest.packages)) {
  if (!entry || typeof entry !== "object") {
    problems.push(`${name}: 清单条目不是对象`);
    continue;
  }
  if (typeof entry.version !== "string") {
    problems.push(`${name}: 缺少 version`);
    continue;
  }
  const paths = Array.isArray(entry.paths) ? entry.paths : [];
  if (paths.length === 0) {
    problems.push(`${name}: paths 为空，至少记录一个类型入口`);
    continue;
  }

  const packageDir = path.join(nodeModules, ...name.split("/"));
  const installedManifest = path.join(packageDir, "package.json");
  if (!fs.existsSync(installedManifest)) {
    problems.push(`${name}: 未安装（pnpm install？）`);
    continue;
  }

  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(installedManifest, "utf8")).version;
  } catch (error) {
    problems.push(`${name}: 读不出已安装版本（${error.message}）`);
    continue;
  }

  if (installed !== entry.version) {
    if (update) {
      entry.version = installed;
      updated.push(`${name}: ${installed}`);
    } else {
      problems.push(
        `${name}: 记录 ${entry.version}，实际 ${installed}（复核 references/frontend.md 后执行 pnpm deps:check --update）`,
      );
    }
  }

  for (const relative of paths) {
    const target = path.join(packageDir, ...String(relative).split("/"));
    if (!fs.existsSync(target)) {
      problems.push(`${name}: 路径不存在 node_modules/${name}/${relative}`);
    }
  }
}

const declared = Object.keys(repoPackage.dependencies ?? {});
const untracked = declared.filter((name) => !(name in manifest.packages) && !ignore.has(name));
if (untracked.length > 0) {
  warnings.push(`未纳入速查表的运行时依赖：${untracked.join(", ")}`);
}

if (update && updated.length > 0) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

console.log(`frontend-deps: 校验 ${Object.keys(manifest.packages).length} 个包（node_modules 实际安装版本）`);
for (const name of updated) console.log(`~ ${name} 已更新`);
for (const warning of warnings) console.log(`! ${warning}`);

if (problems.length === 0) {
  console.log(`✔ 全部一致${updated.length > 0 ? "（版本号已刷新，请复核说明文字）" : ""}`);
  process.exit(0);
}

for (const problem of problems) console.log(`✘ ${problem}`);
console.log(`\n${problems.length} 个问题。改完 references/deps.json 与本目录的 frontend.md 后重跑。`);
process.exit(1);