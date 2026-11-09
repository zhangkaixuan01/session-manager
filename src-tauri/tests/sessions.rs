use serde_json::{json, Value};
use session_manager::{
    convert,
    model::{ConvertArgs, FileArgs, Provider, RenameArgs},
    sessions,
    storage::{self, Roots},
    Backend,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

const ID: &str = "12345678-1234-4234-8234-123456789abc";
const OTHER: &str = "87654321-4321-4321-8321-cba987654321";
struct Fixture {
    _temp: TempDir,
    roots: Roots,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let roots = Roots {
            claude: temp.path().join("claude"),
            codex: temp.path().join("codex"),
            sqlite_home: None,
        };
        fs::create_dir_all(&roots.codex).unwrap();
        Self { _temp: temp, roots }
    }
    fn claude(&self, id: &str, lines: &[Value]) -> PathBuf {
        let p = self
            .roots
            .claude
            .join("projects/test")
            .join(format!("{id}.jsonl"));
        storage::write_new(&p, lines).unwrap();
        p
    }
    fn codex(&self, lines: &[Value]) -> PathBuf {
        let p = self
            .roots
            .codex
            .join("sessions/2026/11/09")
            .join(format!("rollout-2026-11-09T00-00-00-{ID}.jsonl"));
        storage::write_new(&p, lines).unwrap();
        p
    }
    fn db(&self) -> rusqlite::Connection {
        let db = rusqlite::Connection::open(self.roots.codex.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, first_user_message TEXT, model TEXT, future_column TEXT DEFAULT 'future');").unwrap();
        db
    }
}
fn user(id: &str, text: &str, ts: &str) -> Value {
    json!({"type":"user","sessionId":id,"cwd":"D:\\project","timestamp":ts,"message":{"role":"user","content":text}})
}
fn codex_meta() -> Value {
    json!({"type":"session_meta","payload":{"id":ID,"cwd":"D:\\project"},"timestamp":"2026-11-09T00:00:00Z"})
}
fn item(payload: Value) -> Value {
    json!({"type":"response_item","timestamp":"2026-11-09T00:00:01Z","payload":payload})
}
fn args(provider: Provider, p: &Path) -> ConvertArgs {
    ConvertArgs {
        provider_id: provider,
        source_path: p.to_string_lossy().into(),
        session_id: ID.into(),
        title: Some("测试标题".into()),
    }
}
fn hash(p: &Path) -> Vec<u8> {
    Sha256::digest(fs::read(p).unwrap()).to_vec()
}

