//! Summary-view compiler: `AggregateConfig` → grouped, parameterized SQL.
//!
//! The WHERE clause comes from the normal grid compiler (identifiers only),
//! and every value is still bound. This module only emits metadata-derived
//! identifiers (`c_xxxx`), a fixed set of aggregate functions and the group
//! positions; user input never reaches the SQL text.

use std::collections::HashMap;

use crate::error::{AppError, Result};
use crate::schema::ident::quote_ident;
use crate::schema::{
    AggregateConfig, AggregateOp, ColumnFormat, ColumnMeta, ColumnType, TableMeta,
};

use super::{AggregateColumn, AggregateColumnKind, AggregateValueType};

/// Compiled SQL plus the descriptors needed to decode/format the result.
pub(crate) struct CompiledAggregate {
    pub columns: Vec<AggregateColumn>,
    /// Grouped SELECT with `LIMIT ? OFFSET ?` at the end.
    pub select_sql: String,
    /// Count of groups (`None` when the view has no group field).
    pub groups_sql: Option<String>,
    /// Count of rows before grouping (after filters).
    pub base_rows_sql: String,
}

fn value_type(col_type: ColumnType) -> AggregateValueType {
    match col_type {
        ColumnType::Date => AggregateValueType::Date,
        ColumnType::Checkbox => AggregateValueType::Checkbox,
        ColumnType::Number => AggregateValueType::Number,
        _ => AggregateValueType::Text,
    }
}

fn metric_allowed(op: AggregateOp, col_type: ColumnType) -> bool {
    match op {
        AggregateOp::CountRows => true,
        AggregateOp::CountNonEmpty | AggregateOp::CountDistinct => matches!(
            col_type,
            ColumnType::Text
                | ColumnType::Number
                | ColumnType::Select
                | ColumnType::Date
                | ColumnType::Checkbox
        ),
        AggregateOp::Sum => matches!(col_type, ColumnType::Number | ColumnType::Checkbox),
        AggregateOp::Avg => col_type == ColumnType::Number,
        AggregateOp::Min | AggregateOp::Max => {
            matches!(col_type, ColumnType::Number | ColumnType::Date)
        }
    }
}

fn metric_expr(op: AggregateOp, qcol: &str) -> String {
    match op {
        AggregateOp::CountRows => "count(*)".to_string(),
        AggregateOp::CountNonEmpty => format!("count({qcol})"),
        AggregateOp::CountDistinct => format!("count(DISTINCT {qcol})"),
        AggregateOp::Sum => format!("sum({qcol})"),
        AggregateOp::Avg => format!("avg({qcol})"),
        AggregateOp::Min => format!("min({qcol})"),
        AggregateOp::Max => format!("max({qcol})"),
    }
}

fn metric_format(op: AggregateOp, col: &ColumnMeta) -> Option<ColumnFormat> {
    match op {
        AggregateOp::Sum | AggregateOp::Avg | AggregateOp::Min | AggregateOp::Max => {
            col.format.clone()
        }
        _ => None,
    }
}

fn metric_value_type(op: AggregateOp, col: &ColumnMeta) -> AggregateValueType {
    match op {
        AggregateOp::Min | AggregateOp::Max => value_type(col.effective_type()),
        _ => AggregateValueType::Number,
    }
}

