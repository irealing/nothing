//! Grid-view compiler: `GridConfig` (filter tree + sorts) → SQL fragments
//! with owned bind parameters.
//!
//! 铁律 4: identifiers come from metadata (`c_xxxx` physical names, quoted);
//! *values* always become `?` placeholders with entries in `params`. User
//! input never reaches the SQL string — the LIKE helpers escape `%`, `_` and
//! `\` inside the *bound value*, and date comparison wraps both sides in
//! `datetime()`/`date()` so operands stay data.

use std::collections::HashMap;

use rusqlite::types::Value;

use crate::error::{AppError, Result};
use crate::schema::ident::{junction_sql_name, quote_ident};
use crate::schema::{
    ColumnMeta, ColumnType, FilterNode, FilterOp, FilterRule, FormulaResultType, GridConfig,
    SortSpec, TableMeta,
};

/// Compiled grid query pieces; params are positional (`?`) in emit order.
pub(crate) struct Compiled {
    pub where_sql: String,
    pub where_params: Vec<Value>,
    pub order_sql: String,
}

pub(crate) struct Ctx<'a> {
    pub table: &'a TableMeta,
    pub cols: HashMap<String, &'a ColumnMeta>,
}

impl<'a> Ctx<'a> {
    fn col(&self, id: &str) -> Result<&'a ColumnMeta> {
        self.cols
            .get(id)
            .copied()
            .ok_or_else(|| AppError::NotFound(format!("视图引用的列 {id}")))
    }
}

pub(crate) fn compile(
    table: &TableMeta,
    cols: &[ColumnMeta],
    cfg: &GridConfig,
) -> Result<Compiled> {
    let ctx = Ctx {
        table,
        cols: cols.iter().map(|c| (c.id.clone(), c)).collect(),
    };
    let (where_sql, where_params) = match &cfg.filters {
        Some(node) => compile_node(&ctx, node)?,
        None => ("1 = 1".to_string(), Vec::new()),
    };
    let order_sql = compile_sorts(&ctx, &cfg.sorts)?;
    Ok(Compiled {
        where_sql,
        where_params,
        order_sql,
    })
}

fn compile_node(ctx: &Ctx, node: &FilterNode) -> Result<(String, Vec<Value>)> {
    match node {
        FilterNode::Rule(rule) => compile_rule(ctx, rule),
        FilterNode::Group { op, children } => {
            if children.is_empty() {
                // Empty AND group matches everything; empty OR matches nothing.
                let sql = match op {
                    crate::schema::LogicOp::And => "1 = 1",
                    crate::schema::LogicOp::Or => "1 = 0",
                };
                return Ok((sql.to_string(), Vec::new()));
            }
            let joiner = match op {
                crate::schema::LogicOp::And => " AND ",
                crate::schema::LogicOp::Or => " OR ",
            };
            let mut sqls = Vec::new();
            let mut params = Vec::new();
            for child in children {
                let (sql, p) = compile_node(ctx, child)?;
                sqls.push(format!("({sql})"));
                params.extend(p);
            }
            Ok((sqls.join(joiner), params))
        }
    }
}

fn compile_rule(ctx: &Ctx, rule: &FilterRule) -> Result<(String, Vec<Value>)> {
    let col = ctx.col(&rule.column_id)?;
    match col.col_type {
        ColumnType::Relation => compile_relation_rule(ctx, col, rule.op),
        ColumnType::MultiSelect => compile_multi_select_rule(col, rule),
        ColumnType::Checkbox => compile_checkbox_rule(col, rule),
        ColumnType::Date => compile_date_rule(col, rule),
        ColumnType::Number => compile_number_rule(col, rule),
        ColumnType::Formula => {
            // Formulas are physical (generated) columns: filter on the stored
            // value using the result type's semantics.
            let rt = col.opts.formula()?.result_type;
            match rt {
                FormulaResultType::Number => compile_number_rule(col, rule),
                FormulaResultType::Checkbox => compile_checkbox_rule(col, rule),
                FormulaResultType::Date => compile_date_rule(col, rule),
                FormulaResultType::Text => compile_text_rule(col, rule),
            }
        }
        // Text, Select → string semantics
        _ => compile_text_rule(col, rule),
    }
}