#[test]
fn claude_titles_live_pinning_cache_and_append_only_rename() {
    let f = Fixture::new();
    let p = f.claude(
        ID,
        &[
            user(ID, "真实提问", "2026-11-08T00:00:00Z"),
            json!({"type":"ai-title","aiTitle":"自动标题"}),
            json!({"type":"custom-title","customTitle":"手动标题"}),
        ],
    );
    f.claude(OTHER, &[user(OTHER, "较新会话", "2026-11-09T00:00:00Z")]);
    fs::create_dir_all(f.roots.claude.join("sessions")).unwrap();
    fs::write(
        f.roots.claude.join("sessions/live.json"),
        json!({"sessionId":ID,"pid":std::process::id()}).to_string(),
    )
    .unwrap();
    let original = fs::read(&p).unwrap();
    let mut b = Backend::new(f.roots.clone());
    let list = b.list(Provider::Claude);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].session_id, ID);
    assert!(list[0].running);
    assert_eq!(list[0].title.as_deref(), Some("手动标题"));
    b.rename(RenameArgs {
        provider_id: Provider::Claude,
        source_path: p.to_string_lossy().into(),
        session_id: ID.into(),
        new_title: "改名成功".into(),
    })
    .unwrap();
    assert!(fs::read(&p).unwrap().starts_with(&original));
    assert_eq!(
        b.list(Provider::Claude)[0].title.as_deref(),
        Some("改名成功")
    );
    fs::remove_file(f.roots.claude.join("sessions/live.json")).unwrap();
    assert_eq!(b.list(Provider::Claude)[0].session_id, OTHER);
}
#[test]
fn paths_and_ids_are_validated_before_mutation() {
    let f = Fixture::new();
    let p = f.claude(ID, &[user(ID, "hello", "2026-11-09T00:00:00Z")]);
    let before = hash(&p);
    assert!(f
        .roots
        .verify(Provider::Claude, &p.to_string_lossy(), Some(OTHER))
        .is_err());
    assert!(f
        .roots
        .verify(Provider::Codex, &p.to_string_lossy(), None)
        .is_err());
    let outside = f._temp.path().join(format!("{ID}.jsonl"));
    fs::copy(&p, &outside).unwrap();
    assert!(f
        .roots
        .verify(Provider::Claude, &outside.to_string_lossy(), Some(ID))
        .is_err());
    let mut b = Backend::new(f.roots.clone());
    assert!(b
        .rename(RenameArgs {
            provider_id: Provider::Claude,
            source_path: p.to_string_lossy().into(),
            session_id: ID.into(),
            new_title: "bad\ntitle".into()
        })
        .is_err());
    assert!(b
        .delete(FileArgs {
            provider_id: Provider::Claude,
            source_path: outside.to_string_lossy().into()
        })
        .is_err());
    assert_eq!(before, hash(&p));
}
#[test]
fn codex_titles_compression_and_database_rename() {
    let f = Fixture::new();
    let p=f.codex(&[codex_meta(),item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md rules"}]})),item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"真实提问"}]}))]);
    let db = f.db();
    db.execute("INSERT INTO threads(id,title,rollout_path,cwd,created_at,updated_at,first_user_message) VALUES (?1,'数据库标题',?2,'cwd',1,2000000000,'真实提问')",rusqlite::params![ID,p.to_string_lossy()]).unwrap();
    storage::append(
        &f.roots.codex.join("session_index.jsonl"),
        &json!({"id":ID,"thread_name":"旧标题","updated_at":"2026-01-01T00:00:00Z"}),
    )
    .unwrap();
    let zst = PathBuf::from(format!("{}.zst", p.display()));
    fs::write(
        &zst,
        zstd::encode_all(fs::read(&p).unwrap().as_slice(), 1).unwrap(),
    )
    .unwrap();
    let mut b = Backend::new(f.roots.clone());
    let list = b.list(Provider::Codex);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].title.as_deref(), Some("数据库标题"));
    fs::remove_file(&p).unwrap();
    let list = b.list(Provider::Codex);
    assert_eq!(list.len(), 1);
    assert!(list[0].source_path.ends_with(".zst"));
    b.rename(RenameArgs {
        provider_id: Provider::Codex,
        source_path: zst.to_string_lossy().into(),
        session_id: ID.into(),
        new_title: "索引数据库一致".into(),
    })
    .unwrap();
    let title: String = db
        .query_row("SELECT title FROM threads WHERE id=?1", [ID], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "索引数据库一致");
    assert_eq!(
        b.list(Provider::Codex)[0].title.as_deref(),
        Some("索引数据库一致")
    );
    assert_eq!(
        sessions::preview(&zst, Provider::Codex).unwrap().messages[0].text,
        "真实提问"
    );
}
#[test]
fn preview_merges_fragments_filters_injection_and_caps_messages() {
    let f = Fixture::new();
    let mut lines = vec![user(
        ID,
        "<local-command-stdout>ignore",
        "2026-11-09T00:00:00Z",
    )];
    for text in ["答案一", "答案二"] {
        lines.push(json!({"type":"assistant","message":{"id":"msg_same","role":"assistant","content":[{"type":"text","text":text}]}}));
    }
    lines.push(user(
        ID,
        "<system-reminder>hidden</system-reminder>真实问题",
        "2026-11-09T00:00:00Z",
    ));
    for i in 0..510 {
        lines.push(user(ID, &format!("line {i}"), "2026-11-09T00:00:00Z"));
    }
    let p = f.claude(ID, &lines);
    let preview = sessions::preview(&p, Provider::Claude).unwrap();
    assert_eq!(preview.messages[0].text, "答案一\n答案二");
    assert_eq!(preview.messages[1].text, "真实问题");
    assert_eq!(preview.messages.len(), 500);
    assert!(preview.truncated);
}
#[test]
fn claude_to_codex_preserves_source_mixed_content_and_registers() {
    let f = Fixture::new();
    let db = f.db();
    fs::write(
        f.roots.codex.join("config.toml"),
        "model = 'configured-codex-model'\n",
    )
    .unwrap();
    let p=f.claude(ID,&[user(ID,"开始","2026-11-09T00:00:00Z"),json!({"type":"assistant","message":{"role":"assistant","model":"claude-model","content":[{"type":"text","text":"准备调用"},{"type":"thinking","thinking":"secret"},{"type":"tool_use","id":"call_1","name":"shell","input":{"cmd":"echo hi"}}]}}),json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"hi"},{"type":"text","text":"继续操作"}]}})]);
    let before = hash(&p);
    let result = convert::convert(&f.roots, &args(Provider::Claude, &p)).unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(before, hash(&p));
    let id = result["newSessionId"].as_str().unwrap();
    assert_ne!(id, ID);
    let (path, model): (String, String) = db
        .query_row(
            "SELECT rollout_path,model FROM threads WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(model, "configured-codex-model");
    let records = storage::history(Path::new(&path)).unwrap();
    let text = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("继续操作"));
    assert!(text.contains("准备调用"));
    assert!(text.contains("function_call_output"));
    assert!(!text.contains("secret"));
    for (i, row) in records.iter().enumerate() {
        assert_eq!(row["ordinal"], i);
    }
    let again = convert::convert(&f.roots, &args(Provider::Claude, &p)).unwrap();
    assert_ne!(again["newSessionId"], result["newSessionId"]);
}
#[test]
fn codex_to_claude_pairs_tools_keeps_orphans_and_builds_parent_chain() {
    let f = Fixture::new();
    let p=f.codex(&[codex_meta(),item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"开始"}]})),item(json!({"type":"function_call","call_id":"a","name":"shell","arguments":"{}"})),item(json!({"type":"function_call","call_id":"b","name":"shell","arguments":"{}"})),item(json!({"type":"function_call_output","call_id":"b","output":"b result"})),item(json!({"type":"function_call_output","call_id":"a","output":"a result"})),item(json!({"type":"function_call_output","call_id":"orphan","output":"保留孤立结果"})),item(json!({"type":"custom_tool_call","call_id":"missing","name":"patch","input":"raw script"})),item(json!({"type":"reasoning","encrypted_content":"secret"}))]);
    let before = hash(&p);
    let result = convert::convert(&f.roots, &args(Provider::Codex, &p)).unwrap();
    assert_eq!(before, hash(&p));
    let id = result["newSessionId"].as_str().unwrap();
    let files = storage::files(&f.roots.claude.join("projects"));
    let path = files
        .iter()
        .find(|p| p.file_name().unwrap().to_string_lossy() == format!("{id}.jsonl"))
        .unwrap();
    let records = storage::history(path).unwrap();
    let mut parent = Value::Null;
    for (i, r) in records
        .iter()
        .enumerate()
        .filter(|(_, r)| r.get("message").is_some())
    {
        assert_eq!(r["parentUuid"], parent);
        parent = r["uuid"].clone();
        if r["type"] == "assistant" {
            assert!(r["message"]["id"].as_str().unwrap().starts_with("msg_"));
            for call in r["message"]["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|b| b["type"] == "tool_use")
            {
                assert!(records[i + 1]["message"]["content"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|o| o["tool_use_id"] == call["id"]));
            }
        }
    }
    let text = fs::read_to_string(path).unwrap();
    assert!(text.contains("保留孤立结果"));
    assert!(text.contains("a result"));
    assert!(text.contains("b result"));
    assert!(!text.contains("secret"));
    assert!(text.ends_with('\n'));
    assert!(!result["warnings"].as_array().unwrap().is_empty());
}
#[test]
fn conversion_rolls_back_copy_when_database_is_locked() {
    let f = Fixture::new();
    let db = f.db();
    let p = f.claude(ID, &[user(ID, "开始", "2026-11-09T00:00:00Z")]);
    let before = hash(&p);
    db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let result = convert::convert(&f.roots, &args(Provider::Claude, &p));
    assert!(result.is_err());
    assert_eq!(before, hash(&p));
    assert!(storage::files(&f.roots.codex.join("sessions")).is_empty());
    db.execute_batch("ROLLBACK").unwrap();
}
#[test]
fn index_without_trailing_newline_and_url_allowlist() {
    let f = Fixture::new();
    let p = f.roots.codex.join("session_index.jsonl");
    fs::write(&p, "{\"id\":\"one\"}").unwrap();
    storage::append(&p, &json!({"id":"two"})).unwrap();
    assert_eq!(storage::history(&p).unwrap().len(), 2);
    assert!(session_manager::release_url(
        "https://github.com/zhangkaixuan01/session-manager/releases/tag/v0.2.0"
    ));
    for url in [
        "file:///C:/Windows",
        "https://github.com.evil.test/zhangkaixuan01/session-manager/releases/latest",
        "https://github.com/other/repo/releases/latest",
        "https://evil@github.com/zhangkaixuan01/session-manager/releases/latest",
    ] {
        assert!(!session_manager::release_url(url));
    }
}
#[test]
fn oversized_decompressed_lines_fail_before_conversion() {
    let f = Fixture::new();
    let p = f.codex(&[codex_meta()]);
    fs::write(&p, "x".repeat(8 * 1024 * 1024 + 1)).unwrap();
    let zst = PathBuf::from(format!("{}.zst", p.display()));
    fs::write(
        &zst,
        zstd::encode_all(fs::read(p).unwrap().as_slice(), 1).unwrap(),
    )
    .unwrap();
    assert!(storage::history(&zst).is_err());
}
#[test]
fn title_refresh_does_not_keep_deleted_index_entries() {
    let f = Fixture::new();
    f.codex(&[
        codex_meta(),
        item(json!({"type":"message","role":"user","content":"原提问"})),
    ]);
    let index = f.roots.codex.join("session_index.jsonl");
    storage::append(
        &index,
        &json!({"id":ID,"thread_name":"自定义","updated_at":"2026-11-09T00:00:00Z"}),
    )
    .unwrap();
    let mut cache = sessions::Cache::default();
    assert_eq!(
        sessions::scan(&f.roots, Provider::Codex, &mut cache, &HashMap::new())[0]
            .title
            .as_deref(),
        Some("自定义")
    );
    fs::write(index, "").unwrap();
    assert_eq!(
        sessions::scan(&f.roots, Provider::Codex, &mut cache, &HashMap::new())[0]
            .title
            .as_deref(),
        Some("原提问")
    );
}

