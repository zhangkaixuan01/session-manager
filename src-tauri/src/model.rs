use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn command(self, id: &str) -> String {
        match self {
            Self::Claude => format!("claude --resume {id}"),
            Self::Codex => format!("codex resume {id}"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub provider_id: Provider,
    pub session_id: String,
    pub title: Option<String>,
    pub title_source: String,
    pub summary: Option<String>,
    pub project_dir: Option<String>,
    pub created_at: Option<i64>,
    pub last_active_at: Option<i64>,
    pub source_path: String,
    pub resume_command: String,
    pub archived: bool,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewMessage {
    pub role: String,
    pub ts: Option<i64>,
    pub text: String,
}
#[derive(Debug, Serialize)]
pub struct Preview {
    pub messages: Vec<PreviewMessage>,
    pub truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileArgs {
    pub provider_id: Provider,
    pub source_path: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameArgs {
    pub provider_id: Provider,
    pub source_path: String,
    pub session_id: String,
    pub new_title: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertArgs {
    pub provider_id: Provider,
    pub source_path: String,
    pub session_id: String,
    pub title: Option<String>,
}

pub type Result<T> = std::result::Result<T, String>;
