/**
 * 全局配置。
 *
 * GitHub 仓库（owner/repo）；Fork 后发布时改为自己的仓库。
 *   「检查更新」会访问 https://api.github.com/repos/<GITHUB_REPO>/releases/latest，
 *   发版时在 GitHub 建 Release 并打 vX.Y.Z 标签、上传 exe 即可被检测到。
 */
export const GITHUB_REPO = 'zhangkaixuan01/session-manager'
