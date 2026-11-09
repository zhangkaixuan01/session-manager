<div align="center">

<img src="build/icon@512.png" alt="Session Manager Logo" width="128" height="128" />

# Session Manager

**集中管理 Claude Code 与 Codex 会话**

本地桌面工具 · 会话互转 · 搜索预览 · 重命名 · 安全清理

[![Release](https://img.shields.io/github/v/release/zhangkaixuan01/session-manager)](https://github.com/zhangkaixuan01/session-manager/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Download](https://img.shields.io/badge/download-Windows_x64-blue)

[下载最新版](https://github.com/zhangkaixuan01/session-manager/releases/latest) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/zhangkaixuan01/session-manager/issues)

</div>

> 当前分支 `migration/tauri` 正在迁移至 **Tauri 2 + Rust**，版本为 `0.2.0-alpha.1`。下方正式下载仍为 Electron `v0.1.1`；迁移版从源码启动或从本分支的 Actions 构建产物获取，暂未替换正式 Release。

## 功能

直接读取本机 Claude Code 与 Codex 的会话存档，在一个窗口里整理历史对话。

- ✏️ 重命名会话
- 🔍 按标题搜索，按项目分组
- 👁 本地预览会话内容
- 📋 一键复制恢复命令
- 🔁 Claude Code 与 Codex 会话互转
- 📌 正在运行的 Claude 会话置顶
- 🗑 删除会话并移入回收站

支持亮色与暗色主题。置顶区和其他会话分别按最近活跃时间倒序，Claude 列表每 10 秒刷新运行状态。

## 下载安装

当前版本 **v0.1.1**，提供 Windows x64 安装包，无需另装 Node.js 或 pnpm。

| 版本 | 下载 | 使用方式 |
|---|---|---|
| Windows 便携版 | [session-manager-portable-0.1.1.exe](https://github.com/zhangkaixuan01/session-manager/releases/download/v0.1.1/session-manager-portable-0.1.1.exe) | 双击运行 |
| Windows 安装版 | [session-manager-0.1.1-x64.exe](https://github.com/zhangkaixuan01/session-manager/releases/download/v0.1.1/session-manager-0.1.1-x64.exe) | 按向导安装，可选择目录 |

[SHA-256 校验文件](https://github.com/zhangkaixuan01/session-manager/releases/download/v0.1.1/SHA256SUMS.txt) · [全部版本](https://github.com/zhangkaixuan01/session-manager/releases)

macOS 暂无预编译安装包，可在 Mac 上从源码构建。

## 使用

1. 启动后切换 **Claude Code** 或 **Codex** 标签，查看本机会话。
2. 用搜索框筛选标题，或在左侧选择项目；点击会话预览内容。
3. 鼠标悬停会话，使用重命名、转换、复制命令、打开文件位置或删除按钮。
4. 继续对话时，在对应项目目录的终端中执行复制的恢复命令。

浏览已有存档不要求 CLI 正在运行；恢复对话需要安装并配置对应 CLI。

### 会话互转

点击 ↔ 按钮并确认后，应用生成另一 CLI 格式的新会话，复制恢复命令。原会话保持不变，新标题带 `⟲自Claude` 或 `⟲自Codex` 标记；应用不会自动启动终端。

转换用于延续文本对话和工具历史，存在以下限制：

- `thinking` / `reasoning` 不迁移，图片和其他非文本内容可能无法保留。
- 工具调用作为历史记录保留，不会重新执行；缺失或无法匹配的结果会提示处理情况。
- 系统提示和环境上下文由目标 CLI 重建；超过 64 MiB 读取上限或单行超过 8 MiB 时会停止转换，不生成不完整副本。
- 两个 CLI 的内部会话格式可能变化，不保证兼容所有版本。恢复后应检查历史内容是否符合预期。

### 检查更新

顶栏显示当前应用版本。点击 **检查更新** 会查询本仓库的最新正式 Release；发现新版本时展示更新说明，点击 **前往下载** 打开发布页面。下载后手动安装或替换便携版，不会在后台自动安装。

## 数据与隐私

会话管理在本地完成，不上传会话内容，不内置统计或遥测。检查更新时会请求 GitHub API，下载按钮会在浏览器中打开 GitHub 页面。

默认读取位置如下，`~` 表示当前用户目录：

| CLI | 会话目录 | 自定义根目录 |
|---|---|---|
| Claude Code | `~/.claude/projects` | `CLAUDE_CONFIG_DIR` 环境变量 |
| Codex | `~/.codex/sessions`、`~/.codex/archived_sessions` | `CODEX_HOME` 环境变量 |

自定义环境变量需在启动应用前设置，并由应用进程继承。支持读取 Codex 的 `.jsonl.zst` 压缩存档。

重命名会更新本地标题记录；转换会新建会话并写入目标 CLI 的索引或数据库。Codex 数据库位置支持默认目录、`CODEX_SQLITE_HOME` 和 `config.toml` 的 `sqlite_home`。删除通过系统回收站处理，也会移动对应的关联目录或同名压缩存档。

## 常见问题

**没有发现会话？** 先确认本机已有 CLI 会话存档；如使用自定义目录，检查应用是否继承了对应环境变量，再刷新列表。

**为什么只有 Claude 会话显示运行状态？** 当前仅实现 Claude Code 运行记录检测；Codex 暂不显示运行状态，也不自动置顶。

**改名后 CLI 还显示旧标题？** 重新打开 CLI 的会话列表。若提示 Codex 数据库写入失败，可关闭占用程序后在本应用中刷新，待补写标题。

**转换后无法恢复？** 先查看转换提示，确认目标 CLI 已配置且数据库注册成功。若仍失败，请提交 CLI 版本、转换方向和报错信息到 [Issues](https://github.com/zhangkaixuan01/session-manager/issues)。

## 本地开发

技术栈：Tauri 2、Rust、React、TypeScript、Tailwind CSS。需要 Node.js 24、pnpm 10 和 Rust stable。

Windows 开发环境需要 Visual Studio C++ Build Tools（桌面 C++ 工作负载与 Windows SDK）和 WebView2；macOS 需要 Xcode Command Line Tools。参见 [Tauri 环境准备](https://v2.tauri.app/start/prerequisites/)。最终用户不需要安装 Rust 或 Node.js。Windows 安装程序在系统缺少 WebView2 时会联网安装运行时，因此精简安装包不包含离线 WebView2。

```bash
git clone --branch migration/tauri https://github.com/zhangkaixuan01/session-manager.git
cd session-manager
pnpm install
pnpm dev
```

| 命令 | 用途 |
|---|---|
| `pnpm typecheck` | 检查界面与构建配置类型 |
| `pnpm build` | 构建原生应用，不生成安装包 |
| `pnpm dist:win` | 构建 Windows NSIS 安装包 |
| `pnpm dist:mac` | 在 Mac 上构建当前架构的 DMG 与 app |
| `pnpm check:scan` | 只读扫描本机会话 |
| `pnpm test` | 在临时目录测试扫描、改名、互转及路径校验 |
| `pnpm check:rust` | Rust 静态检查 |
| `pnpm dev:web` | 仅启动界面开发服务器，原生功能需 `pnpm dev` |

前端产物在 `dist/web/`，原生程序在 `src-tauri/target/release/`，安装包在其 `bundle/` 目录。测试使用临时数据，不修改真实 CLI 会话。迁移版以 **Session Manager Preview** 安装，使用独立应用标识、默认安装目录及快捷方式，可与 Electron 版分别安装，但会读取同一套 CLI 存档。

## 发布维护

- **版本**：`package.json` 是桌面应用版本来源，`src-tauri/Cargo.toml` 保持相同版本；发布时更新 `CHANGELOG.md` 和 README 下载链接。
- **地址**：更新检查与下载地址校验在 `src-tauri/src/lib.rs`，打包配置在 `src-tauri/tauri.conf.json`，项目元信息在 `package.json` 与 `src-tauri/Cargo.toml`。
- **发布**：通过类型检查、Rust 测试和构建后，创建对应版本的 Release，上传安装包与 SHA-256 校验文件。迁移测试版使用预发布，不替换正式版；更新检查只提示比当前版本更高的正式 Release。
- **Fork**：发布自己的版本前，同步修改以上仓库地址和 README 链接。

## 许可证

[MIT](LICENSE)
