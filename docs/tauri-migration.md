# Tauri 迁移验证

分支：`migration/tauri`；预览版：`0.2.0-alpha.1`。正式发布 `v0.1.1` 保持不变。

## 实现范围

React 界面继续复用，Electron 主进程、preload、Node SQLite 和 zstd 依赖已替换为 Rust 后台。应用运行不需要 Node.js；Windows 使用系统 WebView2，安装器在缺少运行时时联网安装。

后台包括 Claude / Codex 扫描与缓存、运行会话置顶、标题合并与改名、压缩存档预览、双向转换、回收站清理、剪贴板、文件定位、主题、单实例和 GitHub 正式版更新检查。

预览版使用独立标识 `com.las.session-manager.tauri`，产品名 `Session Manager Preview`，避免默认安装目录和快捷方式与 Electron 版混用。两版仍访问相同的 CLI 存档。

## 自动验证

- `pnpm typecheck`、`pnpm build:web`：前端类型与构建。
- `pnpm check:rust`：全部 Rust target 静态检查，无警告。
- `pnpm test`：11 项临时目录隔离测试，覆盖标题优先级、运行会话排序、缓存刷新、索引与 SQLite 同步、锁库重试、路径与 ID 校验、预览限制、压缩数据、双向转换、工具配对、原文件哈希及失败回滚。
- Windows 回收站往返测试：`cargo test --manifest-path src-tauri/Cargo.toml --test sessions recycle_bin_roundtrip -- --ignored`，只操作测试创建的临时会话与关联目录，恢复后核验内容；普通 CI 默认跳过。
- `pnpm check:scan`：只读扫描真实本地存档，已识别 Claude / Codex 会话和运行状态。
- `.github/workflows/tauri.yml`：Windows / macOS 检查与安装包构建，产物保存在 Actions，不自动发布 Release。

## 人工验收

界面由项目维护者检查，本次未运行 UI 自动化。建议在预览版依次检查：列表与搜索、预览、复制恢复命令、主题、文件定位、检查更新。使用可丢弃的测试会话检查改名、互转后的 CLI 恢复、删除与回收站还原。

双向转换保留文本与工具历史，不能保证兼容未来所有 CLI 内部格式；图片、思考记录和不支持的事件会提示略过。源文件不修改，单行超过 8 MiB 或总读取超过 64 MiB 时拒绝转换。Codex 存在数据库但注册失败时撤销新副本；未发现数据库时保留副本并提示恢复可能需要 CLI 建立索引。

## 本机启动

安装 Rust 后需要重新打开终端，让 `cargo` 进入 PATH。在项目目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dist:win` 生成 `src-tauri/target/release/bundle/nsis/` 下的安装包。`src-tauri/target/release/session-manager.exe` 可在已有 WebView2 的 Windows 上直接运行。Mac 安装包需在 macOS 构建；正式发布前完成对应平台人工验收。
