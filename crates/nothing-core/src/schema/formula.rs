//! Formula compiler: user-facing formula syntax → SQLite generated-column
//! expression.
//!
//! 铁律 8: only a whitelist is accepted — column references (`[列名]` or bare
//! names), numeric/string literals, arithmetic & comparison operators,
//! `AND`/`OR`/`NOT`, parentheses, and whitelisted scalar functions. Anything
//! else (unknown characters, `;`, subqueries, non-whitelisted functions) is a
//! compile error. Output identifiers/strings go through the sanctioned quoting
//! primitives from [`super::ident`].
//!
//! Grammar (precedence low → high):
//! ```text
//! or   := and (OR and)*
//! and  := not (AND not)*
//! not  := NOT not | cmp
//! cmp  := add ((= | <> | < | <= | > | >=) add)?
//! add  := mul ((+ | -) mul)*
//! mul  := unary ((* | / | %) unary)*
//! unary:= (-) unary | primary
//! primary := number | string | column | func(args) | '(' or ')'
//! ```

use super::ident::{quote_ident, quote_literal};
use crate::error::{AppError, Result};

/// Information about a column a formula may reference.
pub struct ColumnRef {
    /// Physical column name (`c_xxxx`).
    pub sql_name: String,
    /// Generated columns may not reference other generated columns (SQLite
    /// restriction), so formula columns are rejected as references.
    pub is_formula: bool,
    /// Relation columns have no physical column — not referenceable.
    pub is_relation: bool,
}

/// Whitelisted functions: name → (min_args, max_args).
const FUNCTIONS: &[(&str, usize, usize)] = &[
    ("abs", 1, 1),
    ("round", 1, 2),
    ("lower", 1, 1),
    ("upper", 1, 1),
    ("length", 1, 1),
    ("trim", 1, 1),
    ("ltrim", 1, 1),
    ("rtrim", 1, 1),
    ("substr", 2, 3),
    ("coalesce", 1, 32),
    ("ifnull", 2, 2),
    ("min", 1, 32),
    ("max", 1, 32),
    ("date", 1, 3),
    ("datetime", 1, 3),
];

const MAX_EXPR_LEN: usize = 2_000;
const MAX_DEPTH: u32 = 64;

/// Compile a formula expression into a SQLite scalar expression.
///
/// `resolve` maps a column *display name* to its [`ColumnRef`]; returning
/// `None` means "no such column" and is a compile error.
pub fn compile(expr: &str, resolve: &dyn Fn(&str) -> Option<ColumnRef>) -> Result<String> {
    if expr.trim().is_empty() {
        return Err(AppError::InvalidInput("公式不能为空".into()));
    }
    if expr.chars().count() > MAX_EXPR_LEN {
        return Err(AppError::InvalidInput("公式过长".into()));
    }
    let tokens = tokenize(expr)?;
    let mut p = Parser {
        tokens,
        pos: 0,
        depth: 0,
        resolve,
    };
    let sql = p.parse_or()?;
    if !matches!(p.peek(), Tok::Eof) {
        return Err(AppError::InvalidInput("公式存在多余内容".into()));
    }
    Ok(sql)
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// Numeric literal, already validated.
    Num(String),
    /// String literal (unescaped content).
    Str(String),
    /// Bare word: potential column name or function name.
    Ident(String),
    /// `[列名]` bracketed column reference.
    Ref(String),
    /// Operator / keyword: `+ - * / % = <> < <= > >= AND OR NOT`
    Op(String),
    LParen,
    RParen,
    Comma,
    Eof,
}