fn q(col: &ColumnMeta) -> String {
    quote_ident(&col.sql_name)
}

fn unsupported(col: &ColumnMeta, op: FilterOp) -> AppError {
    AppError::InvalidInput(format!(
        "列「{}」（{}）不支持筛选操作 {:?}",
        col.name,
        col.col_type.as_str(),
        op
    ))
}

/// Escape LIKE wildcards inside a bound value (used with `ESCAPE '\'`).
pub(crate) fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn one_string(col: &ColumnMeta, v: &serde_json::Value) -> Result<String> {
    v.as_str()
        .map(String::from)
        .or_else(|| v.as_f64().map(|n| n.to_string()))
        .ok_or_else(|| AppError::InvalidInput(format!("列「{}」的筛选值必须是字符串", col.name)))
}

fn value_list(col: &ColumnMeta, v: &serde_json::Value) -> Result<Vec<String>> {
    match v {
        serde_json::Value::Array(items) => items
            .iter()
            .map(|it| one_string(col, it))
            .collect::<Result<Vec<_>>>(),
        other => Ok(vec![one_string(col, other)?]),
    }
}

fn compile_text_rule(col: &ColumnMeta, rule: &FilterRule) -> Result<(String, Vec<Value>)> {
    let q = q(col);
    Ok(match rule.op {
        FilterOp::Eq => (
            format!("{q} = ?"),
            vec![Value::Text(one_string(col, &rule.value)?)],
        ),
        FilterOp::Neq => (
            format!("({q} <> ? OR {q} IS NULL)"),
            vec![Value::Text(one_string(col, &rule.value)?)],
        ),
        FilterOp::Contains => (
            format!("{q} LIKE ? ESCAPE '\\'"),
            vec![Value::Text(format!(
                "%{}%",
                like_escape(&one_string(col, &rule.value)?)
            ))],
        ),
        FilterOp::NotContains => (
            format!("({q} NOT LIKE ? ESCAPE '\\' OR {q} IS NULL)"),
            vec![Value::Text(format!(
                "%{}%",
                like_escape(&one_string(col, &rule.value)?)
            ))],
        ),
        FilterOp::StartsWith => (
            format!("{q} LIKE ? ESCAPE '\\'"),
            vec![Value::Text(format!(
                "{}%",
                like_escape(&one_string(col, &rule.value)?)
            ))],
        ),
        FilterOp::EndsWith => (
            format!("{q} LIKE ? ESCAPE '\\'"),
            vec![Value::Text(format!(
                "%{}",
                like_escape(&one_string(col, &rule.value)?)
            ))],
        ),
        FilterOp::IsEmpty => (format!("({q} IS NULL OR {q} = '')"), vec![]),
        FilterOp::IsNotEmpty => (format!("({q} IS NOT NULL AND {q} <> '')"), vec![]),
        FilterOp::In | FilterOp::NotIn => {
            let vals = value_list(col, &rule.value)?;
            if vals.is_empty() {
                return Ok((
                    if rule.op == FilterOp::In {
                        "1 = 0"
                    } else {
                        "1 = 1"
                    }
                    .to_string(),
                    vec![],
                ));
            }
            let marks = vec!["?"; vals.len()].join(", ");
            let params = vals.into_iter().map(Value::Text).collect();
            if rule.op == FilterOp::In {
                (format!("{q} IN ({marks})"), params)
            } else {
                (format!("({q} NOT IN ({marks}) OR {q} IS NULL)"), params)
            }
        }
        op => return Err(unsupported(col, op)),
    })
}

fn num_value(col: &ColumnMeta, v: &serde_json::Value) -> Result<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .ok_or_else(|| AppError::InvalidInput(format!("列「{}」的筛选值必须是数字", col.name)))
}

