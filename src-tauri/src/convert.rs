use crate::{
    db,
    model::{ConvertArgs, Provider, Result},
    sessions,
    storage::{self, Roots},
};
use chrono::{Local, Utc};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};
use uuid::Uuid;

#[derive(Clone, Debug)]
struct Call {
    id: String,
    name: String,
    args: String,
}
#[derive(Clone, Debug)]
struct Output {
    id: String,
    text: String,
    error: bool,
}
#[derive(Clone, Debug)]
struct Row {
    role: String,
    ts: Option<i64>,
    text: String,
    calls: Vec<Call>,
    outputs: Vec<Output>,
    message_id: String,
}
impl Row {
    fn new(role: &str, ts: Option<i64>) -> Self {
        Self {
            role: role.into(),
            ts,
            text: String::new(),
            calls: vec![],
            outputs: vec![],
            message_id: String::new(),
        }
    }
    fn meaningful(&self) -> bool {
        !self.text.trim().is_empty() || !self.calls.is_empty() || !self.outputs.is_empty()
    }
}
struct Source {
    cwd: String,
    created: Option<i64>,
    rows: Vec<Row>,
    warnings: Vec<String>,
}
fn string(v: &Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_else(|| {
        if v.is_null() {
            String::new()
        } else {
            v.to_string()
        }
    })
}
fn output_text(v: &Value) -> String {
    if v.is_array() {
        let t = sessions::text(v);
        if t.is_empty() {
            v.to_string()
        } else {
            t
        }
    } else {
        string(v)
    }
}

