# 发布插件

将版本 tag 推送到 GitHub 后，`.github/workflows/release.yml` 自动运行测试、类型检查、构建及格式检查，为安装文件生成构建来源证明，并创建公开的 GitHub Release、生成发行说明和上传 `main.js`、`manifest.json`、`styles.css`。不需要手动上传附件，也不需要配置个人访问令牌；工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`。

## 发布步骤

以发布 `0.2.0` 为例：

1. 将 `manifest.json` 中的 `version` 更新为 `0.2.0`。
2. 运行 `npm version 0.2.0 --no-git-tag-version`，同步更新 `package.json` 和 `package-lock.json`。
3. 在 `versions.json` 中追加 `"0.2.0": "1.9.0"`，保留已有版本记录；右侧值必须与本次 `manifest.json` 的 `minAppVersion` 一致。
4. 运行 `npm run check` 和 `npm run format:check`，审阅并提交这些修改，确保发布提交包含工作流文件。
5. 在该提交上创建并推送 tag：

```sh
git tag 0.2.0
git push origin 0.2.0
```

tag 必须是与版本文件一致的 `主版本.次版本.修订号`，不带 `v`，暂不发布预览版本。仅在本地创建 tag 不会触发 GitHub Actions。

可在发布提交中提供 `docs/releases/<版本号>.md` 作为发行说明；没有该文件时，GitHub 自动生成发行说明。

## 检查发布结果

在 GitHub 的 Actions 页面查看 **Release plugin**。版本校验、测试、构建、格式检查或证明生成失败时，不会进入发布步骤。工作流不会改写源码中的版本号，也不会覆盖已存在的同名 Release。

成功后，在 Releases 页面确认三个附件均存在，且下载的 `manifest.json` 版本与 tag 一致。需要验证构建来源时，可在下载目录运行：

```sh
gh attestation verify main.js --repo OWNER/REPOSITORY
gh attestation verify manifest.json --repo OWNER/REPOSITORY
gh attestation verify styles.css --repo OWNER/REPOSITORY
```

将 `OWNER/REPOSITORY` 替换为实际仓库。此流程面向公开插件仓库；GitHub 对公开仓库提供产物证明支持，私有仓库需要 GitHub Enterprise Cloud。
