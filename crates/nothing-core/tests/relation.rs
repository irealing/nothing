//! Relations: junction tables, cascading FKs, reverse columns, single-mode
//! tightening, and cleanup when tables/columns go away.

mod common;

use common::{emp_task_fixture, object_exists, raw, raw_insert_row};
use nothing_core::schema::ident::junction_sql_name;
use nothing_core::{AppError, ColumnPatch};

fn dbp(dir: &tempfile::TempDir, name: &str) -> std::path::PathBuf {
    dir.path().join(name)
}

fn link(conn: &rusqlite::Connection, junction: &str, a: &str, b: &str, ord: i64) {
    conn.execute(
        &format!(r#"INSERT INTO "{junction}" ("a", "b", "ord") VALUES (?1, ?2, ?3)"#),
        rusqlite::params![a, b, ord],
    )
    .unwrap();
}

#[test]
fn relation_creates_junction_and_reverse_column() {
    let (dir, ws) = common::create_ws("rel.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
        )
        .unwrap();

    let conn = raw(&dbp(&dir, "rel.nothing"));
    let junction = junction_sql_name(&rel.id);
    assert!(object_exists(&conn, &junction));
    assert!(object_exists(&conn, &format!("{junction}_rev")));

    // reverse column exists in 员工, sharing the same junction
    let emp_cols = ws.list_columns(&f.emp_table.id).unwrap();
    let reverse = emp_cols
        .iter()
        .find(|c| c.is_reverse())
        .expect("reverse col");
    assert_eq!(reverse.name, "相关任务");
    assert_eq!(reverse.origin_id(), Some(rel.id.as_str()));
    // reverse has no physical column
    let emp_phys = ws.physical_columns(&f.emp_table.id).unwrap();
    let reverse_sql = reverse.sql_name();
    assert!(emp_phys
        .iter()
        .all(|(n, _)| Some(n.as_str()) != reverse_sql));

    // junction FK definitions point at both tables with CASCADE
    let ddl: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = ?1",
            [&junction],
            |r| r.get(0),
        )
        .unwrap();
    assert!(ddl.contains(&f.task_table.sql_name), "{ddl}");
    assert!(ddl.contains(&f.emp_table.sql_name), "{ddl}");
    assert_eq!(ddl.matches("ON DELETE CASCADE").count(), 2, "{ddl}");
    assert!(ddl.contains("STRICT"), "{ddl}");
}