fn read(path: &Path, provider: Provider) -> Result<Source> {
    let records = storage::history(path)?;
    let mut cwd = None;
    let mut created = None;
    let mut rows: Vec<Row> = vec![];
    let mut dropped = 0;
    let mut unsupported = 0;
    for v in &records {
        created = created.or_else(|| storage::timestamp(&v["timestamp"]));
        let ts = storage::timestamp(&v["timestamp"]);
        if provider == Provider::Claude {
            cwd = cwd.or_else(|| v["cwd"].as_str().map(str::to_owned));
            if v["type"] == "relocated" {
                cwd = v["relocatedCwd"].as_str().map(str::to_owned).or(cwd);
            }
            if v["isMeta"] == true || v["isSidechain"] == true {
                continue;
            }
            let role = v["type"].as_str().unwrap_or_default();
            if role != "user" && role != "assistant" {
                continue;
            }
            let m = &v["message"];
            let mut row = Row::new(role, ts);
            row.message_id = m["id"].as_str().unwrap_or_default().into();
            let content = &m["content"];
            if let Some(s) = content.as_str() {
                if role == "assistant" || sessions::candidate(provider, s).is_some() {
                    row.text = s.into();
                }
            } else if let Some(blocks) = content.as_array() {
                for b in blocks {
                    match b["type"].as_str().unwrap_or_default() {
                        "text" => {
                            let s = string(&b["text"]);
                            if role == "assistant" || sessions::candidate(provider, &s).is_some() {
                                row.text.push_str(&s);
                            }
                        }
                        "thinking" | "redacted_thinking" => dropped += 1,
                        "tool_use" if role == "assistant" => {
                            if let (Some(id), Some(name)) = (b["id"].as_str(), b["name"].as_str()) {
                                row.calls.push(Call {
                                    id: id.into(),
                                    name: name.into(),
                                    args: b.get("input").unwrap_or(&json!({})).to_string(),
                                });
                            }
                        }
                        "tool_result" if role == "user" => {
                            if let Some(id) = b["tool_use_id"].as_str() {
                                row.outputs.push(Output {
                                    id: id.into(),
                                    text: output_text(&b["content"]),
                                    error: b["is_error"] == true,
                                });
                            }
                        }
                        _ => unsupported += 1,
                    }
                }
            }
            if !row.meaningful() {
                continue;
            }
            if role == "assistant"
                && !row.message_id.is_empty()
                && rows
                    .last()
                    .is_some_and(|p| p.role == role && p.message_id == row.message_id)
            {
                let prev = rows.last_mut().unwrap();
                if row.text.starts_with(&prev.text) {
                    prev.text = row.text;
                } else if !prev.text.ends_with(&row.text) {
                    prev.text.push_str(&row.text);
                }
                for c in row.calls {
                    if !prev.calls.iter().any(|p| p.id == c.id) {
                        prev.calls.push(c);
                    }
                }
            } else {
                rows.push(row);
            }
        } else {
            let p = &v["payload"];
            if v["type"] == "session_meta" {
                cwd = p["cwd"].as_str().map(str::to_owned);
                continue;
            }
            if v["type"] == "compacted" {
                // Keep full pre-compaction history if present; replacement history is only a fallback.
                if rows.is_empty() {
                    if let Some(items) = p["replacement_history"].as_array() {
                        for item in items {
                            codex_item(item, ts, &mut rows, &mut dropped, &mut unsupported);
                        }
                    }
                }
                continue;
            }
            if v["type"] == "response_item" {
                codex_item(p, ts, &mut rows, &mut dropped, &mut unsupported);
            }
        }
    }
    let cwd = cwd
        .filter(|s| !s.trim().is_empty())
        .ok_or("源会话缺少 cwd，无法定位项目目录")?;
    if rows.is_empty() {
        return Err("没有可转换的对话内容".into());
    }
    let mut warnings = vec![];
    if dropped > 0 {
        warnings.push(format!("已略过 {dropped} 条不可跨 CLI 移植的思考记录"));
    }
    if unsupported > 0 {
        warnings.push(format!(
            "已略过 {unsupported} 个目标格式不支持的内容块（如图片或特殊事件）"
        ));
    }
    Ok(Source {
        cwd,
        created,
        rows: pair_tools(rows, &mut warnings),
        warnings,
    })
}
fn codex_item(
    p: &Value,
    ts: Option<i64>,
    rows: &mut Vec<Row>,
    dropped: &mut usize,
    unsupported: &mut usize,
) {
    let kind = p["type"].as_str().unwrap_or_default();
    if kind == "message" {
        let role = p["role"].as_str().unwrap_or_default();
        if role != "user" && role != "assistant" {
            return;
        }
        let mut row = Row::new(role, ts);
        let text = sessions::text(&p["content"]);
        row.text = if role == "user" {
            sessions::candidate(Provider::Codex, &text).unwrap_or_default()
        } else {
            text
        };
        if let Some(blocks) = p["content"].as_array() {
            *unsupported += blocks
                .iter()
                .filter(|b| b.get("text").is_none() && !b.is_string())
                .count();
        }
        if row.meaningful() {
            rows.push(row);
        }
    } else if kind == "function_call" || kind == "custom_tool_call" {
        if let Some(id) = p["call_id"].as_str() {
            let mut row = Row::new("assistant", ts);
            row.calls.push(Call {
                id: id.into(),
                name: p["name"].as_str().unwrap_or("tool").into(),
                args: string(if kind == "function_call" {
                    &p["arguments"]
                } else {
                    &p["input"]
                }),
            });
            rows.push(row);
        }
    } else if kind == "function_call_output" || kind == "custom_tool_call_output" {
        if let Some(id) = p["call_id"].as_str() {
            let mut row = Row::new("user", ts);
            row.outputs.push(Output {
                id: id.into(),
                text: output_text(&p["output"]),
                error: false,
            });
            rows.push(row);
        }
    } else if kind == "reasoning" {
        *dropped += 1;
    } else {
        *unsupported += 1;
    }
}
// Claude requires one result for every call immediately after its assistant message.
// Move results next to calls, retain unpaired outputs as plain text, and explicitly mark missing results.
fn pair_tools(rows: Vec<Row>, warnings: &mut Vec<String>) -> Vec<Row> {
    let mut outputs: HashMap<String, Output> = HashMap::new();
    for row in &rows {
        for o in &row.outputs {
            outputs.entry(o.id.clone()).or_insert_with(|| o.clone());
        }
    }
    let all_calls: HashSet<_> = rows
        .iter()
        .flat_map(|r| r.calls.iter().map(|c| c.id.clone()))
        .collect();
    let mut seen = HashSet::new();
    let mut missing = 0;
    let mut orphan = 0;
    let mut out = vec![];
    for mut row in rows {
        for o in &row.outputs {
            if !all_calls.contains(&o.id) {
                row.text
                    .push_str(&format!("\n[历史工具结果 {}]\n{}", o.id, o.text));
                orphan += 1;
            }
        }
        row.outputs.clear();
        row.calls.retain(|c| seen.insert(c.id.clone()));
        if !row.meaningful() {
            continue;
        }
        let mut results = Row::new("user", row.ts);
        for c in &row.calls {
            results
                .outputs
                .push(outputs.remove(&c.id).unwrap_or_else(|| {
                    missing += 1;
                    Output {
                        id: c.id.clone(),
                        text: "源会话未记录工具结果（转换时补齐，未重新执行）".into(),
                        error: true,
                    }
                }));
        }
        out.push(row);
        if results.meaningful() {
            out.push(results);
        }
    }
    if missing > 0 {
        warnings.push(format!(
            "已为 {missing} 个未完成工具调用补齐错误结果，未重新执行工具"
        ));
    }
    if orphan > 0 {
        warnings.push(format!("已将 {orphan} 条无对应调用的工具结果保留为文本"));
    }
    out
}
fn latest_headers(roots: &Roots, provider: Provider) -> Vec<Value> {
    let mut paths: Vec<_> = roots
        .session_roots(provider)
        .iter()
        .flat_map(|r| storage::files(r))
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl" || e == "zst"))
        .collect();
    paths.sort_by_cached_key(|p| {
        std::cmp::Reverse(fs::metadata(p).ok().and_then(|m| m.modified().ok()))
    });
    for p in paths.into_iter().take(10) {
        if let Ok(lines) = storage::head(&p, 20) {
            if !lines.is_empty() {
                return lines;
            }
        }
    }
    vec![]
}
fn stamp(lines: &mut Vec<Value>, kind: &str, payload: Value, ts: Option<i64>) {
    lines.push(
        json!({"type":kind,"payload":payload,"timestamp":storage::iso(ts),"ordinal":lines.len()}),
    );
}

