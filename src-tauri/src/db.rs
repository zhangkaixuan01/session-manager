use crate::{
    model::Result,
    storage::{self, Roots},
};
use rusqlite::{types::Value as SqlValue, Connection, OpenFlags};
use serde_json::Value;
use std::{collections::HashMap, path::Path, time::Duration};

fn open(path: &Path, write: bool) -> Result<Connection> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(path, flags).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    Ok(db)
}
fn columns(db: &Connection) -> Result<Vec<String>> {
    let mut stmt = db
        .prepare("PRAGMA table_info(threads)")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(std::result::Result::ok).collect())
}
pub fn titles(roots: &Roots) -> HashMap<String, String> {
    let mut map: HashMap<String, (i64, String)> = HashMap::new();
    for row in storage::history(&roots.codex.join("session_index.jsonl")).unwrap_or_default() {
        if let (Some(id), Some(title)) = (row["id"].as_str(), row["thread_name"].as_str()) {
            merge(
                &mut map,
                id.into(),
                title.into(),
                storage::timestamp(&row["updated_at"]).unwrap_or(0),
            );
        }
    }
    for path in roots.db_paths() {
        let Ok(db) = open(&path, false) else { continue };
        let cols = columns(&db).unwrap_or_default();
        let filter = if cols.iter().any(|c| c == "first_user_message") {
            " AND (first_user_message IS NULL OR TRIM(title) <> TRIM(first_user_message))"
        } else {
            ""
        };
        let mut stmt = match db.prepare(&format!(
            "SELECT id,title,updated_at FROM threads WHERE title <> ''{filter}"
        )) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2).unwrap_or(0),
            ))
        }) else {
            continue;
        };
        for (id, title, ts) in rows.flatten() {
            merge(
                &mut map,
                id,
                title,
                if ts < 10_000_000_000 { ts * 1000 } else { ts },
            );
        }
    }
    map.into_iter().map(|(k, (_, v))| (k, v)).collect()
}
fn merge(map: &mut HashMap<String, (i64, String)>, id: String, title: String, ts: i64) {
    if !title.trim().is_empty() && map.get(&id).is_none_or(|(old, _)| ts >= *old) {
        map.insert(id, (ts, title));
    }
}
pub fn rename(roots: &Roots, id: &str, title: &str) -> bool {
    let mut any = false;
    for path in roots.db_paths().into_iter().filter(|p| p.exists()) {
        if let Ok(db) = open(&path, true) {
            any |= db
                .execute("UPDATE threads SET title = ?1 WHERE id = ?2", [title, id])
                .is_ok_and(|n| n > 0);
        }
    }
    any
}
// Insert only known columns; never replace an existing thread or create a CLI-owned database.
pub fn register(roots: &Roots, row: &Value) -> (usize, Vec<String>) {
    let mut count = 0;
    let mut errors = Vec::new();
    for path in roots.db_paths().into_iter().filter(|p| p.exists()) {
        let result = (|| -> Result<()> {
            let db = open(&path, true)?;
            let cols: Vec<_> = columns(&db)?
                .into_iter()
                .filter(|c| row.get(c).is_some())
                .collect();
            if cols.is_empty() {
                return Err("threads 表结构不受支持".into());
            }
            let names = cols
                .iter()
                .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(",");
            let values: Vec<SqlValue> = cols
                .iter()
                .map(|c| match &row[c] {
                    Value::String(s) => SqlValue::Text(s.clone()),
                    Value::Number(n) => SqlValue::Integer(n.as_i64().unwrap_or(0)),
                    Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
                    _ => SqlValue::Null,
                })
                .collect();
            db.execute(
                &format!(
                    "INSERT INTO threads ({names}) VALUES ({})",
                    vec!["?"; cols.len()].join(",")
                ),
                rusqlite::params_from_iter(values),
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => count += 1,
            Err(e) => errors.push(format!("{}：{e}", path.display())),
        }
    }
    (count, errors)
}
