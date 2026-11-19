//! Workspace lifecycle: create/open, password verification, file identity
//! (`_nothing` magic), format version, password change.

mod common;

use common::{db_path, raw, PASSWORD};
use nothing_core::{AppError, Workspace, MAGIC};

#[test]
fn create_then_open_roundtrip() {
    let (dir, ws) = common::create_ws("a.nothing");
    let path = db_path(&dir, "a.nothing");
    assert_eq!(ws.format_version().unwrap(), 1);
    assert_eq!(ws.path(), path.as_path());
    drop(ws);

    let ws2 = Workspace::open(&path, PASSWORD).unwrap();
    assert_eq!(ws2.format_version().unwrap(), 1);
}

#[test]
fn manifest_contents() {
    let (dir, _ws) = common::create_ws("m.nothing");
    let conn = raw(&db_path(&dir, "m.nothing"));
    let magic: String = conn
        .query_row(r#"SELECT value FROM _nothing WHERE key='magic'"#, [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(magic, MAGIC);
    let created_by: String = conn
        .query_row(
            r#"SELECT value FROM _nothing WHERE key='created_by'"#,
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(created_by.starts_with("nothing "));
    // Metadata tables exist and are STRICT.
    for t in ["_nothing", "_tables", "_columns", "_views"] {
        let sql: String = conn
            .query_row(
                "SELECT COALESCE(sql,'') FROM sqlite_master WHERE name=?1",
                [t],
                |r| r.get(0),
            )
            .unwrap();
        assert!(sql.contains("STRICT"), "{t} should be STRICT: {sql}");
    }
}

#[test]
fn wrong_password_is_rejected() {
    let (dir, ws) = common::create_ws("w.nothing");
    let path = db_path(&dir, "w.nothing");
    drop(ws);
    let err = Workspace::open(&path, "definitely-wrong").unwrap_err();
    assert!(matches!(err, AppError::WrongPassword), "{err:?}");
}

#[test]
fn plaintext_sqlite_file_is_not_a_nothing_db() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plain.nothing");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE x (a); INSERT INTO x VALUES (1);")
            .unwrap();
    }
    let err = Workspace::open(&path, "anything").unwrap_err();
    assert!(matches!(err, AppError::NotANothingDb), "{err:?}");
}

#[test]
fn encrypted_but_foreign_file_is_not_a_nothing_db() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("foreign.nothing");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "key", PASSWORD).unwrap();
        conn.execute_batch("CREATE TABLE x (a);").unwrap();
    }
    let err = Workspace::open(&path, PASSWORD).unwrap_err();
    assert!(matches!(err, AppError::NotANothingDb), "{err:?}");
}

#[test]
fn empty_or_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.nothing");
    assert!(matches!(
        Workspace::open(&missing, PASSWORD).unwrap_err(),
        AppError::NotFound(_)
    ));
    std::fs::write(dir.path().join("empty.nothing"), []).unwrap();
    assert!(matches!(
        Workspace::open(dir.path().join("empty.nothing"), PASSWORD).unwrap_err(),
        AppError::NotANothingDb
    ));
}

#[test]
fn create_refuses_existing_file_and_empty_password() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.nothing");
    let _ws = Workspace::create(&path, PASSWORD).unwrap();
    let err = Workspace::create(&path, PASSWORD).unwrap_err();
    assert!(matches!(err, AppError::AlreadyExists(_)), "{err:?}");
    let err = Workspace::create(dir.path().join("c2.nothing"), "").unwrap_err();
    assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
}

#[test]
fn change_password_reencrypts() {
    let (dir, ws) = common::create_ws("p.nothing");
    let path = db_path(&dir, "p.nothing");
    ws.change_password("new-pass").unwrap();
    drop(ws);
    assert!(matches!(
        Workspace::open(&path, PASSWORD).unwrap_err(),
        AppError::WrongPassword
    ));
    Workspace::open(&path, "new-pass").unwrap();
}

#[test]
fn file_contains_no_plaintext_metadata() {
    let (dir, ws) = common::create_ws("enc.nothing");
    ws.create_table(
        "机密表",
        vec![common::col("姓名", nothing_core::ColumnType::Text)],
    )
    .unwrap();
    let path = db_path(&dir, "enc.nothing");
    drop(ws);
    let bytes = std::fs::read(&path).unwrap();
    assert!(!bytes.starts_with(b"SQLite format 3"));
    for needle in ["_nothing", "_tables", "机密表"] {
        let n = needle.as_bytes();
        assert!(
            !bytes.windows(n.len()).any(|w| w == n),
            "plaintext leak: {needle}"
        );
    }
}
