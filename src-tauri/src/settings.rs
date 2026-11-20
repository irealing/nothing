//! App-shell settings: the *last opened workspace* pointer, the recent-files
//! list, and per-workspace UI state (last table / view).
//!
//! This deliberately lives outside the encrypted workspace file: the pointer
//! has to be readable *before* a password exists, and it is not workspace data
//! (so it must never touch `format_version`). It is the same trade-off as the
//! OS recent-documents list: paths are stored in plain text.
//!
//! File: `<app config dir>/settings.json`.
//! - Written atomically (temp file + rename) so a crash never leaves half JSON.
//! - A missing, unreadable or corrupt file degrades to defaults; it must never
//!   block startup.
//! - Only pure helpers are unit-tested here; the Tauri-facing wrappers are thin.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Bumped only when the on-disk shape changes in a way that needs migration.
pub const SCHEMA: u32 = 1;
/// How many workspaces to remember in the "recent" list.
pub const RECENT_LIMIT: usize = 8;
pub const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    #[serde(default)]
    pub schema: u32,
    #[serde(default)]
    pub last_workspace: Option<RecentWorkspace>,
    #[serde(default)]
    pub recent: Vec<RecentWorkspace>,
    /// Normalized workspace path → last active table / view.
    #[serde(default)]
    pub ui_state: BTreeMap<String, UiState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentWorkspace {
    /// Path as the user opened it (kept verbatim for display).
    pub path: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct UiState {
    pub table_id: Option<String>,
    pub view_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// Read settings, falling back to defaults on any problem.
pub fn load(dir: &Path) -> Settings {
    let text = std::fs::read_to_string(dir.join(FILE_NAME)).ok();
    let mut settings = text
        .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
        .unwrap_or_default();
    if settings.schema == 0 {
        settings.schema = SCHEMA;
    }
    settings
}

/// Write settings atomically (create the directory on first run).
pub fn save(dir: &Path, settings: &Settings) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{FILE_NAME}.tmp"));
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, json)?;
    // `rename` replaces the destination on both Windows and Unix.
    std::fs::rename(&tmp, dir.join(FILE_NAME))
}

/// Record a successful open: move it to the front of `recent` and make it the
/// last workspace. Deduplicates by normalized path.
pub fn remember(settings: &mut Settings, raw_path: &str, at: &str) {
    let key = normalize_key(raw_path);
    settings.last_workspace = Some(entry(raw_path, at));
    settings.recent.retain(|r| normalize_key(&r.path) != key);
    settings.recent.insert(0, entry(raw_path, at));
    settings.recent.truncate(RECENT_LIMIT);
}

impl Settings {
    /// Store the last active table/view for a workspace. Returns whether the
    /// value actually changed, so callers can skip a pointless disk write.
    pub fn set_ui(
        &mut self,
        raw_path: &str,
        table_id: Option<String>,
        view_id: Option<String>,
    ) -> bool {
        let key = normalize_key(raw_path);
        let next = UiState { table_id, view_id };
        if self.ui_state.get(&key) == Some(&next) {
            return false;
        }
        self.ui_state.insert(key, next);
        true
    }

    pub fn ui_for(&self, raw_path: &str) -> Option<&UiState> {
        self.ui_state.get(&normalize_key(raw_path))
    }
}

fn entry(path: &str, at: &str) -> RecentWorkspace {
    RecentWorkspace {
        path: path.to_string(),
        opened_at: at.to_string(),
    }
}

/// Canonicalize when possible and fold case on Windows, so the same file opened
/// through different paths (or different casing / separators) hits one key.
pub fn normalize_key(raw: &str) -> String {
    let canon = std::fs::canonicalize(Path::new(raw)).unwrap_or_else(|_| PathBuf::from(raw));
    let text = strip_verbatim_prefix(canon.to_string_lossy().into_owned());
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// `canonicalize` on Windows yields `\\?\C:\...`; drop the verbatim marker for
/// drive-letter paths so the JSON keys stay readable (UNC roots are kept).
fn strip_verbatim_prefix(text: String) -> String {
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => text,
    }
}

/// The `.nothing` file passed on the command line, if any.
///
/// Accepts the raw `argv` (index 0 included): the executable never ends in
/// `.nothing`, and flags such as `--config` are ignored, so no positional
/// bookkeeping is needed.
pub fn pick_workspace_arg<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .map(|a| a.as_ref().to_string())
        .find(|a| !a.starts_with('-') && a.to_ascii_lowercase().ends_with(".nothing"))
}

// ---------------------------------------------------------------------------
// Tauri glue (thin: resolve the config dir, then defer to the pure helpers)
// ---------------------------------------------------------------------------

/// A recent entry as returned to the frontend, plus whether the file is still
/// reachable (a USB stick or network share may be off-line right now).
#[derive(Debug, Serialize)]
pub struct RecentView {
    pub path: String,
    pub opened_at: String,
    pub exists: bool,
}

#[derive(Debug, Serialize)]
pub struct SettingsView {
    pub last_workspace: Option<RecentView>,
    pub recent: Vec<RecentView>,
}

pub fn config_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok()
}

fn view_entry(r: RecentWorkspace) -> RecentView {
    RecentView {
        exists: Path::new(&r.path).exists(),
        opened_at: r.opened_at,
        path: r.path,
    }
}