pub fn convert(roots: &Roots, args: &ConvertArgs) -> Result<Value> {
    let source = roots.verify(args.provider_id, &args.source_path, Some(&args.session_id))?;
    let mut src = read(&source, args.provider_id)?;
    let id = Uuid::new_v4().to_string();
    let label = if args.provider_id == Provider::Claude {
        "Claude"
    } else {
        "Codex"
    };
    let base = args
        .title
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("未命名会话");
    let title = format!("{} ⟲自{label}", storage::truncate(base, 120));
    let target = if args.provider_id == Provider::Claude {
        Provider::Codex
    } else {
        Provider::Claude
    };
    let baseline = latest_headers(roots, target);
    if target == Provider::Claude {
        let version = baseline
            .iter()
            .find_map(|v| v["version"].as_str())
            .unwrap_or("2.1.311");
        let model = baseline
            .iter()
            .find_map(|v| v["message"]["model"].as_str())
            .unwrap_or("claude");
        let escaped: String = src
            .cwd
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let file = roots
            .claude
            .join("projects")
            .join(escaped)
            .join(format!("{id}.jsonl"));
        let mut lines = vec![];
        let mut parent: Option<String> = None;
        for row in &src.rows {
            let mut blocks = vec![];
            for output in &row.outputs {
                blocks.push(json!({"type":"tool_result","tool_use_id":output.id,"content":output.text,"is_error":output.error}));
            }
            if !row.text.trim().is_empty() {
                blocks.push(json!({"type":"text","text":row.text}));
            }
            for call in &row.calls {
                let input = serde_json::from_str::<Value>(&call.args)
                    .ok()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| json!({"input":call.args}));
                blocks.push(json!({"type":"tool_use","id":call.id,"name":call.name,"input":input}));
            }
            let message = if row.role == "assistant" {
                json!({"id":format!("msg_{}",Uuid::new_v4().simple()),"type":"message","role":"assistant","model":model,"content":blocks,"stop_reason":if row.calls.is_empty(){"end_turn"}else{"tool_use"},"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}})
            } else {
                json!({"role":"user","content":blocks})
            };
            let uid = Uuid::new_v4().to_string();
            lines.push(json!({"parentUuid":parent,"uuid":uid,"isSidechain":false,"type":row.role,"message":message,"timestamp":storage::iso(row.ts),"cwd":src.cwd,"sessionId":id,"version":version,"gitBranch":"HEAD","userType":"external"}));
            parent = Some(uid);
        }
        lines.push(json!({"type":"custom-title","customTitle":title,"sessionId":id}));
        storage::write_new(&file, &lines)?;
    } else {
        let meta = baseline
            .iter()
            .find(|v| v["type"] == "session_meta")
            .map(|v| &v["payload"]);
        let field = |key: &str, fallback: &str| -> String {
            meta.and_then(|v| v[key].as_str())
                .unwrap_or(fallback)
                .into()
        };
        let originator = field("originator", "codex-tui");
        let version = field("cli_version", "0.163.0");
        let model_provider = field("model_provider", "openai");
        let config: toml::Value = toml::from_str(
            &fs::read_to_string(roots.codex.join("config.toml")).unwrap_or_default(),
        )
        .unwrap_or(toml::Value::Table(Default::default()));
        let model = config
            .get("model")
            .and_then(toml::Value::as_str)
            .or_else(|| {
                baseline
                    .iter()
                    .find(|v| v["type"] == "turn_context")
                    .and_then(|v| v["payload"]["model"].as_str())
            })
            .unwrap_or("gpt-6.1-sol");
        let now = Local::now();
        let now_ms = Utc::now().timestamp_millis();
        let file = roots
            .codex
            .join("sessions")
            .join(now.format("%Y/%m/%d").to_string())
            .join(format!(
                "rollout-{}-{id}.jsonl",
                now.format("%Y-%m-%dT%H-%M-%S")
            ));
        let mut lines = vec![];
        stamp(
            &mut lines,
            "session_meta",
            json!({"id":id,"session_id":id,"timestamp":storage::iso(src.created),"cwd":src.cwd,"originator":originator,"cli_version":version,"source":"cli","thread_source":"user","model_provider":model_provider}),
            src.created,
        );
        for row in &src.rows {
            for o in &row.outputs {
                stamp(
                    &mut lines,
                    "response_item",
                    json!({"type":"function_call_output","call_id":o.id,"output":o.text}),
                    row.ts,
                );
            }
            if !row.text.trim().is_empty() {
                if row.role == "user" {
                    stamp(
                        &mut lines,
                        "turn_context",
                        json!({"turn_id":Uuid::new_v4().to_string(),"cwd":src.cwd,"approval_policy":"on-request","sandbox_policy":{"type":"read-only"},"model":model,"effort":"medium"}),
                        row.ts,
                    );
                }
                stamp(
                    &mut lines,
                    "response_item",
                    json!({"type":"message","role":row.role,"content":[{"type":if row.role=="user"{"input_text"}else{"output_text"},"text":row.text}],"status":"completed"}),
                    row.ts,
                );
            }
            for c in &row.calls {
                stamp(
                    &mut lines,
                    "response_item",
                    json!({"type":"function_call","name":c.name,"arguments":c.args,"call_id":c.id,"status":"completed"}),
                    row.ts,
                );
            }
        }
        storage::write_new(&file, &lines)?;
        let first = src
            .rows
            .iter()
            .find(|r| r.role == "user" && !r.text.trim().is_empty())
            .map(|r| storage::truncate(&r.text, 240))
            .unwrap_or_default();
        let row = json!({"id":id,"rollout_path":file.to_string_lossy(),"created_at":now_ms/1000,"updated_at":now_ms/1000,"source":"cli","model_provider":model_provider,"cwd":src.cwd,"title":title,"sandbox_policy":"{\"type\":\"read-only\"}","approval_mode":"on-request","tokens_used":0,"has_user_event":1,"archived":0,"cli_version":version,"first_user_message":first,"memory_mode":"disabled","model":model,"reasoning_effort":"medium","created_at_ms":now_ms,"updated_at_ms":now_ms,"thread_source":"user","preview":first,"recency_at":now_ms/1000,"recency_at_ms":now_ms,"history_mode":"paginated","originator":originator});
        let (registered, errors) = db::register(roots, &row);
        if registered == 0 && roots.db_paths().iter().any(|p| p.exists()) {
            // Only remove the newly created unregistered copy, never the source.
            let cleanup = fs::remove_file(&file);
            return Err(format!(
                "Codex 数据库注册失败，{}：{}",
                if cleanup.is_ok() {
                    "已撤销本次副本"
                } else {
                    "副本保留在目标会话目录"
                },
                errors.join("；")
            ));
        }
        if registered == 0 {
            src.warnings.push("未找到 Codex 状态数据库；副本已生成，需由 Codex 扫描发现。如无法恢复，请先运行一次 Codex 后再转换。".into());
        }
        src.warnings
            .extend(errors.into_iter().map(|s| format!("部分数据库未注册：{s}")));
        if let Err(e) = storage::append(
            &roots.codex.join("session_index.jsonl"),
            &json!({"id":id,"thread_name":title,"updated_at":storage::iso(Some(now_ms))}),
        ) {
            src.warnings
                .push(format!("副本已生成，标题索引写入失败：{e}"));
        }
    }
    Ok(
        json!({"ok":true,"newSessionId":id,"targetProvider":target,"resumeCommand":target.command(&id),"warnings":src.warnings}),
    )
}