#[test]
fn relative_sqlite_config_and_pending_rename_retry() {
    let f = Fixture::new();
    fs::write(
        f.roots.codex.join("config.toml"),
        "sqlite_home = 'custom-db'\n",
    )
    .unwrap();
    assert!(f
        .roots
        .db_paths()
        .contains(&f.roots.codex.join("custom-db/state_5.sqlite")));
    let p = f.codex(&[
        codex_meta(),
        item(json!({"type":"message","role":"user","content":"hello"})),
    ]);
    let db = f.db();
    db.execute("INSERT INTO threads(id,title,rollout_path,cwd,created_at,updated_at) VALUES (?1,'old',?2,'cwd',1,1)", rusqlite::params![ID,p.to_string_lossy()]).unwrap();
    db.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let mut backend = Backend::new(f.roots.clone());
    let result = backend
        .rename(RenameArgs {
            provider_id: Provider::Codex,
            source_path: p.to_string_lossy().into(),
            session_id: ID.into(),
            new_title: "new".into(),
        })
        .unwrap();
    assert_eq!(result["dbUpdated"], false);
    assert!(!result["warnings"].as_array().unwrap().is_empty());
    db.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        backend.list(Provider::Codex)[0].title.as_deref(),
        Some("new")
    );
    let title: String = db
        .query_row("SELECT title FROM threads WHERE id=?1", [ID], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "new");
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires a desktop recycle bin; run explicitly on Windows"]
fn recycle_bin_roundtrip_restores_session_and_sidecar() {
    let f = Fixture::new();
    let p = f.claude(
        ID,
        &[user(ID, "disposable fixture", "2026-11-09T00:00:00Z")],
    );
    let sidecar = p.with_extension("");
    fs::create_dir_all(&sidecar).unwrap();
    fs::write(sidecar.join("fixture.txt"), "fixture").unwrap();
    let before = hash(&p);
    let mut backend = Backend::new(f.roots.clone());
    let result = backend
        .delete(FileArgs {
            provider_id: Provider::Claude,
            source_path: p.to_string_lossy().into(),
        })
        .unwrap();
    assert_eq!(result["extraTrashed"], 1);
    assert!(!p.exists());
    assert!(!sidecar.exists());
    let items: Vec<_> = trash::os_limited::list()
        .unwrap()
        .into_iter()
        .filter(|item| {
            // Compare paths, not strings with mixed Windows separators.
            item.original_parent.canonicalize().ok() == p.parent().unwrap().canonicalize().ok()
                && (item.name == p.file_name().unwrap()
                    || item.name == sidecar.file_name().unwrap())
        })
        .collect();
    assert_eq!(items.len(), 2);
    trash::os_limited::restore_all(items).unwrap();
    assert_eq!(before, hash(&p));
    assert_eq!(
        fs::read_to_string(sidecar.join("fixture.txt")).unwrap(),
        "fixture"
    );
}
