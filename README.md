<div align="center">

<img src="build/icon@512.png" alt="Session Manager Logo" width="128" height="128" />

# Session Manager

**集中管理 Claude Code 与 Codex 会话**

本地桌面工具 · 会话互转 · 搜索预览 · 重命名 · 安全清理

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Electron](https://img.shields.io/badge/Electron-45-9feaf9?logo=electron&logoColor=white)

</div>

---

## 它解决什么问题

用 Claude Code 或 Codex CLI 干活久了，历史会话会越攒越多——可官方 CLI 至今没有好用的会话管理：标题要么是截断的首句消息，要么是一串目录名，想找回上周那个「修复登录 bug」的会话只能靠肉眼翻。

Session Manager 直接读取 CLI 在本地的会话存档，让你：

- ✏️ 重命名会话
- 🔍 按标题搜索，按项目分组
- 👁 在线预览会话内容
- 📋 一键复制恢复命令
- 🔁 Claude Code 与 Codex 会话互转
- 🗑 删除会话并移入回收站

所有操作只碰你自己电脑上的文件，**不上传任何数据**。

支持亮色 / 暗色模式（顶栏日/月按钮切换，选择自动记住，窗口边框同步跟随）。

## 功能特性

| 特性 | 说明 |
|---|---|
| 双 CLI 支持 | Claude Code（`~/.claude/projects`）与 Codex（`~/.codex/sessions`，含 `.jsonl.zst` 压缩档与归档目录） |
| 重命名标题 | Claude：向会话 JSONL 追加 `custom-title` 行，与官方 `/rename` 完全同一机制；Codex：`session_index.jsonl` 与 `state_5.sqlite` 双写，`codex resume` 立即生效 |
| 标题徽标 | 「已命名」「AI」「首条消息」「目录名」区分标题来源，一眼看出哪些改过名 |
| 运行态检测 | Claude 正在运行的会话显示绿点并置顶，置顶区与其他会话分别按最近活跃时间倒序，每 10 秒刷新状态 |
| 搜索与分组 | 标题即时搜索；左侧按项目目录分组统计 |
| 内容预览 | 只读消息气泡视图（最近 500 条 / 1MB），自动剥离 system-reminder、环境注入等噪音 |
| 跨 CLI 转换 | 悬停会话点击双向箭头，生成带 `⟲自Claude` / `⟲自Codex` 标记的新副本，并复制 `resume` 命令；原会话保持不变 |
| 安全删除 | 移入系统回收站可恢复；自动连带 sidecar 目录与 `.zst`/`.jsonl` 兄弟文件 |
| 检查更新 | 走 GitHub Releases，弹窗展示更新说明，一键跳转下载 |

## 下载安装

安装包发布后，可前往 [Releases](https://github.com/zhangkaixuan01/session-manager/releases) 页面下载：

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows | `session-manager-portable-x.y.z.exe` | 单文件便携版，双击即用 |
| Windows | `session-manager-x.y.z-x64.exe` | NSIS 安装包（简体中文向导） |
| macOS | `session-manager-x.y.z-arm64.dmg` / `-x64.dmg` | Apple Silicon / Intel |

系统要求：Windows 10+ 或 macOS 12+。无需安装任何依赖，CLI（Claude Code / Codex）本身也不必在运行。

## 快速上手

1. 启动后选择 **Claude Code** 或 **Codex** 标签，会话列表自动加载
2. 鼠标悬停任意会话 → 点击 ✏️ 重命名（🟢 绿点表示该会话正在运行，建议先退出再改名）
3. 需要继续对话时点 📋 复制 resume 命令，粘贴到终端即可恢复；点击 ↔️ 可生成另一 CLI 的会话副本
4. 顶栏 ☀/🌙 切换亮暗模式，偏好会被记住

## 工作原理

Session Manager 是**只读优先**的工具：浏览、搜索、预览不写任何文件；只有你明确操作时才增量写入：

| 操作 | 实际行为 |
|---|---|
| 浏览 / 搜索 / 预览 | 纯读取（列表只读文件头尾窗口，大会话也不卡） |
| 重命名 Claude 会话 | 向该会话 JSONL **追加一行** `custom-title`（与官方 `/rename` 同机制，不改任何消息） |
| 重命名 Codex 会话 | 向 `session_index.jsonl` 追加一行 + `UPDATE state_5.sqlite threads.title`（CLI 正在运行锁库时只写索引，稍后自动补写数据库） |
| 删除 | `shell.trashItem` 移入回收站，**永不直接删除** |

重命名写入的是各家 CLI 的官方存储格式，没有私有数据——本工具改名后，CLI 自带的会话列表、`--resume` / `resume` 同样显示新标题；反之亦然。

## 隐私与数据安全

- **本地优先**：所有会话数据留在你的磁盘上，工具不内置任何统计或遥测
- **唯一的网络请求**是「检查更新」按钮主动触发的 GitHub API 查询（`releases/latest`，只传仓库名），不点不联网
- 渲染进程运行在 sandbox + contextIsolation 下；所有文件操作经过主进程白名单校验（路径必须在 `~/.claude` / `~/.codex` 会话根内，且与 sessionId 核对）
- 不会读取或触碰 `~/.codex/config.toml` 等配置文件中的凭据

## 常见问题

**重命名后 `claude --resume` 列表里没显示新名？**
需要重新打开会话选择列表（CLI 有缓存）；`codex resume` 优先读 sqlite，本工具已双写，正常即时生效。

**会话正在运行时能改名吗？**
可以，但 CLI 退出时可能追加新内容；界面会提示，建议先退出该会话。

**Codex 会话为什么没有绿点？**
Codex CLI 的运行锁文件不含 PID 且存在过期残留，无法可靠判断运行态，暂不显示。

**删除会误伤吗？**
删除先进系统回收站（可随时还原），且会连带清理同一会话的压缩档/兄弟文件，防止残留复活。

**徽标「AI」和「已命名」什么区别？**
「已命名」= 你手动命的名（custom-title）；「AI」= CLI 自动生成的标题；「首条消息」/「目录名」= 兜底显示。

**跨 CLI 转换会保留什么？**
用户消息、assistant 文本以及工具调用和结果会按目标 CLI 的原生格式重建；转换生成全新 sessionId，原文件不改。转换后需要在终端执行提示中的 `claude --resume <id>` 或 `codex resume <id>`。

**跨 CLI 转换有哪些有损项？**
Claude 的 `thinking`、Codex 的 `reasoning`/加密内容不能跨 CLI 搬运，会被丢弃；Codex 的明文 `compacted.replacement_history` 会保留。系统提示和环境注入由目标 CLI 重新生成，工具调用只作为历史上下文回放，不会再次执行。

**转换失败或目标 CLI 找不到副本怎么办？**
先确认目标 CLI 已退出并重试。Codex 需要同时把 rollout 注册到 `state_5.sqlite`；如果数据库被锁，界面会提示稍后重试。官方会话格式可能随 CLI 大版本变化，升级后应重新运行 `pnpm check:convert`。

## 参与开发

技术栈：Electron 45 + electron-vite 6 + React 19 + Tailwind 4 + TypeScript。SQLite 用 Node 内置 `node:sqlite`，zstd 用纯 JS 的 `fzstd`——**零原生模块**，clone 即用。

```bash
pnpm install          # .npmrc 已配置 electron 国内镜像
pnpm dev              # 启动开发窗口
pnpm typecheck        # 类型检查
pnpm check:scan       # 只读扫描本机会话，核对数量与标题（不改任何文件）
pnpm check:rename     # 真机重命名验证：最旧会话改名 → 核对 → 改回
```

### 打包

```bash
pnpm dist:win         # Windows：portable + NSIS 安装包（产物在 dist/）
pnpm dist:mac         # macOS：arm64 + x64 双架构 dmg（需在 mac 机器上执行）
```

### 发布新版本

1. 修改 `package.json` 的 `version`，执行 `pnpm dist:win`
2. 在 GitHub 创建 Release（标签 `vX.Y.Z`），把 `dist/` 产物作为附件上传——Release 说明会直接展示在老用户的更新弹窗里
3. 应用已通过 `src/shared/config.ts` 指向本仓库的 Releases；Fork 后发布时需改为自己的仓库地址

> 检查更新只放行 `github.com` 域名链接；未配置仓库或网络不通时给出提示，不影响其他功能。

## License

[MIT](LICENSE) 开源协议，可自由使用、修改与分发。
