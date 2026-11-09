use crate::model::{Provider, Result};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const MAX_HISTORY: u64 = 64 * 1024 * 1024;
const MAX_LINE: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Roots {
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub sqlite_home: Option<PathBuf>,
}
impl Roots {
    pub fn discover() -> Result<Self> {
        let home = dirs::home_dir().ok_or("找不到当前用户目录")?;
        Ok(Self {
            claude: env::var_os("CLAUDE_CONFIG_DIR")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude")),
            codex: env::var_os("CODEX_HOME")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex")),
            sqlite_home: env::var_os("CODEX_SQLITE_HOME")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
        })
    }
    pub fn session_roots(&self, provider: Provider) -> Vec<PathBuf> {
        match provider {
            Provider::Claude => vec![self.claude.join("projects")],
            Provider::Codex => vec![
                self.codex.join("sessions"),
                self.codex.join("archived_sessions"),
            ],
        }
    }
    pub fn db_paths(&self) -> Vec<PathBuf> {
        let mut paths = vec![
            self.codex.join("state_5.sqlite"),
            self.codex.join("sqlite/state_5.sqlite"),
        ];
        if let Ok(text) = fs::read_to_string(self.codex.join("config.toml")) {
            if let Ok(config) = toml::from_str::<toml::Value>(&text) {
                if let Some(dir) = config.get("sqlite_home").and_then(toml::Value::as_str) {
                    let p = PathBuf::from(dir);
                    paths.push(
                        if p.is_absolute() {
                            p
                        } else {
                            self.codex.join(p)
                        }
                        .join("state_5.sqlite"),
                    );
                }
            }
        }
        if let Some(dir) = &self.sqlite_home {
            paths.push(dir.join("state_5.sqlite"));
        }
        let mut unique = Vec::new();
        for path in paths {
            if !unique.contains(&path) {
                unique.push(path);
            }
        }
        unique
    }
    pub fn verify(
        &self,
        provider: Provider,
        source: &str,
        session_id: Option<&str>,
    ) -> Result<PathBuf> {
        let p = fs::canonicalize(source).map_err(|e| format!("无法读取会话：{e}"))?;
        if !p.is_file()
            || !self
                .session_roots(provider)
                .iter()
                .any(|root| fs::canonicalize(root).is_ok_and(|r| p.starts_with(r)))
        {
            return Err("会话路径不在允许范围内".into());
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if !(name.ends_with(".jsonl")
            || (provider == Provider::Codex && name.ends_with(".jsonl.zst")))
        {
            return Err("不是受支持的会话文件".into());
        }
        if let Some(id) = session_id {
            if uuid::Uuid::parse_str(id).is_err() {
                return Err("sessionId 无效".into());
            }
            let header_id = head(&p, 20)?.iter().find_map(|v| match provider {
                Provider::Claude => v["sessionId"].as_str().map(str::to_owned),
                Provider::Codex if v["type"] == "session_meta" => v["payload"]["id"]
                    .as_str()
                    .or(v["payload"]["session_id"].as_str())
                    .map(str::to_owned),
                _ => None,
            });
            let named = match provider {
                Provider::Claude => name == format!("{id}.jsonl"),
                Provider::Codex => {
                    name.ends_with(&format!("-{id}.jsonl"))
                        || name.ends_with(&format!("-{id}.jsonl.zst"))
                }
            };
            if !named || header_id.as_deref().is_some_and(|actual| actual != id) {
                return Err("会话文件与 sessionId 不匹配".into());
            }
        }
        Ok(p)
    }
}

pub fn files(root: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return result;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            result.extend(files(&entry.path()));
        } else if kind.is_file() {
            result.push(entry.path());
        }
    }
    result
}

pub fn reader(p: &Path) -> Result<Box<dyn BufRead>> {
    let file = File::open(p).map_err(|e| e.to_string())?;
    if p.extension().is_some_and(|x| x == "zst") {
        Ok(Box::new(BufReader::new(
            zstd::stream::read::Decoder::new(file).map_err(|e| e.to_string())?,
        )))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

// Limit before allocation, including decompressed bytes. Reject incomplete conversion instead of silently losing history.
pub fn read_lines(p: &Path, max_lines: usize, max_bytes: u64) -> Result<Vec<Value>> {
    let mut input = reader(p)?;
    let mut out = Vec::new();
    let mut total = 0u64;
    for _ in 0..max_lines {
        let mut line = String::new();
        let count = input
            .by_ref()
            .take(MAX_LINE + 1)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if count as u64 > MAX_LINE || total > max_bytes {
            return Err("会话超过安全读取上限，未生成不完整副本".into());
        }
        if let Ok(v) = serde_json::from_str(&line) {
            out.push(v);
        }
    }
    Ok(out)
}
pub fn head(p: &Path, count: usize) -> Result<Vec<Value>> {
    read_lines(p, count, MAX_HISTORY)
}
pub fn history(p: &Path) -> Result<Vec<Value>> {
    read_lines(p, usize::MAX, MAX_HISTORY)
}
pub fn tail(p: &Path) -> Result<Vec<Value>> {
    let mut f = File::open(p).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let offset = len.saturating_sub(64 * 1024);
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text
        .lines()
        .skip(usize::from(offset > 0))
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect())
}
pub fn timestamp(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| {
        v.as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
    })
}
pub fn iso(ts: Option<i64>) -> String {
    ts.and_then(DateTime::from_timestamp_millis)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn truncate(s: &str, max: usize) -> String {
    let clean = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > max {
        format!(
            "{}…",
            clean
                .chars()
                .take(max.saturating_sub(1))
                .collect::<String>()
        )
    } else {
        clean
    }
}
pub fn append(p: &Path, value: &Value) -> Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(p)
        .map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut data = Vec::new();
    if len > 0 {
        file.seek(SeekFrom::End(-1)).map_err(|e| e.to_string())?;
        let mut last = [0];
        file.read_exact(&mut last).map_err(|e| e.to_string())?;
        if last[0] != b'\n' {
            data.push(b'\n');
        }
    }
    serde_json::to_writer(&mut data, value).map_err(|e| e.to_string())?;
    data.push(b'\n');
    file.write_all(&data).map_err(|e| e.to_string())
}
pub fn write_new(p: &Path, lines: &[Value]) -> Result<()> {
    fs::create_dir_all(p.parent().ok_or("无效目标目录")?).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(p)
        .map_err(|e| e.to_string())?;
    for line in lines {
        serde_json::to_writer(&mut file, line).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
    }
    file.sync_all().map_err(|e| e.to_string())
}
