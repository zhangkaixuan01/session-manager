use crate::{
    db,
    model::{Preview, PreviewMessage, Provider, Result, Session},
    storage::{self, Roots},
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn text(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.into();
    }
    content
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|b| b.as_str().or_else(|| b["text"].as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}
pub fn candidate(provider: Provider, s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    match provider {
        Provider::Claude => {
            if s.contains("<local-command-caveat>")
                || [
                    "<local-command-stdout>",
                    "<local-command-stderr>",
                    "<task-notification>",
                    "<command-name>",
                ]
                .iter()
                .any(|p| s.starts_with(p))
            {
                return None;
            }
        }
        Provider::Codex => {
            if [
                "# AGENTS.md",
                "<environment_context>",
                "<user_instructions>",
                "<turn_aborted>",
            ]
            .iter()
            .any(|p| s.starts_with(p))
            {
                return None;
            }
            if s.starts_with("# Context from my IDE setup:") {
                let lines: Vec<_> = s.lines().collect();
                for (i, line) in lines.iter().enumerate().rev() {
                    if !line.trim().starts_with('#') {
                        continue;
                    }
                    let heading = line.trim().trim_start_matches('#').trim();
                    let marker = "my request for codex";
                    if heading.to_lowercase().starts_with(marker) {
                        let rest = heading[marker.len()..].trim_start();
                        if !rest.is_empty() && !rest.starts_with([':', '：', '-', '—']) {
                            continue;
                        }
                        let inline = rest.trim_start_matches([' ', ':', '：', '-', '—']);
                        let result = if inline.is_empty() {
                            lines[i + 1..].join("\n").trim().to_owned()
                        } else {
                            inline.into()
                        };
                        return (!result.is_empty()).then_some(result);
                    }
                }
                return None;
            }
        }
    }
    Some(s.into())
}
fn basename(s: &str) -> String {
    s.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(s)
        .into()
}
fn mtime(p: &Path) -> Option<i64> {
    fs::metadata(p)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|t| t.as_millis() as i64)
}
pub fn live(roots: &Roots) -> HashSet<String> {
    let mut result = HashSet::new();
    let system = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_processes(sysinfo::ProcessRefreshKind::nothing()),
    );
    for p in storage::files(&roots.claude.join("sessions")) {
        let Ok(data) = fs::read_to_string(p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&data) else {
            continue;
        };
        if let (Some(id), Some(pid)) = (v["sessionId"].as_str(), v["pid"].as_u64()) {
            if system.process(sysinfo::Pid::from_u32(pid as u32)).is_some() {
                result.insert(id.into());
            }
        }
    }
    result
}
#[derive(Default)]
pub struct Cache {
    entries: HashMap<PathBuf, (u64, Option<SystemTime>, Option<Session>)>,
}
impl Cache {
    pub fn invalidate(&mut self) {
        self.entries.clear();
    }
}
pub fn scan(
    roots: &Roots,
    provider: Provider,
    cache: &mut Cache,
    overrides: &HashMap<String, (String, bool)>,
) -> Vec<Session> {
    let titles = if provider == Provider::Codex {
        db::titles(roots)
    } else {
        HashMap::new()
    };
    let running = if provider == Provider::Claude {
        live(roots)
    } else {
        HashSet::new()
    };
    let paths: Vec<_> = roots
        .session_roots(provider)
        .iter()
        .flat_map(|r| storage::files(r))
        .filter(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            if provider == Provider::Claude {
                name.ends_with(".jsonl") && !name.starts_with("agent-") && name != "journal.jsonl"
            } else {
                name.ends_with(".jsonl")
                    || (name.ends_with(".jsonl.zst") && !p.with_extension("").exists())
            }
        })
        .collect();
    let mut result = Vec::new();
    for path in paths {
        let Ok(st) = fs::metadata(&path) else {
            continue;
        };
        let key = (st.len(), st.modified().ok());
        let cached = cache
            .entries
            .get(&path)
            .filter(|e| e.0 == key.0 && e.1 == key.1);
        let meta = if let Some(e) = cached {
            e.2.clone()
        } else {
            match scan_file(&path, provider) {
                Ok(s) => {
                    cache
                        .entries
                        .insert(path.clone(), (key.0, key.1, s.clone()));
                    s
                }
                Err(_) => continue,
            }
        };
        if let Some(mut session) = meta {
            session.running = running.contains(&session.session_id);
            if provider == Provider::Codex {
                if let Some(title) = overrides
                    .get(&session.session_id)
                    .map(|v| &v.0)
                    .or_else(|| titles.get(&session.session_id))
                {
                    session.title = Some(storage::truncate(title, 160));
                    session.title_source = "custom".into();
                }
            }
            result.push(session);
        }
    }
    result.sort_by(|a, b| {
        b.running
            .cmp(&a.running)
            .then_with(|| {
                b.last_active_at
                    .or(b.created_at)
                    .cmp(&a.last_active_at.or(a.created_at))
            })
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    result
}
fn scan_file(path: &Path, provider: Provider) -> Result<Option<Session>> {
    let head = storage::head(path, 10)?;
    let compressed = path.extension().is_some_and(|e| e == "zst");
    let tail = if compressed {
        Vec::new()
    } else {
        storage::tail(path)?
    };
    let mut id = None;
    let mut cwd = None;
    let mut created = None;
    let mut first = None;
    for v in &head {
        created = created.or_else(|| storage::timestamp(&v["timestamp"]));
        if provider == Provider::Claude {
            id = id.or_else(|| v["sessionId"].as_str().map(str::to_owned));
            cwd = cwd.or_else(|| v["cwd"].as_str().map(str::to_owned));
            if first.is_none() && v["type"] == "user" && v["isMeta"] != true {
                first = candidate(provider, &text(&v["message"]["content"]));
            }
        } else {
            let p = &v["payload"];
            if v["type"] == "session_meta" {
                if p["source"].get("subagent").is_some() {
                    return Ok(None);
                }
                id = p["id"]
                    .as_str()
                    .or(p["session_id"].as_str())
                    .map(str::to_owned);
                cwd = p["cwd"].as_str().map(str::to_owned);
                created = created.or_else(|| storage::timestamp(&p["timestamp"]));
            }
            if first.is_none() && v["type"] == "response_item" && p["role"] == "user" {
                first = candidate(provider, &text(&p["content"]));
            }
        }
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let id = id.or_else(|| {
        regex::Regex::new(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        )
        .unwrap()
        .find(&name)
        .map(|m| m.as_str().to_owned())
    });
    let Some(id) = id else { return Ok(None) };
    let mut last = None;
    let mut summary = None;
    let mut custom = None;
    let mut auto = None;
    let mut legacy = None;
    let mut relocated = None;
    for v in tail.iter().rev() {
        last = last.or_else(|| storage::timestamp(&v["timestamp"]));
        if provider == Provider::Claude {
            if v["type"] == "custom-title" {
                custom = custom.or_else(|| nonempty(&v["customTitle"]));
            }
            if v["type"] == "ai-title" {
                auto = auto.or_else(|| nonempty(&v["aiTitle"]));
            }
            if v["type"] == "summary" {
                legacy = legacy.or_else(|| nonempty(&v["summary"]));
            }
            if v["type"] == "relocated" {
                relocated = relocated.or_else(|| nonempty(&v["relocatedCwd"]));
            }
            if summary.is_none() && v["isMeta"] != true {
                summary = candidate(provider, &text(&v["message"]["content"]));
            }
        } else if summary.is_none()
            && v["type"] == "response_item"
            && v["payload"]["type"] == "message"
        {
            summary = candidate(provider, &text(&v["payload"]["content"]));
        }
    }
    cwd = relocated.or(cwd);
    let (title, source) = if custom.is_some() {
        (custom, "custom")
    } else if auto.is_some() || legacy.is_some() {
        (auto.or(legacy), "auto")
    } else if first.is_some() {
        (first, "firstMessage")
    } else {
        (cwd.as_ref().map(|s| basename(s)), "dir")
    };
    Ok(Some(Session {
        provider_id: provider,
        session_id: id.clone(),
        title: title.map(|s| storage::truncate(&s, 160)),
        title_source: source.into(),
        summary: summary.map(|s| storage::truncate(&s, 240)),
        project_dir: cwd,
        created_at: created,
        last_active_at: last.or_else(|| mtime(path)),
        source_path: path.to_string_lossy().into(),
        resume_command: provider.command(&id),
        archived: path
            .components()
            .any(|c| c.as_os_str() == "archived_sessions"),
        running: false,
    }))
}
fn nonempty(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

pub fn preview(path: &Path, provider: Provider) -> Result<Preview> {
    use std::io::{BufRead, Read};
    let mut input = storage::reader(path)?;
    let mut messages: Vec<PreviewMessage> = Vec::new();
    let mut consumed = 0;
    let mut shown = 0;
    let mut truncated = false;
    let mut previous_id = String::new();
    let reminders = regex::Regex::new(r"(?s)<system-reminder>.*?</system-reminder>").unwrap();
    loop {
        let mut line = String::new();
        let n = input
            .by_ref()
            .take(8 * 1024 * 1024 + 1)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        consumed += n;
        if consumed > storage::MAX_HISTORY as usize
            || n > 8 * 1024 * 1024
            || messages.len() >= 500
            || shown >= 1024 * 1024
        {
            truncated = true;
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let p = if provider == Provider::Claude {
            if v["isMeta"] == true {
                continue;
            }
            &v["message"]
        } else {
            if v["type"] != "response_item" {
                continue;
            }
            &v["payload"]
        };
        let role = p["role"]
            .as_str()
            .or(v["type"].as_str())
            .unwrap_or_default();
        if role != "user" && role != "assistant" {
            continue;
        }
        let clean = reminders
            .replace_all(&text(&p["content"]), "")
            .trim()
            .to_owned();
        let Some(mut body) = candidate(provider, &clean) else {
            continue;
        };
        if body.len() + shown > 1024 * 1024 {
            let mut end = (1024 * 1024 - shown).min(body.len());
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            body.truncate(end);
            truncated = true;
        }
        shown += body.len();
        let id = p["id"].as_str().unwrap_or_default();
        if provider == Provider::Claude
            && role == "assistant"
            && !id.is_empty()
            && previous_id == id
            && messages.last().is_some_and(|m| m.role == role)
        {
            let m = messages.last_mut().unwrap();
            m.text.push('\n');
            m.text.push_str(&body);
        } else {
            messages.push(PreviewMessage {
                role: role.into(),
                ts: storage::timestamp(&v["timestamp"]),
                text: body,
            });
        }
        previous_id = id.into();
        if truncated {
            break;
        }
    }
    Ok(Preview {
        messages,
        truncated,
    })
}
