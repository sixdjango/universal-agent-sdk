# 发布

## 发布哪些包

9 个包统一版本号（lockstep），按依赖顺序发布：

| 顺序 | 包 | 说明 |
|---|---|---|
| 1 | `@universal-agent/acp-extension-core` | |
| 2 | `@universal-agent/client` | 内置的 agent adapter（`packages/adapters/*`）打包在它的 `dist/*-acp.js` 里，adapters 本身不单独发布 |
| 3 | `@universal-agent/workflow-contract` | |
| 4 | `@universal-agent/workflow-runtime` | |
| 5 | `@universal-agent/workflow-node` | 命令行 `ua-workflow` |
| 6 | `@universal-agent/workflow-agents` | |
| 7 | `@universal-agent/workflow-ui` | |
| 8 | `@universal-agent/workflow-web` | |
| 9 | `@universal-agent/workflow-server` | 命令行 `universal-agent-workflow` |

## 工具

- `pnpm release:version <x.y.z>`（`scripts/sync-version.mjs`）：把根目录和 9 个包的版本改成同一个。
- `pnpm release:publish`（`scripts/publish-packages.mjs`）：按上表顺序发布。
  - npm 上已有的版本自动跳过，失败后直接重跑即可。
  - 每个包发布时临时把 `workspace:*` 依赖改成本次版本号、去掉只在仓库里用的 devDependencies，发完（包括失败、Ctrl-C）恢复 package.json，不会把仓库改脏。
  - 没有构建产物的包会拒绝发布，先 `pnpm build`。
  - 选项：`--dry-run`（`pnpm release:dry-run`）、`--otp <code>`（2FA 一次性密码）、`--tag <dist-tag>`、`--provenance`（CI 用）、`--pack <目录>`（只打 tarball，用来在别的项目里试装）。

## 首次发布（本地）

npm 的免 key 发布（Trusted Publishing）只能给**已经存在**的包配置，所以新包的第一个版本要在本地发。

```bash
npm login                                   # 有 @universal-agent 组织发布权限的账号
pnpm install
pnpm build && pnpm test

# 可选：打包后在一个空项目里试装
node scripts/publish-packages.mjs --pack /tmp/ua-tarballs
#   cd 一个空目录 && npm init -y && npm install /tmp/ua-tarballs/*.tgz

pnpm release:dry-run                        # 看清每个包会发什么
pnpm release:publish --otp <6 位验证码>       # 账号开了"写操作要 2FA"时带上一次性密码
# 验证码过期导致中途失败（EOTP）时，换一个新验证码重跑同一条命令：已发布的包会自动跳过
```

发完提交版本号并打 tag（tag 触发的 CI 会发现版本都已存在，全部跳过）：

```bash
git commit -am "chore(release): v0.2.0"
git tag v0.2.0 && git push && git push --tags
```

## 关联 GitHub，之后免 key 发布

对每个包（`@universal-agent/client`、`acp-extension-core` 已经配过的可以跳过）在 npmjs.com 上：

1. 打开包页面 → **Settings** → **Trusted Publisher** → **GitHub Actions**。
2. 填写：Organization or user `sixdjango`，Repository `universal-agent-sdk`，Workflow filename `publish.yml`，Environment 留空。
3. 保存。建议同时在 **Publishing access** 里选择"要求 2FA 并禁止使用 token"。

`.github/workflows/publish.yml` 已经按这个方式配置：`id-token: write` 权限、升级到支持 OIDC 的 npm、公开仓库自动带 provenance，用同一个 `scripts/publish-packages.mjs` 按顺序发布。配置好之后可以删掉仓库里的 `NPM_TOKEN` secret（如果有）。

## 之后发版

两种方式，CI 都会：同步版本号 → 构建 → typecheck → 测试全部包 → 按顺序发布（已存在的跳过）。

- **推 tag**：`pnpm release:version 0.3.0`，提交，`git tag v0.3.0 && git push --tags`（版本取自 tag）。
- **手动触发**：GitHub → Actions → *Publish to npm* → Run workflow，可填版本号和 dist-tag（如 `next`、`beta`）。

## 注意

- 发布后 72 小时内可以 `npm unpublish <pkg>@<version>`，之后只能 `npm deprecate`；同一个版本号永远不能再用。
- 0.x 版本按 minor 视为可能不兼容的更新，有破坏性改动时升 minor。
- `acp-extension-core` 有破坏性改动时，按 [UPSTREAM.md](../UPSTREAM.md) 的规则同步升级 adapters 和 client。
