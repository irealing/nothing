//! Workspace: opening/creating encrypted `.nothing` files and connection management.
//!
//! 铁律 5/9: every connection sets `foreign_keys=ON` and `busy_timeout`; the
//! workspace owns a single write connection behind a `Mutex`. Read pooling is
//! added in M2 when the query layer lands.

pub mod migrate;

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::Connection;

use crate::error::{AppError, Result};

/// Magic value stored in `_nothing`, identifying a nothing workspace file.
pub const MAGIC: &str = "nothing-db";

/// Recommended file extension for workspace files.
pub const FILE_EXTENSION: &str = "nothing";

/// Version string recorded as `created_by` in new workspaces.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

const BUSY_TIMEOUT_MS: i32 = 5_000;

/// An open nothing workspace (one encrypted SQLite file).
///
/// Clone-free by design: a single writer connection serializes all mutations
/// (铁律 9). All schema operations live in [`crate::schema`].
#[derive(Debug)]
pub struct Workspace {
    path: PathBuf,
    conn: Mutex<Connection>,
}

impl Workspace {
    /// Create a new encrypted workspace at `path`.
    ///
    /// Fails if the file already exists and is non-empty.
    pub fn create(path: impl AsRef<Path>, password: &str) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if password.is_empty() {
            return Err(AppError::InvalidInput("密码不能为空".into()));
        }
        if path.exists() && std::fs::metadata(&path)?.len() > 0 {
            return Err(AppError::AlreadyExists(path.display().to_string()));
        }
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }

        let mut conn = Connection::open(&path)?;
        conn.pragma_update(None, "key", password)?;
        apply_connection_pragmas(&conn)?;
        migrate::bootstrap(&mut conn)?;
        Ok(Self {
            path,
            conn: Mutex::new(conn),
        })
    }

    /// Open an existing workspace, verifying password and file identity.
    ///
    /// Distinguishes the three failure modes: wrong password
    /// ([`AppError::WrongPassword`]), not-a-nothing-file
    /// ([`AppError::NotANothingDb`]) and a too-new format version
    /// ([`AppError::FormatTooNew`]). Runs pending format migrations.
    pub fn open(path: impl AsRef<Path>, password: &str) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Err(AppError::NotFound(path.display().to_string()));
        }
        if std::fs::metadata(&path)?.len() == 0 {
            return Err(AppError::NotANothingDb);
        }

        // A plaintext SQLite file starts with this header; a SQLCipher file
        // starts with a random salt. Reject plaintext files up front so we can
        // tell "not ours" apart from "wrong password".
        let mut head = [0u8; 16];
        File::open(&path)?.read_exact(&mut head)?;
        if head.starts_with(b"SQLite format 3") {
            return Err(AppError::NotANothingDb);
        }

        let mut conn = Connection::open(&path)?;
        conn.pragma_update(None, "key", password)?;
        // Any read fails with "file is not a database" if the key is wrong.
        let _: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
            .map_err(|_| AppError::WrongPassword)?;
        apply_connection_pragmas(&conn)?;
        migrate::verify_and_migrate(&mut conn)?;

        Ok(Self {
            path,
            conn: Mutex::new(conn),
        })
    }

    /// Path of the underlying `.nothing` file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Current on-disk format version of this workspace.
    pub fn format_version(&self) -> Result<u32> {
        self.with_conn(|conn| migrate::read_format_version(conn))
    }

    /// Re-encrypt the whole file with a new password (`PRAGMA rekey`).
    pub fn change_password(&self, new_password: &str) -> Result<()> {
        if new_password.is_empty() {
            return Err(AppError::InvalidInput("密码不能为空".into()));
        }
        self.with_conn(|conn| {
            conn.pragma_update(None, "rekey", new_password)?;
            Ok(())
        })
    }

    /// Run `f` with exclusive access to the write connection.
    pub(crate) fn with_conn<R>(&self, f: impl FnOnce(&mut Connection) -> Result<R>) -> Result<R> {
        let mut guard: MutexGuard<Connection> = self
            .conn
            .lock()
            .map_err(|_| AppError::Internal("数据库连接锁已损坏".into()))?;
        f(&mut guard)
    }

    /// Run `f` inside a single transaction (铁律 1); rolls back on any error.
    pub(crate) fn with_tx<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        self.with_conn(|conn| {
            let tx = conn.transaction()?;
            let out = f(&tx)?;
            tx.commit()?;
            Ok(out)
        })
    }
}

fn apply_connection_pragmas(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "busy_timeout", BUSY_TIMEOUT_MS)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}
