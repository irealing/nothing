use std::path::{Path, PathBuf};
use std::process::Command;

const UNKNOWN: &str = "unknown";

fn main() {
    emit_build_metadata();
    tauri_build::build();
}

/// Stamp the binary with the git revision and build time for the About dialog
/// (bug reports need to name the exact binary). Best-effort by design: a source
/// tarball without `.git`, or a machine without git, must still compile.
fn emit_build_metadata() {
    // Emitting any `rerun-if-changed` replaces Cargo's "watch the whole crate"
    // default, hence the explicit source/config paths below.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    // The frontend bundle is embedded in the binary, so a rebuilt `dist/` is a
    // new binary and deserves a new build time.
    watch(Path::new("../dist"));
    watch_git();

    let describe = git(&["describe", "--tags", "--long", "--always", "--dirty"])
        .unwrap_or_else(|| UNKNOWN.into());
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| UNKNOWN.into());
    let build_time = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    println!("cargo:rustc-env=NOTHING_GIT_DESCRIBE={describe}");
    println!("cargo:rustc-env=NOTHING_GIT_BRANCH={branch}");
    println!("cargo:rustc-env=NOTHING_BUILD_TIME={build_time}");
}

/// Watch a path so Cargo re-runs this script when it changes. Missing paths are
/// skipped: Cargo treats an absent watched path as permanently stale and would
/// re-run the script (moving the build time) on every single build.
fn watch(path: &Path) {
    if path.exists() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

/// Watch everything `git describe` reads.
///
/// A commit only rewrites the branch ref (`.git/refs/heads/<branch>`, or
/// `packed-refs` once `git gc` has packed it) and leaves `.git/HEAD` untouched,
/// so watching HEAD alone pinned the reported commit to whatever the last
/// checkout saw.
fn watch_git() {
    if let Some(git_dir) = git(&["rev-parse", "--absolute-git-dir"]) {
        watch(&absolute(&git_dir).join("HEAD"));
    }
    let Some(common) = git(&["rev-parse", "--git-common-dir"]).map(|p| absolute(&p)) else {
        return;
    };
    // Packed tags/branches: `git gc` rewrites this instead of the loose refs.
    watch(&common.join("packed-refs"));
    // A loose ref reappears here after being packed, and new branches land here.
    watch(&common.join("refs").join("heads"));
    // A new tag changes `describe` without moving HEAD.
    watch(&common.join("refs").join("tags"));
    if let Some(branch) = git(&["rev-parse", "--abbrev-ref", "HEAD"]) {
        // Detached HEAD is already covered by watching HEAD itself.
        if branch != "HEAD" {
            watch(&common.join("refs").join("heads").join(branch));
        }
    }
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Cargo needs an absolute path to watch reliably; git may hand back a relative
/// one (worktrees) or an MSYS one (`/d/repo/.git`).
fn absolute(path: &str) -> PathBuf {
    let path = PathBuf::from(native_path(path));
    if path.is_absolute() {
        return path;
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(&path))
        .unwrap_or(path)
}

/// Some git builds hand back MSYS paths (`/d/repo/.git`) even on Windows, which
/// Cargo cannot watch; translate the drive prefix to `D:\repo\.git`.
fn native_path(path: &str) -> String {
    let bytes = path.as_bytes();
    if cfg!(windows)
        && bytes.len() > 2
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b'/'
    {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        return format!("{drive}:{}", path[2..].replace('/', "\\"));
    }
    path.to_string()
}