fn tokenize(src: &str) -> Result<Vec<Tok>> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        match c {
            '[' => {
                let start = i + 1;
                let mut end = start;
                while end < chars.len() && chars[end] != ']' {
                    end += 1;
                }
                if end >= chars.len() {
                    return Err(AppError::InvalidInput("列引用缺少 ]".into()));
                }
                let name: String = chars[start..end].iter().collect();
                if name.trim().is_empty() {
                    return Err(AppError::InvalidInput("列引用不能为空".into()));
                }
                out.push(Tok::Ref(name));
                i = end + 1;
            }
            '\'' | '"' => {
                let quote = c;
                let mut s = String::new();
                i += 1;
                loop {
                    if i >= chars.len() {
                        return Err(AppError::InvalidInput("字符串缺少结束引号".into()));
                    }
                    if chars[i] == quote {
                        // doubled quote = escaped quote
                        if i + 1 < chars.len() && chars[i + 1] == quote {
                            s.push(quote);
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    s.push(chars[i]);
                    i += 1;
                }
                out.push(Tok::Str(s));
            }
            '(' => {
                out.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                out.push(Tok::RParen);
                i += 1;
            }
            ',' => {
                out.push(Tok::Comma);
                i += 1;
            }
            '<' | '>' | '=' | '!' => {
                let next = chars.get(i + 1).copied();
                let (op, advance) = match (c, next) {
                    ('<', Some('=')) => ("<=".to_string(), 2),
                    ('>', Some('=')) => (">=".to_string(), 2),
                    ('<', Some('>')) => ("<>".to_string(), 2),
                    ('!', Some('=')) => ("<>".to_string(), 2),
                    ('=', Some('=')) => ("=".to_string(), 2),
                    ('<', _) => ("<".to_string(), 1),
                    ('>', _) => (">".to_string(), 1),
                    ('=', _) => ("=".to_string(), 1),
                    _ => {
                        return Err(AppError::InvalidInput("公式包含非法字符: ! (只能使用 !=)".to_string()))
                    }
                };
                out.push(Tok::Op(op));
                i += advance;
            }
            '+' | '-' | '*' | '/' | '%' => {
                out.push(Tok::Op(c.to_string()));
                i += 1;
            }
            _ if c.is_ascii_digit()
                || (c == '.' && matches!(chars.get(i + 1), Some(d) if d.is_ascii_digit())) =>
            {
                let start = i;
                let mut seen_dot = false;
                while i < chars.len() {
                    let ch = chars[i];
                    if ch.is_ascii_digit() {
                        i += 1;
                    } else if ch == '.' && !seen_dot {
                        seen_dot = true;
                        i += 1;
                    } else {
                        break;
                    }
                }
                let num: String = chars[start..i].iter().collect();
                if num.parse::<f64>().is_err() {
                    return Err(AppError::InvalidInput(format!("非法数字: {num}")));
                }
                out.push(Tok::Num(num));
            }
            _ if is_ident_start(c) => {
                let start = i;
                while i < chars.len() && is_ident_char(chars[i]) {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                match word.to_ascii_uppercase().as_str() {
                    "AND" => out.push(Tok::Op("AND".into())),
                    "OR" => out.push(Tok::Op("OR".into())),
                    "NOT" => out.push(Tok::Op("NOT".into())),
                    _ => out.push(Tok::Ident(word)),
                }
            }
            _ => return Err(AppError::InvalidInput(format!("公式包含非法字符: {c:?}"))),
        }
    }
    out.push(Tok::Eof);
    Ok(out)
}

fn is_ident_start(c: char) -> bool {
    c == '_' || c.is_alphabetic()
}

fn is_ident_char(c: char) -> bool {
    c == '_' || c.is_alphanumeric()
}

// ---------------------------------------------------------------------------
// Parser (recursive descent, emits SQL)
// ---------------------------------------------------------------------------

struct Parser<'a> {
    tokens: Vec<Tok>,
    pos: usize,
    depth: u32,
    resolve: &'a dyn Fn(&str) -> Option<ColumnRef>,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> &Tok {
        self.tokens.get(self.pos).unwrap_or(&Tok::Eof)
    }

    fn next(&mut self) -> Tok {
        let t = self.tokens.get(self.pos).cloned().unwrap_or(Tok::Eof);
        self.pos += 1;
        t
    }

    fn expect_op(&mut self, op: &str) -> bool {
        if matches!(self.peek(), Tok::Op(o) if o == op) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn enter(&mut self) -> Result<()> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(AppError::InvalidInput("公式嵌套过深".into()));
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    fn parse_or(&mut self) -> Result<String> {
        self.enter()?;
        let mut left = self.parse_and()?;
        while self.expect_op("OR") {
            let right = self.parse_and()?;
            left = format!("({left} OR {right})");
        }
        self.leave();
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<String> {
        self.enter()?;
        let mut left = self.parse_not()?;
        while self.expect_op("AND") {
            let right = self.parse_not()?;
            left = format!("({left} AND {right})");
        }
        self.leave();
        Ok(left)
    }

    fn parse_not(&mut self) -> Result<String> {
        self.enter()?;
        let out = if self.expect_op("NOT") {
            format!("(NOT {})", self.parse_not()?)
        } else {
            self.parse_cmp()?
        };
        self.leave();
        Ok(out)
    }

    fn parse_cmp(&mut self) -> Result<String> {
        self.enter()?;
        let left = self.parse_add()?;
        let out = match self.peek() {
            Tok::Op(o) if matches!(o.as_str(), "=" | "<>" | "<" | "<=" | ">" | ">=") => {
                let op = o.clone();
                self.pos += 1;
                let right = self.parse_add()?;
                format!("({left} {op} {right})")
            }
            _ => left,
        };
        self.leave();
        Ok(out)
    }

    fn parse_add(&mut self) -> Result<String> {
        self.enter()?;
        let mut left = self.parse_mul()?;
        loop {
            let op = match self.peek() {
                Tok::Op(o) if o == "+" || o == "-" => o.clone(),
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_mul()?;
            left = format!("({left} {op} {right})");
        }
        self.leave();
        Ok(left)
    }

    fn parse_mul(&mut self) -> Result<String> {
        self.enter()?;
        let mut left = self.parse_unary()?;
        loop {
            let op = match self.peek() {
                Tok::Op(o) if o == "*" || o == "/" || o == "%" => o.clone(),
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_unary()?;
            left = format!("({left} {op} {right})");
        }
        self.leave();
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<String> {
        self.enter()?;
        let out = if self.expect_op("-") {
            format!("(-{})", self.parse_unary()?)
        } else {
            self.parse_primary()?
        };
        self.leave();
        Ok(out)
    }

    fn parse_primary(&mut self) -> Result<String> {
        self.enter()?;
        let out = match self.next() {
            Tok::Num(n) => n,
            Tok::Str(s) => quote_literal(&s)?,
            Tok::LParen => {
                let inner = self.parse_or()?;
                if !matches!(self.next(), Tok::RParen) {
                    return Err(AppError::InvalidInput("公式缺少右括号".into()));
                }
                // No extra wrapping: every binary node already parenthesizes
                // itself, so `inner` cannot be mis-associated by callers.
                inner
            }
            Tok::Ref(name) => self.column_sql(&name)?,
            Tok::Ident(name) => {
                // function call?
                if matches!(self.peek(), Tok::LParen) {
                    self.pos += 1; // consume '('
                    self.call_sql(&name)?
                } else {
                    self.column_sql(&name)?
                }
            }
            other => {
                return Err(AppError::InvalidInput(format!(
                    "公式语法错误，意外内容: {other:?}"
                )))
            }
        };
        self.leave();
        Ok(out)
    }

    fn call_sql(&mut self, name: &str) -> Result<String> {
        let lower = name.to_ascii_lowercase();
        let (_, min_args, max_args) = FUNCTIONS
            .iter()
            .find(|(f, _, _)| *f == lower)
            .ok_or_else(|| AppError::InvalidInput(format!("不支持的函数: {name}")))?;
        let mut args = Vec::new();
        if !matches!(self.peek(), Tok::RParen) {
            loop {
                args.push(self.parse_or()?);
                if matches!(self.peek(), Tok::Comma) {
                    self.pos += 1;
                    continue;
                }
                break;
            }
        }
        if !matches!(self.next(), Tok::RParen) {
            return Err(AppError::InvalidInput(format!("函数 {name} 缺少右括号")));
        }
        if args.len() < *min_args || args.len() > *max_args {
            return Err(AppError::InvalidInput(format!(
                "函数 {name} 参数个数应为 {min_args}..={max_args}，实际 {}",
                args.len()
            )));
        }
        Ok(format!("{lower}({})", args.join(", ")))
    }

    fn column_sql(&mut self, name: &str) -> Result<String> {
        // Defense in depth: SQL keywords are never valid column references.
        const SQL_KEYWORDS: &[&str] = &[
            "SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TABLE", "VIEW",
            "FROM", "WHERE", "PRAGMA", "ATTACH", "DETACH", "VACUUM", "UNION", "JOIN", "INDEX",
            "TRIGGER", "BEGIN", "COMMIT", "ROLLBACK",
        ];
        if SQL_KEYWORDS.contains(&name.to_ascii_uppercase().as_str()) {
            return Err(AppError::InvalidInput(format!(
                "公式不支持 SQL 关键字: {name}"
            )));
        }
        let col = (self.resolve)(name)
            .ok_or_else(|| AppError::InvalidInput(format!("公式引用了不存在的列: {name}")))?;
        if col.is_formula {
            return Err(AppError::InvalidInput(format!(
                "公式列不能引用其他公式列: {name}"
            )));
        }
        if col.is_relation {
            return Err(AppError::InvalidInput(format!(
                "公式不能引用关联列: {name}"
            )));
        }
        Ok(quote_ident(&col.sql_name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(name: &str) -> Option<ColumnRef> {
        match name {
            "单价" => Some(ColumnRef {
                sql_name: "c_price".into(),
                is_formula: false,
                is_relation: false,
            }),
            "数量" => Some(ColumnRef {
                sql_name: "c_qty".into(),
                is_formula: false,
                is_relation: false,
            }),
            "备注" => Some(ColumnRef {
                sql_name: "c_note".into(),
                is_formula: false,
                is_relation: false,
            }),
            "小计" => Some(ColumnRef {
                sql_name: "c_sub".into(),
                is_formula: true,
                is_relation: false,
            }),
            "负责人" => Some(ColumnRef {
                sql_name: "c_owner".into(),
                is_formula: false,
                is_relation: true,
            }),
            _ => None,
        }
    }

    fn ok(expr: &str) -> String {
        compile(expr, &resolver).unwrap()
    }

    fn err(expr: &str) -> String {
        compile(expr, &resolver).unwrap_err().to_string()
    }

    #[test]
    fn arithmetic_and_refs() {
        assert_eq!(ok("[单价] * [数量]"), r#"("c_price" * "c_qty")"#);
        assert_eq!(ok("单价*数量"), r#"("c_price" * "c_qty")"#);
        assert_eq!(
            ok("round([单价] * 0.9, 2)"),
            r#"round(("c_price" * 0.9), 2)"#
        );
    }

    #[test]
    fn unary_and_precedence() {
        assert_eq!(ok("-[数量] + 1"), r#"((-"c_qty") + 1)"#);
        assert_eq!(ok("[单价] + [数量] * 2"), r#"("c_price" + ("c_qty" * 2))"#);
        assert_eq!(
            ok("([单价] + [数量]) * 2"),
            r#"(("c_price" + "c_qty") * 2)"#
        );
    }

    #[test]
    fn comparisons_and_logic() {
        assert_eq!(
            ok("[数量] >= 3 AND [备注] != 'x'"),
            r#"(("c_qty" >= 3) AND ("c_note" <> 'x'))"#
        );
        assert_eq!(ok("NOT [数量] > 0"), r#"(NOT ("c_qty" > 0))"#);
        assert_eq!(
            ok("[数量] == 3 or [数量] <> 4"),
            r#"(("c_qty" = 3) OR ("c_qty" <> 4))"#
        );
    }

    #[test]
    fn strings_and_escaping() {
        assert_eq!(ok("[备注] = 'O''Brien'"), r#"("c_note" = 'O''Brien')"#);
        // formula text: [备注] = "say ""hi"""
        assert_eq!(
            ok("[备注] = \"say \"\"hi\"\"\""),
            "(\"c_note\" = 'say \"hi\"')"
        );
    }

    #[test]
    fn rejects_unknown_and_dangerous() {
        assert!(err("[不存在] + 1").contains("不存在的列"));
        assert!(err("[小计] + 1").contains("公式列"));
        assert!(err("[负责人] + 1").contains("关联列"));
        assert!(err("1; DROP TABLE t_x").contains("非法字符"));
        assert!(err("sqlite_version()").contains("不支持的函数"));
        assert!(err("(SELECT 1)").contains("关键字"));
        assert!(err("abs(1,2)").contains("参数个数"));
        assert!(err("").contains("不能为空"));
        assert!(err("[单价").contains("缺少 ]"));
        assert!(err("'abc").contains("引号"));
        // deep nesting must not blow the stack
        let deep = format!("{}1{}", "(".repeat(200), ")".repeat(200));
        assert!(err(&deep).contains("嵌套过深"));
    }
}
