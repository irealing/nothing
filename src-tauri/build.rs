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
    // A branch switch only rewrites HEAD, so watch it explicitly: without this
    // the reported commit would lag behind until some source file changed.
    // Emitting any `rerun-if-changed` replaces Cargo's "watch the whole crate"
    // default, hence the explicit source/config paths below.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    if let Some(git_dir) = git(&["rev-parse", "--git-dir"]) {
        println!("cargo:rerun-if-changed={}/HEAD", native_path(&git_dir));
    }

    let describe = git(&["describe", "--tags", "--long", "--always", "--dirty"])
        .unwrap_or_else(|| UNKNOWN.into());
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| UNKNOWN.into());
    let build_time = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);

    println!("cargo:rustc-env=NOTHING_GIT_DESCRIBE={describe}");
    println!("cargo:rustc-env=NOTHING_GIT_BRANCH={branch}");
    println!("cargo:rustc-env=NOTHING_BUILD_TIME={build_time}");
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!text.is_empty()).then_some(text)
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
