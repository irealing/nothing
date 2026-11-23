//! Unified error type for the storage kernel.

/// Error type returned by all kernel APIs.
///
/// Carries a machine-readable discriminant (for the frontend to branch on) and
/// a human-readable message (safe to show to the user).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// Wrong password, or the file is not encrypted with the given key.
    #[error("密码错误，无法解密该文件")]
    WrongPassword,

    /// The file decrypted fine but is not a nothing workspace
    /// (`_nothing` manifest missing or magic mismatch).
    #[error("不是 nothing 数据库文件")]
    NotANothingDb,

    /// The workspace format version is newer than this app supports.
    #[error("数据库格式版本过新（{0}），请升级 nothing")]
    FormatTooNew(u32),

    /// The workspace uses an obsolete format version (pre-release v1–v3).
    #[error("数据库格式过旧（v{0}），请新建工作区")]
    FormatTooOld(u32),

    /// A referenced object (table/column/view/row) does not exist.
    #[error("对象不存在: {0}")]
    NotFound(String),

    /// A uniqueness violation (duplicate table/view name, duplicate column name...).
    #[error("名称已存在: {0}")]
    AlreadyExists(String),

    /// User input failed validation (bad column type, bad formula, bad view SQL...).
    #[error("输入无效: {0}")]
    InvalidInput(String),

    /// An operation would break referential or schema integrity.
    #[error("操作被拒绝: {0}")]
    Rejected(String),

    /// The workspace file could not be accessed (missing, locked, permission...).
    #[error("无法访问文件: {0}")]
    Io(#[from] std::io::Error),

    /// Underlying SQLite error.
    #[error("数据库错误: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// JSON (de)serialization error on metadata.
    #[error("数据格式错误: {0}")]
    Json(#[from] serde_json::Error),

    /// Internal invariant violated (bug, poisoned lock, integrity check failure).
    #[error("内部错误: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, AppError>;