fn compile_number_rule(col: &ColumnMeta, rule: &FilterRule) -> Result<(String, Vec<Value>)> {
    let q = q(col);
    Ok(match rule.op {
        FilterOp::Eq => (
            format!("{q} = ?"),
            vec![Value::Real(num_value(col, &rule.value)?)],
        ),
        FilterOp::Neq => (
            format!("({q} <> ? OR {q} IS NULL)"),
            vec![Value::Real(num_value(col, &rule.value)?)],
        ),
        FilterOp::Gt => (
            format!("{q} > ?"),
            vec![Value::Real(num_value(col, &rule.value)?)],
        ),
        FilterOp::Gte => (
            format!("{q} >= ?"),
            vec![Value::Real(num_value(col, &rule.value)?)],
        ),
        FilterOp::Lt => (
            format!("{q} < ?"),
            vec![Value::Real(num_value(col, &rule.value)?)],
        ),
        FilterOp::Lte => (
            format!("{q} <= ?"),
            vec![Value::Real(num_value(col, &rule.value)?)],
        ),
        FilterOp::IsEmpty => (format!("{q} IS NULL"), vec![]),
        FilterOp::IsNotEmpty => (format!("{q} IS NOT NULL"), vec![]),
        FilterOp::In | FilterOp::NotIn => {
            let list = match &rule.value {
                serde_json::Value::Array(items) => items.clone(),
                other => vec![other.clone()],
            };
            if list.is_empty() {
                return Ok((
                    if rule.op == FilterOp::In {
                        "1 = 0"
                    } else {
                        "1 = 1"
                    }
                    .to_string(),
                    vec![],
                ));
            }
            let mut params = Vec::with_capacity(list.len());
            for it in &list {
                params.push(Value::Real(num_value(col, it)?));
            }
            let marks = vec!["?"; params.len()].join(", ");
            if rule.op == FilterOp::In {
                (format!("{q} IN ({marks})"), params)
            } else {
                (format!("({q} NOT IN ({marks}) OR {q} IS NULL)"), params)
            }
        }
        op => return Err(unsupported(col, op)),
    })
}

fn compile_checkbox_rule(col: &ColumnMeta, rule: &FilterRule) -> Result<(String, Vec<Value>)> {
    let q = q(col);
    let b = match &rule.value {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_i64().map(|i| i != 0).unwrap_or(false),
        serde_json::Value::String(s) => matches!(s.as_str(), "true" | "1"),
        _ => {
            return Err(AppError::InvalidInput(format!(
                "列「{}」的筛选值必须是布尔值",
                col.name
            )))
        }
    };
    Ok(match rule.op {
        FilterOp::Eq => (format!("{q} = ?"), vec![Value::Integer(b as i64)]),
        FilterOp::Neq => (format!("{q} <> ?"), vec![Value::Integer(b as i64)]),
        // Checkboxes are NOT NULL: never empty.
        FilterOp::IsEmpty => ("1 = 0".to_string(), vec![]),
        FilterOp::IsNotEmpty => ("1 = 1".to_string(), vec![]),
        op => return Err(unsupported(col, op)),
    })
}

fn date_value(col: &ColumnMeta, v: &serde_json::Value) -> Result<String> {
    v.as_str().map(String::from).ok_or_else(|| {
        AppError::InvalidInput(format!("列「{}」的筛选值必须是 ISO 日期字符串", col.name))
    })
}

