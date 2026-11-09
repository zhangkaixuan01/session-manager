pub mod convert;
pub mod db;
pub mod model;
pub mod sessions;
pub mod storage;

use model::{ConvertArgs, FileArgs, Preview, Provider, RenameArgs, Result, Session};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

pub struct Backend {
    pub roots: storage::Roots,
    pub cache: sessions::Cache,
    pub overrides: HashMap<String, (String, bool)>,
}
impl Backend {
    pub fn new(roots: storage::Roots) -> Self {
        Self {
            roots,
            cache: Default::default(),
            overrides: HashMap::new(),
        }
    }
    pub fn list(&mut self, provider: Provider) -> Vec<Session> {
        if provider == Provider::Codex {
            for (id, (title, pending)) in &mut self.overrides {
                if *pending && db::rename(&self.roots, id, title) {
                    *pending = false;
                }
            }
        }
        sessions::scan(&self.roots, provider, &mut self.cache, &self.overrides)
    }
    pub fn rename(&mut self, args: RenameArgs) -> Result<Value> {
        let title = args.new_title.trim();
        if title.is_empty() || title.len() > 512 || title.chars().any(char::is_control) {
            return Err("标题应为 1–512 字节，不能包含换行或控制字符".into());
        }
        let path =
            self.roots
                .verify(args.provider_id, &args.source_path, Some(&args.session_id))?;
        let mut warnings = vec![];
        let mut updated = false;
        if args.provider_id == Provider::Claude {
            storage::append(
                &path,
                &json!({"type":"custom-title","customTitle":title,"sessionId":args.session_id}),
            )?;
            if sessions::live(&self.roots).contains(&args.session_id) {
                warnings.push(
                    "会话正在运行，CLI 后续保存可能覆盖标题；如被覆盖，可结束后再次重命名"
                        .to_owned(),
                );
            }
        } else {
            storage::append(
                &self.roots.codex.join("session_index.jsonl"),
                &json!({"id":args.session_id,"thread_name":title,"updated_at":storage::iso(None)}),
            )?;
            updated = db::rename(&self.roots, &args.session_id, title);
            self.overrides
                .insert(args.session_id, (title.into(), !updated));
            if !updated {
                warnings.push("标题索引已保存，数据库暂未更新；刷新列表时会重试".into());
            }
        }
        self.cache.invalidate();
        Ok(json!({"ok":true,"warnings":warnings,"dbUpdated":updated}))
    }
    pub fn delete(&mut self, args: FileArgs) -> Result<Value> {
        let path = self
            .roots
            .verify(args.provider_id, &args.source_path, None)?;
        let extra = if args.provider_id == Provider::Claude
            || path.extension().is_some_and(|x| x == "zst")
        {
            path.with_extension("")
        } else {
            std::path::PathBuf::from(format!("{}.zst", path.display()))
        };
        let mut paths = vec![path];
        if extra.exists() {
            let resolved = fs::canonicalize(&extra).map_err(|e| e.to_string())?;
            if !self
                .roots
                .session_roots(args.provider_id)
                .iter()
                .any(|r| fs::canonicalize(r).is_ok_and(|r| resolved.starts_with(r)))
            {
                return Err("关联文件路径超出允许范围".into());
            }
            paths.push(extra);
        }
        // Never fall back to permanent deletion if recycle-bin operations fail.
        trash::delete_all(&paths)
            .map_err(|e| format!("移入回收站失败（部分文件可能已移动），请刷新列表：{e}"))?;
        self.cache.invalidate();
        Ok(json!({"ok":true,"extraTrashed":paths.len()-1}))
    }
}
type Shared = Arc<Mutex<Backend>>;
async fn background<T: Send + 'static>(
    state: &State<'_, Shared>,
    task: impl FnOnce(&mut Backend) -> Result<T> + Send + 'static,
) -> Result<T> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut b = state.lock().map_err(|_| "后台状态异常")?;
        task(&mut b)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn list_sessions(state: State<'_, Shared>, provider_id: Provider) -> Result<Vec<Session>> {
    background(&state, move |b| Ok(b.list(provider_id))).await
}
#[tauri::command]
async fn rename_session(state: State<'_, Shared>, args: RenameArgs) -> Result<Value> {
    background(&state, move |b| b.rename(args)).await
}
#[tauri::command]
async fn delete_session(state: State<'_, Shared>, args: FileArgs) -> Result<Value> {
    background(&state, move |b| b.delete(args)).await
}
#[tauri::command]
async fn preview_session(state: State<'_, Shared>, args: FileArgs) -> Result<Preview> {
    background(&state, move |b| {
        let p = b.roots.verify(args.provider_id, &args.source_path, None)?;
        sessions::preview(&p, args.provider_id)
    })
    .await
}
#[tauri::command]
async fn convert_session(state: State<'_, Shared>, args: ConvertArgs) -> Result<Value> {
    background(&state, move |b| {
        let result = convert::convert(&b.roots, &args)?;
        b.cache.invalidate();
        Ok(result)
    })
    .await
}
#[tauri::command]
async fn reveal_path(app: tauri::AppHandle, state: State<'_, Shared>, path: String) -> Result<()> {
    let verified = background(&state, move |b| {
        b.roots
            .verify(Provider::Claude, &path, None)
            .or_else(|_| b.roots.verify(Provider::Codex, &path, None))
    })
    .await?;
    app.opener()
        .reveal_item_in_dir(verified)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_theme(window: tauri::WebviewWindow, theme: String) -> Result<()> {
    window
        .set_theme(Some(match theme.as_str() {
            "light" => tauri::Theme::Light,
            "dark" => tauri::Theme::Dark,
            _ => return Err("无效主题".into()),
        }))
        .map_err(|e| e.to_string())
}
pub fn release_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some("github.com")
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
            && u.path()
                .starts_with("/zhangkaixuan01/session-manager/releases/")
    })
}
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<()> {
    if !release_url(&url) {
        return Err("仅允许打开本项目的 GitHub Release 地址".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn app_info(app: tauri::AppHandle) -> Value {
    json!({"version":app.package_info().version.to_string()})
}
#[tauri::command]
async fn check_updates(app: tauri::AppHandle) -> Result<Value> {
    let current = app.package_info().version.to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(format!("session-manager/{current}"))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get("https://api.github.com/repos/zhangkaixuan01/session-manager/releases/latest")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("无法检查更新：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub 更新接口返回 {}", response.status()));
    }
    let release: Value = response.json().await.map_err(|e| e.to_string())?;
    let tag = release["tag_name"]
        .as_str()
        .ok_or("Release 缺少版本号")?
        .trim_start_matches('v');
    let latest = semver::Version::parse(tag).map_err(|e| e.to_string())?;
    let installed = semver::Version::parse(&current).map_err(|e| e.to_string())?;
    let url = release["html_url"]
        .as_str()
        .filter(|u| release_url(u))
        .ok_or("Release 地址无效")?;
    Ok(
        json!({"currentVersion":current,"latestVersion":tag,"hasUpdate":latest>installed,"releaseUrl":url,"notes":release["body"].as_str().unwrap_or_default().chars().take(4000).collect::<String>()}),
    )
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let roots = storage::Roots::discover().map_err(std::io::Error::other)?;
            app.manage(Arc::new(Mutex::new(Backend::new(roots))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            rename_session,
            delete_session,
            preview_session,
            convert_session,
            reveal_path,
            set_theme,
            open_external,
            app_info,
            check_updates
        ])
        .run(tauri::generate_context!())
        .expect("无法启动 Session Manager");
}
