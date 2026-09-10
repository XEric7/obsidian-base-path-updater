# AGENTS.md

## 发布新版本

- 只有用户明确同意后，才进行 commit、打 tag 和发布。
- 更新 `manifest.json`、`package.json`、`package-lock.json`（顶层及根包）的版本，并在 `versions.json` 添加版本到 `minAppVersion` 的映射。
- 在 `docs/releases/<版本>.md` 写简短发布说明，运行 `npm run check` 和 `npm run format:check`。
- 提交变更，在该 commit 上创建与版本号完全一致的附注 tag（不带 `v`），然后推送 commit 和 tag。例如：

  ```sh
  git commit -m "Release 0.2.1"
  git tag -a 0.2.1 -m "Release 0.2.1"
  git push origin main
  git push origin 0.2.1
  ```

  提交前仅暂存本次已确认的发布文件。

- 推送 tag 会触发 `.github/workflows/release.yml`，自动校验版本、测试、构建并创建 GitHub Release，上传 `main.js`、`manifest.json`、`styles.css`。仅 commit 或本地打 tag 不会触发发布；完成后检查 Actions 和 Release 附件。