fn compile_date_rule(col: &ColumnMeta, rule: &FilterRule) -> Result<(String, Vec<Value>)> {
    let q = q(col);
    Ok(match rule.op {
        FilterOp::Before => (
            format!("datetime({q}) < datetime(?)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::After => (
            format!("datetime({q}) > datetime(?)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::On => (
            format!("date({q}) = date(?)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::Eq => (
            format!("datetime({q}) = datetime(?)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::Neq => (
            format!("(datetime({q}) <> datetime(?) OR {q} IS NULL)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::Gt => (
            format!("datetime({q}) > datetime(?)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::Gte => (
            format!("datetime({q}) >= datetime(?)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::Lt => (
            format!("datetime({q}) < datetime(?)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::Lte => (
            format!("datetime({q}) <= datetime(?)"),
            vec![Value::Text(date_value(col, &rule.value)?)],
        ),
        FilterOp::IsEmpty => (format!("{q} IS NULL"), vec![]),
        FilterOp::IsNotEmpty => (format!("{q} IS NOT NULL"), vec![]),
        op => return Err(unsupported(col, op)),
    })
}

fn compile_multi_select_rule(col: &ColumnMeta, rule: &FilterRule) -> Result<(String, Vec<Value>)> {
    let q = q(col);
    Ok(match rule.op {
        FilterOp::Contains | FilterOp::Eq => (
            format!("EXISTS (SELECT 1 FROM json_each({q}) WHERE value = ?)"),
            vec![Value::Text(one_string(col, &rule.value)?)],
        ),
        FilterOp::NotContains | FilterOp::Neq => (
            format!("NOT EXISTS (SELECT 1 FROM json_each({q}) WHERE value = ?)"),
            vec![Value::Text(one_string(col, &rule.value)?)],
        ),
        FilterOp::IsEmpty => (
            format!("({q} IS NULL OR json_array_length({q}) = 0)"),
            vec![],
        ),
        FilterOp::IsNotEmpty => (
            format!("({q} IS NOT NULL AND json_array_length({q}) > 0)"),
            vec![],
        ),
        FilterOp::In => {
            // "any of" semantics
            let vals = value_list(col, &rule.value)?;
            if vals.is_empty() {
                return Ok(("1 = 0".to_string(), vec![]));
            }
            let clauses: Vec<String> = vals
                .iter()
                .map(|_| format!("EXISTS (SELECT 1 FROM json_each({q}) WHERE value = ?)"))
                .collect();
            let params = vals.into_iter().map(Value::Text).collect();
            (format!("({})", clauses.join(" OR ")), params)
        }
        op => return Err(unsupported(col, op)),
    })
}

fn compile_relation_rule(
    ctx: &Ctx,
    col: &ColumnMeta,
    op: FilterOp,
) -> Result<(String, Vec<Value>)> {
    // Relation columns live in junction tables: only emptiness is filterable
    // in M2. Source columns own side "a"; reverse columns own side "b".
    let source_col_id = if col.is_reverse {
        col.reverse_of
            .as_deref()
            .ok_or_else(|| AppError::Internal("反向列缺少 reverse_of".into()))?
    } else {
        col.id.as_str()
    };
    let junction = quote_ident(&junction_sql_name(source_col_id));
    let side = if col.is_reverse { "b" } else { "a" };
    let owner = quote_ident(&ctx.table.sql_name);
    let exists = format!("EXISTS (SELECT 1 FROM {junction} WHERE \"{side}\" = {owner}.\"_rid\")");
    Ok(match op {
        FilterOp::IsEmpty => (format!("NOT {exists}"), vec![]),
        FilterOp::IsNotEmpty => (exists, vec![]),
        _ => return Err(unsupported(col, op)),
    })
}

fn compile_sorts(ctx: &Ctx, sorts: &[SortSpec]) -> Result<String> {
    let mut parts = Vec::new();
    for s in sorts {
        let col = ctx.col(&s.column_id)?;
        if !col.is_physical() {
            return Err(AppError::InvalidInput(format!(
                "关联列「{}」不支持排序",
                col.name
            )));
        }
        let dir = if s.desc { "DESC" } else { "ASC" };
        parts.push(format!("{} {dir} NULLS LAST", q(col)));
    }
    // Stable tiebreaker for deterministic pagination.
    parts.push(format!("{} ASC", quote_ident("_rid")));
    Ok(format!("ORDER BY {}", parts.join(", ")))
}

#[cfg(test)]
mod tests {
    //! Pure-SQL shape tests (no database needed); behaviour is covered by
    //! tests/query.rs against a real encrypted workspace.

    use super::*;
    use crate::schema::{ColumnOpts, PlainOpts};

    fn col(id: &str, sql: &str, t: ColumnType) -> ColumnMeta {
        ColumnMeta {
            id: id.into(),
            table_id: "T".into(),
            name: id.into(),
            sql_name: sql.into(),
            col_type: t,
            opts: ColumnOpts::Plain(PlainOpts {}),
            position: 0,
            width: 160,
            visible: true,
            is_reverse: false,
            reverse_of: None,
            icon: None,
            color: None,
            align: None,
            default_value: None,
            created_at: String::new(),
        }
    }

    fn table() -> TableMeta {
        TableMeta {
            id: "T".into(),
            name: "T".into(),
            sql_name: "t_x".into(),
            title_col_id: None,
            icon: None,
            position: 0,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn where_is_parameterized_never_interpolated() {
        let cols = vec![col("标题", "c_a", ColumnType::Text)];
        let evil = "x'; DROP TABLE t_x; --";
        let cfg = GridConfig {
            filters: Some(FilterNode::Rule(FilterRule {
                column_id: "标题".into(),
                op: FilterOp::Contains,
                value: serde_json::Value::String(evil.into()),
            })),
            sorts: vec![],
            hidden_columns: vec![],
        };
        let c = compile(&table(), &cols, &cfg).unwrap();
        // The evil string is NOT part of the SQL text…
        assert!(!c.where_sql.contains("DROP"), "{}", c.where_sql);
        assert_eq!(c.where_sql, r#""c_a" LIKE ? ESCAPE '\'"#);
        // …it is a bound parameter, with wildcards escaped.
        assert_eq!(c.where_params.len(), 1);
        match &c.where_params[0] {
            Value::Text(t) => assert!(t.starts_with('%') && t.contains("DROP TABLE"), "{t}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn like_wildcards_in_values_are_escaped() {
        let cols = vec![col("标题", "c_a", ColumnType::Text)];
        let cfg = GridConfig {
            filters: Some(FilterNode::Rule(FilterRule {
                column_id: "标题".into(),
                op: FilterOp::Contains,
                value: serde_json::json!("100%_\\x"),
            })),
            sorts: vec![],
            hidden_columns: vec![],
        };
        let c = compile(&table(), &cols, &cfg).unwrap();
        match &c.where_params[0] {
            Value::Text(t) => assert_eq!(t, r"%100\%\_\\x%"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn groups_nest_and_params_stay_ordered() {
        let cols = vec![
            col("n", "c_n", ColumnType::Number),
            col("t", "c_t", ColumnType::Text),
        ];
        let cfg = GridConfig {
            filters: Some(FilterNode::Group {
                op: crate::schema::LogicOp::Or,
                children: vec![
                    FilterNode::Rule(FilterRule {
                        column_id: "n".into(),
                        op: FilterOp::Gt,
                        value: serde_json::json!(3),
                    }),
                    FilterNode::Group {
                        op: crate::schema::LogicOp::And,
                        children: vec![
                            FilterNode::Rule(FilterRule {
                                column_id: "t".into(),
                                op: FilterOp::Eq,
                                value: serde_json::json!("a"),
                            }),
                            FilterNode::Rule(FilterRule {
                                column_id: "n".into(),
                                op: FilterOp::Lt,
                                value: serde_json::json!(9),
                            }),
                        ],
                    },
                ],
            }),
            sorts: vec![SortSpec {
                column_id: "n".into(),
                desc: true,
            }],
            hidden_columns: vec![],
        };
        let c = compile(&table(), &cols, &cfg).unwrap();
        assert_eq!(
            c.where_sql,
            r#"("c_n" > ?) OR (("c_t" = ?) AND ("c_n" < ?))"#
        );
        assert_eq!(
            c.where_params,
            vec![Value::Real(3.0), Value::Text("a".into()), Value::Real(9.0)]
        );
        assert_eq!(c.order_sql, r#"ORDER BY "c_n" DESC NULLS LAST, "_rid" ASC"#);
    }
}