pub fn view(app: &tauri::AppHandle) -> SettingsView {
    let settings = config_dir(app).map(|d| load(&d)).unwrap_or_default();
    SettingsView {
        last_workspace: settings.last_workspace.map(view_entry),
        recent: settings.recent.into_iter().map(view_entry).collect(),
    }
}

/// Never fails the open: losing the pointer is a nuisance, not a data error.
pub fn remember_path(app: &tauri::AppHandle, raw_path: &str) {
    let Some(dir) = config_dir(app) else { return };
    let mut settings = load(&dir);
    remember(
        &mut settings,
        raw_path,
        &nothing_core::schema::ident::now_iso(),
    );
    let _ = save(&dir, &settings);
}

pub fn ui_for(app: &tauri::AppHandle, raw_path: &str) -> Option<UiState> {
    config_dir(app)
        .map(|d| load(&d))
        .and_then(|s| s.ui_for(raw_path).cloned())
}

pub fn set_ui(
    app: &tauri::AppHandle,
    raw_path: &str,
    table_id: Option<String>,
    view_id: Option<String>,
) {
    let Some(dir) = config_dir(app) else { return };
    let mut settings = load(&dir);
    if !settings.set_ui(raw_path, table_id, view_id) {
        return;
    }
    let _ = save(&dir, &settings);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "nothing-settings-{nanos}-{}",
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = temp_dir();
        let settings = load(&dir);
        assert_eq!(settings.schema, SCHEMA);
        assert!(settings.last_workspace.is_none());
        assert!(settings.recent.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = temp_dir();
        let mut settings = Settings {
            schema: SCHEMA,
            ..Settings::default()
        };
        remember(&mut settings, "D:\\data\\a.nothing", "2026-01-01T00:00:00Z");
        settings.set_ui("D:\\data\\a.nothing", Some("t1".into()), Some("v1".into()));
        save(&dir, &settings).unwrap();
        assert_eq!(load(&dir), settings);
        // The temp file must not be left behind.
        assert!(!dir.join(format!("{FILE_NAME}.tmp")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let dir = temp_dir();
        std::fs::write(dir.join(FILE_NAME), b"{ not json").unwrap();
        assert_eq!(load(&dir).schema, SCHEMA);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remember_dedupes_caps_and_reorders() {
        let mut settings = Settings::default();
        for i in 0..(RECENT_LIMIT + 3) {
            remember(&mut settings, &format!("D:\\data\\{i}.nothing"), "t");
        }
        assert_eq!(settings.recent.len(), RECENT_LIMIT);
        assert_eq!(
            settings.recent[0].path,
            format!("D:\\data\\{}.nothing", RECENT_LIMIT + 2)
        );
        // Re-opening an existing entry moves it to the front without duplicating.
        remember(&mut settings, "D:\\data\\5.nothing", "t2");
        assert_eq!(settings.recent.len(), RECENT_LIMIT);
        assert_eq!(settings.recent[0].path, "D:\\data\\5.nothing");
        assert_eq!(settings.recent[0].opened_at, "t2");
        assert_eq!(
            settings
                .recent
                .iter()
                .filter(|r| r.path == "D:\\data\\5.nothing")
                .count(),
            1
        );
        assert_eq!(
            settings.last_workspace.as_ref().unwrap().path,
            "D:\\data\\5.nothing"
        );
    }

    #[test]
    fn ui_state_round_trips_by_normalized_key() {
        let dir = temp_dir();
        let file = dir.join("a.nothing");
        std::fs::write(&file, b"x").unwrap();
        let path = file.to_string_lossy().into_owned();

        let mut settings = Settings::default();
        assert!(settings.set_ui(&path, Some("t9".into()), Some("v9".into())));
        // Writing the same value again is a no-op (avoids a needless save).
        assert!(!settings.set_ui(&path, Some("t9".into()), Some("v9".into())));

        // A differently-spelled path (separators / casing) resolves to the same key.
        let other = path.replace('\\', "/");
        let looked_up = settings
            .ui_for(&other)
            .or_else(|| settings.ui_for(&path))
            .expect("ui state found");
        assert_eq!(looked_up.table_id.as_deref(), Some("t9"));

        #[cfg(windows)]
        assert!(settings.ui_for(&path.to_uppercase()).is_some());

        // Keys are stored without the `\\?\` verbatim marker and lower-cased.
        let key = settings.ui_state.keys().next().unwrap();
        assert!(key.ends_with("a.nothing"), "{key}");
        assert!(!key.starts_with(r"\\?\"), "{key}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn picks_only_nothing_paths_from_argv() {
        assert_eq!(
            pick_workspace_arg(["nothing.exe", "C:\\data\\a.nothing"]),
            Some("C:\\data\\a.nothing".into())
        );
        assert_eq!(
            pick_workspace_arg(["nothing.exe", "--config=x.nothing"]),
            None
        );
        assert_eq!(pick_workspace_arg(["nothing.exe", "notes.txt"]), None);
        assert_eq!(pick_workspace_arg(["nothing.exe"]), None);
        assert_eq!(
            pick_workspace_arg(["nothing.exe", "a.NOTHING"]),
            Some("a.NOTHING".into())
        );
    }
}
