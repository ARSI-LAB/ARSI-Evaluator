# DocOps 插件使用说明

本目录提供独立的本地 package `@ember-evaluator/docops`，包含 DocOps benchmark 和配套的 `docops-docker` 执行环境。它通过 Evaluator 的公共 API 工作，随根项目构建和发布，由 CLI 和 SDK 默认注册。

## 环境准备

在仓库根目录安装 evaluator 依赖并构建 CLI：

```bash
pnpm install --frozen-lockfile
pnpm build
```

完整评测使用 Docker 环境。运行前确保 Docker daemon 可用，并设置 [Playbook](./playbook/docops.yaml) 中引用的模型环境变量：`MODEL_NAME`、`MODEL_ENDPOINT` 和 `MODEL_API_KEY`。

## 单独开发 DocOps

DocOps 有自己的 `package.json` 和 `pnpm-lock.yaml`，与根项目分开安装和构建：

```bash
pnpm --dir plugins/docops install --ignore-workspace --ignore-scripts --frozen-lockfile
pnpm --dir plugins/docops build
```

安装命令使用 DocOps 自己的锁文件。构建会先做 TypeScript 类型检查，再生成 `plugins/docops/dist/index.js`。从根目录运行 `pnpm build` 也会生成这个入口。

## 运行 Playbook

在仓库根目录启动示例实验：

```bash
ember-evaluator run plugins/docops/playbook/docops.yaml
```

DocOps 注册 `benchmark/docops` 和 `environment/docops-docker`。示例配置默认使用 `icip-cas/DocOps` 的 `main` revision，执行一个 task，并将结果写入 `results/docops/`。可按需修改 [Playbook](./playbook/docops.yaml) 中的 repository、revision、task ID、Docker profile 和输出目录。

框架先准备选中题目的执行镜像和验证镜像，再创建 attempt。两个环境分别以题目 `environment.build_timeout_sec` 为基础时限（缺省 600 秒），乘 `min(本节点有效准备并发, 10)`；默认不设置整轮上限。缺少 DocOps 基础镜像时，在构建任务镜像之前从 GitHub/Git LFS 获取并校验归档；并发请求共享同一标签的下载和加载，取消一个任务不影响仍在等待的任务。已验证的归档保存在 `docops-docker.cacheDir`，任务镜像缓存命中时跳过归档下载和加载。`run.preparation.mode: pipeline` 可使用本地流水线准备。

Ray 节点上的缓存目录和 Docker 可执行文件由节点配置提供，协调端的本机路径不会传到节点。节点需要部署相同版本的 Evaluator，部署方式见[插件开发与加载说明](../../docs/development/plugins.md)。

只需枚举任务并检查 benchmark 数据源时，可加 `--dry-run`：

```bash
ember-evaluator run plugins/docops/playbook/docops.yaml --dry-run
```
