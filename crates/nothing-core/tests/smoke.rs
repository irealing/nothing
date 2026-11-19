//! Smoke test: verify the SQLCipher toolchain works end to end.

#[test]
fn sqlcipher_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("smoke.nothing");

    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "key", "s3cret").unwrap();
        conn.execute_batch("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('hello');")
            .unwrap();
    }

    // Correct password decrypts.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "key", "s3cret").unwrap();
    let x: String = conn.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
    assert_eq!(x, "hello");

    // Wrong password must fail on read.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "key", "wrong").unwrap();
    assert!(conn
        .query_row("SELECT x FROM t", [], |r| r.get::<_, String>(0))
        .is_err());

    // File must not contain plaintext.
    let bytes = std::fs::read(&path).unwrap();
    assert!(
        !bytes.windows(5).any(|w| w == b"hello"),
        "database file is not encrypted"
    );
    // SQLCipher files do NOT carry the "SQLite format 3" header.
    assert!(!bytes.starts_with(b"SQLite format 3"));
}