/// Compile a summary configuration against one table. `where_sql` must use
/// positional parameters in the same order as the caller's bound values.
pub(crate) fn compile(
    table: &TableMeta,
    cols: &[ColumnMeta],
    cfg: &AggregateConfig,
    where_sql: &str,
) -> Result<CompiledAggregate> {
    if cfg.metrics.is_empty() {
        return Err(AppError::InvalidInput("汇总视图至少需要一个指标".into()));
    }
    if cfg.metrics.len() > 8 {
        return Err(AppError::InvalidInput("汇总指标最多 8 个".into()));
    }
    if cfg.group_by.len() > 3 {
        return Err(AppError::InvalidInput("分组字段最多 3 个".into()));
    }

    let by_id: HashMap<&str, &ColumnMeta> = cols.iter().map(|c| (c.id.as_str(), c)).collect();
    let column = |id: &str| {
        by_id
            .get(id)
            .copied()
            .ok_or_else(|| AppError::NotFound(format!("汇总视图引用的列 {id}")))
    };

    let qtab = quote_ident(&table.sql_name);
    let mut columns = Vec::with_capacity(cfg.group_by.len() + cfg.metrics.len());
    let mut select_parts = Vec::with_capacity(cfg.group_by.len() + cfg.metrics.len());
    let mut group_exprs = Vec::with_capacity(cfg.group_by.len());

    let mut seen_groups = std::collections::HashSet::new();
    for (i, id) in cfg.group_by.iter().enumerate() {
        if !seen_groups.insert(id.as_str()) {
            return Err(AppError::InvalidInput(format!("分组字段重复: {id}")));
        }
        let col = column(id)?;
        let effective = col.effective_type();
        if !matches!(
            effective,
            ColumnType::Text
                | ColumnType::Number
                | ColumnType::Select
                | ColumnType::Date
                | ColumnType::Checkbox
        ) {
            return Err(AppError::InvalidInput(format!(
                "列「{}」不能作为分组字段",
                col.name
            )));
        }
        let qcol = quote_ident(col.sql_name().unwrap_or_default());
        // Date cells are ISO timestamps; grouping by the stored UTC day keeps
        // the same semantics as the existing `on` date filter.
        let expr = if effective == ColumnType::Date {
            format!("date({qcol})")
        } else {
            qcol
        };
        group_exprs.push(expr.clone());
        let alias = quote_ident(&format!("g{i}"));
        select_parts.push(format!("{expr} AS {alias}"));
        columns.push(AggregateColumn {
            kind: AggregateColumnKind::Group,
            column_id: Some(col.id.clone()),
            op: None,
            value_type: value_type(effective),
            format: col.format.clone(),
        });
    }

    let mut seen_metrics = std::collections::HashSet::new();
    for (i, metric) in cfg.metrics.iter().enumerate() {
        let column_id = metric.column_id.as_deref().filter(|s| !s.is_empty());
        let alias = quote_ident(&format!("m{i}"));
        let (expr, descriptor) = if metric.op == AggregateOp::CountRows {
            if column_id.is_some() {
                return Err(AppError::InvalidInput("「行数」指标不能指定列".into()));
            }
            (
                metric_expr(metric.op, ""),
                AggregateColumn {
                    kind: AggregateColumnKind::Metric,
                    column_id: None,
                    op: Some(metric.op),
                    value_type: AggregateValueType::Number,
                    format: None,
                },
            )
        } else {
            let id = column_id.ok_or_else(|| {
                AppError::InvalidInput(format!("指标「{}」必须选择一列", metric.op.as_str()))
            })?;
            let col = column(id)?;
            if !metric_allowed(metric.op, col.effective_type()) {
                return Err(AppError::InvalidInput(format!(
                    "列「{}」不支持「{}」汇总",
                    col.name,
                    metric.op.as_str()
                )));
            }
            let qcol = quote_ident(col.sql_name().unwrap_or_default());
            (
                metric_expr(metric.op, &qcol),
                AggregateColumn {
                    kind: AggregateColumnKind::Metric,
                    column_id: Some(col.id.clone()),
                    op: Some(metric.op),
                    value_type: metric_value_type(metric.op, col),
                    format: metric_format(metric.op, col),
                },
            )
        };
        if !seen_metrics.insert((metric.op, column_id.map(str::to_string))) {
            return Err(AppError::InvalidInput("汇总指标重复".into()));
        }
        select_parts.push(format!("{expr} AS {alias}"));
        columns.push(descriptor);
    }

    if let Some(sort) = &cfg.sort {
        if let Some(index) = sort.metric {
            if index >= cfg.metrics.len() {
                return Err(AppError::InvalidInput("汇总排序引用了不存在的指标".into()));
            }
        }
    }

    let mut sql = format!(
        "SELECT {} FROM {qtab} WHERE {where_sql}",
        select_parts.join(", ")
    );
    let groups_sql = if group_exprs.is_empty() {
        None
    } else {
        let positions = (1..=group_exprs.len())
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" GROUP BY {positions}"));
        Some(format!(
            "SELECT count(*) FROM (SELECT {} FROM {qtab} WHERE {where_sql} GROUP BY {positions})",
            group_exprs.join(", ")
        ))
    };

    if !group_exprs.is_empty() {
        let mut order = Vec::new();
        let dir = if cfg.sort.as_ref().is_some_and(|s| s.desc) {
            "DESC"
        } else {
            "ASC"
        };
        let sort_metric = cfg.sort.as_ref().and_then(|s| s.metric);
        if let Some(index) = sort_metric {
            order.push(format!(
                "{} {dir} NULLS LAST",
                quote_ident(&format!("m{index}"))
            ));
        }
        // Group fields stay ascending as a stable tiebreaker when the primary
        // order is a metric.
        let group_dir = if sort_metric.is_some() { "ASC" } else { dir };
        for i in 0..group_exprs.len() {
            order.push(format!(
                "{} {group_dir} NULLS LAST",
                quote_ident(&format!("g{i}"))
            ));
        }
        sql.push_str(&format!(" ORDER BY {}", order.join(", ")));
    }
    sql.push_str(" LIMIT ? OFFSET ?");

    Ok(CompiledAggregate {
        columns,
        select_sql: sql,
        groups_sql,
        base_rows_sql: format!("SELECT count(*) FROM {qtab} WHERE {where_sql}"),
    })
}