#[test]
fn cascade_delete_removes_links_both_directions() {
    let (dir, ws) = common::create_ws("casc.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
        )
        .unwrap();
    let conn = raw(&dbp(&dir, "casc.nothing"));
    let junction = junction_sql_name(&rel.id);

    raw_insert_row(&conn, &f.emp_table.sql_name, "emp1");
    raw_insert_row(&conn, &f.emp_table.sql_name, "emp2");
    raw_insert_row(&conn, &f.task_table.sql_name, "task1");
    raw_insert_row(&conn, &f.task_table.sql_name, "task2");
    link(&conn, &junction, "task1", "emp1", 0);
    link(&conn, &junction, "task1", "emp2", 1);
    link(&conn, &junction, "task2", "emp1", 0);

    // delete employee 1 → both its links vanish (database-enforced)
    conn.execute(
        &format!(
            r#"DELETE FROM "{}" WHERE _rid = 'emp1'"#,
            f.emp_table.sql_name
        ),
        [],
    )
    .unwrap();
    let n: i64 = conn
        .query_row(&format!(r#"SELECT count(*) FROM "{junction}""#), [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 1); // only task1→emp2 remains

    // delete task 1 → remaining link vanishes
    conn.execute(
        &format!(
            r#"DELETE FROM "{}" WHERE _rid = 'task1'"#,
            f.task_table.sql_name
        ),
        [],
    )
    .unwrap();
    let n: i64 = conn
        .query_row(&format!(r#"SELECT count(*) FROM "{junction}""#), [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 0);

    // inserting a link to a non-existent row is rejected by the FK
    let err = conn
        .execute(
            &format!(r#"INSERT INTO "{junction}" ("a","b") VALUES ('task2','ghost')"#),
            [],
        )
        .unwrap_err();
    assert!(err.to_string().contains("FOREIGN KEY"), "{err}");
}

#[test]
fn reverse_lookup_uses_index() {
    let (dir, ws) = common::create_ws("rev.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, None),
        )
        .unwrap();
    let conn = raw(&dbp(&dir, "rev.nothing"));
    let junction = junction_sql_name(&rel.id);
    raw_insert_row(&conn, &f.emp_table.sql_name, "emp1");
    raw_insert_row(&conn, &f.task_table.sql_name, "t1");
    raw_insert_row(&conn, &f.task_table.sql_name, "t2");
    link(&conn, &junction, "t1", "emp1", 0);
    link(&conn, &junction, "t2", "emp1", 0);

    // "emp1 的所有任务" — one indexed query
    let tasks: Vec<String> = conn
        .prepare(&format!(
            r#"SELECT t._rid FROM "{junction}" j JOIN "{}" t ON t._rid = j.a WHERE j.b = 'emp1' ORDER BY j.a"#,
            f.task_table.sql_name
        ))
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(tasks, vec!["t1".to_string(), "t2".to_string()]);

    let plan: String = conn
        .query_row(
            &format!(r#"EXPLAIN QUERY PLAN SELECT a FROM "{junction}" WHERE b = 'emp1'"#),
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(plan.contains(&format!("{junction}_rev")), "plan: {plan}");
}

#[test]
fn deleting_reverse_column_keeps_source_and_data() {
    let (_dir, ws) = common::create_ws("drev.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
        )
        .unwrap();
    let reverse_id = ws
        .list_columns(&f.emp_table.id)
        .unwrap()
        .into_iter()
        .find(|c| c.is_reverse())
        .unwrap()
        .id;
    ws.delete_column(&f.emp_table.id, &reverse_id).unwrap();
    // source column and junction untouched
    let cols = ws.list_columns(&f.task_table.id).unwrap();
    assert!(cols.iter().any(|c| c.id == rel.id));
    assert!(ws
        .schema_objects(&junction_sql_name(&rel.id))
        .unwrap()
        .contains(&junction_sql_name(&rel.id)));
}

#[test]
fn single_mode_tightening_truncates_extra_links() {
    let (dir, ws) = common::create_ws("single.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, None),
        )
        .unwrap();
    let conn = raw(&dbp(&dir, "single.nothing"));
    let junction = junction_sql_name(&rel.id);
    raw_insert_row(&conn, &f.emp_table.sql_name, "e1");
    raw_insert_row(&conn, &f.emp_table.sql_name, "e2");
    raw_insert_row(&conn, &f.task_table.sql_name, "t1");
    link(&conn, &junction, "t1", "e2", 1);
    link(&conn, &junction, "t1", "e1", 0);
    drop(conn);

    ws.update_column(
        &f.task_table.id,
        &rel.id,
        ColumnPatch {
            single: Some(true),
            ..Default::default()
        },
    )
    .unwrap();

    let conn = raw(&dbp(&dir, "single.nothing"));
    let kept: Vec<String> = conn
        .prepare(&format!(r#"SELECT b FROM "{junction}""#))
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(kept, vec!["e1".to_string()]); // lowest ord kept
}

#[test]
fn deleting_target_table_removes_inbound_relation_columns() {
    let (dir, ws) = common::create_ws("dtgt.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
        )
        .unwrap();
    let conn = raw(&dbp(&dir, "dtgt.nothing"));
    raw_insert_row(&conn, &f.emp_table.sql_name, "e1");
    raw_insert_row(&conn, &f.task_table.sql_name, "t1");
    link(&conn, &junction_sql_name(&rel.id), "t1", "e1", 0);
    drop(conn);

    ws.delete_table(&f.emp_table.id).unwrap();

    // task table intact, but the relation column is gone
    let task_cols = ws.list_columns(&f.task_table.id).unwrap();
    assert!(task_cols
        .iter()
        .all(|c| c.col_type() != nothing_core::ColumnType::Relation));
    assert!(task_cols.iter().any(|c| c.name == "标题"));
    let conn = raw(&dbp(&dir, "dtgt.nothing"));
    assert!(!object_exists(&conn, &junction_sql_name(&rel.id)));
    assert_eq!(common::raw_count(&conn, &f.task_table.sql_name), 1);
    // no dangling FK references anywhere
    let violations: i64 = conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);
}

#[test]
fn relation_target_must_exist_and_self_relation_allowed() {
    let (_dir, ws) = common::create_ws("tgt.nothing");
    let f = emp_task_fixture(&ws);
    let err = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("指向虚无", "01NONEXISTENT0000000000000", None),
        )
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");

    // self-relation (e.g. 任务的前置任务)
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("前置任务", &f.task_table.id, None),
        )
        .unwrap();
    assert!(rel.relation().is_some());
}

#[test]
fn relation_data_survives_unrelated_table_rebuild() {
    // A type change on the *task* table rebuilds t_task with fk OFF —
    // junction rows must survive (regression guard for cascade-on-rebuild).
    let (dir, ws) = common::create_ws("surv.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("负责人", &f.emp_table.id, Some("相关任务")),
        )
        .unwrap();
    let conn = raw(&dbp(&dir, "surv.nothing"));
    let junction = junction_sql_name(&rel.id);
    raw_insert_row(&conn, &f.emp_table.sql_name, "e1");
    raw_insert_row(&conn, &f.task_table.sql_name, "t1");
    link(&conn, &junction, "t1", "e1", 0);
    drop(conn);

    // 工时: number → text forces a rebuild of t_task
    ws.update_column(
        &f.task_table.id,
        &f.task_cols[1].id,
        ColumnPatch {
            col_type: Some(nothing_core::ColumnType::Text),
            ..Default::default()
        },
    )
    .unwrap();

    let conn = raw(&dbp(&dir, "surv.nothing"));
    let n: i64 = conn
        .query_row(&format!(r#"SELECT count(*) FROM "{junction}""#), [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 1, "junction rows must survive table rebuild");
    assert_eq!(common::raw_count(&conn, &f.emp_table.sql_name), 1);
}

#[test]
fn delete_snapshot_restores_row_and_both_link_directions() {
    let (dir, ws) = common::create_ws("restore.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("Owner", &f.emp_table.id, Some("Tasks")),
        )
        .unwrap();
    let conn = raw(&dbp(&dir, "restore.nothing"));
    let junction = junction_sql_name(&rel.id);

    let emp_name = f.emp_cols[0].id.clone();
    let mut cells = nothing_core::Cells::new();
    cells.insert(emp_name, serde_json::json!("Alice"));
    let alice = ws.insert_row(&f.emp_table.id, cells).unwrap();

    raw_insert_row(&conn, &f.task_table.sql_name, "task1");
    raw_insert_row(&conn, &f.task_table.sql_name, "task2");
    // Inbound links: two tasks point at alice (b side of the junction).
    link(&conn, &junction, "task1", &alice.rid, 0);
    link(&conn, &junction, "task2", &alice.rid, 1);

    let snapshot = ws
        .delete_rows_snapshot(&f.emp_table.id, std::slice::from_ref(&alice.rid))
        .unwrap();
    assert_eq!(snapshot.rows.len(), 1);
    assert_eq!(snapshot.rows[0].rid, alice.rid);
    assert_eq!(snapshot.rows[0].created, alice.created);
    assert_eq!(
        snapshot.rows[0].cells.get(&f.emp_cols[0].id),
        Some(&serde_json::json!("Alice"))
    );
    // Both inbound edges were captured, not just the deleted row's own links.
    assert_eq!(snapshot.links.len(), 2);
    assert!(ws.get_row(&f.emp_table.id, &alice.rid).is_err());

    ws.restore_rows(&snapshot).unwrap();
    let restored = ws.get_row(&f.emp_table.id, &alice.rid).unwrap();
    assert_eq!(restored.rid, alice.rid);
    assert_eq!(restored.created, alice.created);
    assert_eq!(
        restored.cells.get(&f.emp_cols[0].id),
        Some(&serde_json::json!("Alice"))
    );
    // The same junction edges are back, with their original order.
    let links: Vec<(String, String, i64)> = conn
        .prepare(&format!(
            r#"SELECT "a", "b", "ord" FROM "{junction}" ORDER BY "ord""#
        ))
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(
        links,
        vec![
            ("task1".to_string(), alice.rid.clone(), 0),
            ("task2".to_string(), alice.rid.clone(), 1),
        ]
    );
}

#[test]
fn delete_snapshot_restores_outbound_links_and_cascades_cleanly() {
    let (_dir, ws) = common::create_ws("restore-out.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("Owner", &f.emp_table.id, None),
        )
        .unwrap();

    let emp_name = f.emp_cols[0].id.clone();
    let mut emp_cells = nothing_core::Cells::new();
    emp_cells.insert(emp_name.clone(), serde_json::json!("Bob"));
    let bob = ws.insert_row(&f.emp_table.id, emp_cells).unwrap();

    let mut task_cells = nothing_core::Cells::new();
    task_cells.insert(rel.id.clone(), serde_json::json!([bob.rid]));
    let task = ws.insert_row(&f.task_table.id, task_cells).unwrap();
    let before = ws.get_row(&f.task_table.id, &task.rid).unwrap();
    assert_eq!(
        before.cells.get(&rel.id),
        Some(&serde_json::json!([bob.rid]))
    );

    let snapshot = ws
        .delete_rows_snapshot(&f.task_table.id, std::slice::from_ref(&task.rid))
        .unwrap();
    assert_eq!(snapshot.links.len(), 1);
    assert!(ws.get_row(&f.task_table.id, &task.rid).is_err());

    ws.restore_rows(&snapshot).unwrap();
    let after = ws.get_row(&f.task_table.id, &task.rid).unwrap();
    assert_eq!(after.rid, task.rid);
    assert_eq!(
        after.cells.get(&rel.id),
        Some(&serde_json::json!([bob.rid]))
    );
}

#[test]
fn restore_rolls_back_when_a_linked_row_is_missing() {
    let (_dir, ws) = common::create_ws("restore-bad.nothing");
    let f = emp_task_fixture(&ws);
    let rel = ws
        .add_column(
            &f.task_table.id,
            common::relation_col("Owner", &f.emp_table.id, None),
        )
        .unwrap();

    let emp_name = f.emp_cols[0].id.clone();
    let mut emp_cells = nothing_core::Cells::new();
    emp_cells.insert(emp_name, serde_json::json!("Carol"));
    let carol = ws.insert_row(&f.emp_table.id, emp_cells).unwrap();

    let mut task_cells = nothing_core::Cells::new();
    task_cells.insert(rel.id.clone(), serde_json::json!([carol.rid]));
    let task = ws.insert_row(&f.task_table.id, task_cells).unwrap();

    let snapshot = ws
        .delete_rows_snapshot(&f.task_table.id, std::slice::from_ref(&task.rid))
        .unwrap();

    // The link target disappears after the snapshot: restoring the task must
    // fail as a whole rather than leaving a half-restored row behind.
    ws.delete_rows(&f.emp_table.id, std::slice::from_ref(&carol.rid))
        .unwrap();
    assert!(ws.restore_rows(&snapshot).is_err());
    assert!(ws.get_row(&f.task_table.id, &task.rid).is_err());
}
