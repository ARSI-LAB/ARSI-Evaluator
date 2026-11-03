# 从 GitHub 自动安装 AgentBundle

- 类型：依赖安装与文档修正
- 状态：实现完成；独立目录安装验证通过，完整回归受已有测试夹具缺失影响

## 目标与实施范围

用户已确认移除同级 AgentBundle 源码目录要求，由 pnpm 自动安装 GitHub 上的依赖。修改前的本地 `link:` 覆盖绕过了 `package.json` 的 Git 依赖，导致缺少同级仓库时无法构建。

1. 将依赖改为 `https://github.com/evolving-foundry/agentbundle.git` 的 `0.0.1` 标签（core 包版本 `0.5.0`），同步更新两份锁文件。
2. 删除本地目录覆盖和管理容器中的 AgentBundle 专用依赖卷，更新 GitHub 访问脚本。
3. 修改中英文安装、部署、SDK 和场景入门说明，删除手动克隆、先构建 core 的步骤。

## 验收标准

- 在不提供同级 AgentBundle 的独立目录中，使用指定 Node.js/pnpm 版本执行冻结锁安装、构建和 CLI 帮助命令。
- 检查安装后的 `agent-bundle-core` 来自 GitHub 锁定提交，能够加载 SDK 并打包运行时。
- 运行相关 AgentBundle 测试、类型检查和默认测试集；记录已有测试夹具缺失等限制。
- 检查文档链接、旧 GitCode 地址和本地 `link:` 安装说明是否清理。

## 实际结果

- 依赖已改为 GitHub `0.0.1` 标签，pnpm 锁文件固定提交 `3034a3ba6292e9b01f1b28799aec90d8e11e106f`，SDK 版本为 `0.5.0`。删除两项同级目录覆盖，允许对应 GitHub 依赖的构建脚本。
- `npm install --package-lock-only --ignore-scripts` 已更新容器锁；构建生成的 npm runtime manifest/lock 继续排除 Git SDK，SDK 仍按既有流程单独复制到运行时。
- 管理容器登录脚本改为 GitHub HTTPS 认证；删除启动脚本中的 AgentBundle 专用依赖卷挂载，保留已有卷数据。中英文安装、部署、SDK、FAQ、快速上手和 README 已删除手动克隆与单独构建 core 的要求。
- 使用 Node.js `24.22.1`、pnpm `11.22.0` 在无同级 AgentBundle 的独立目录执行 `pnpm install --frozen-lockfile`、`pnpm build`、`node dist/cli.js --help`，均通过。SDK 实际入口位于该目录的 `node_modules/agent-bundle-core/dist/index.js`。本仓库冻结锁安装和构建也通过。
- `pnpm typecheck` 未通过：40 条报错均为原有的三个 `tests/fixtures/results/` 文件缺失，并非 SDK 类型不兼容。
- `pnpm test --run`：149 个文件通过、20 个跳过、45 个加载失败；1237 项测试通过、58 项跳过。所有加载失败均由上述夹具缺失引起；包含 AgentBundle SDK 运行时在内的已执行测试没有断言失败。
- 修改文档中的 296 个本地链接目标存在，两个 Shell 脚本的 `bash -n` 和 `git diff --check` 均通过。安装相关文件中已无旧 AgentBundle GitCode 地址、本地 `link:` 覆盖或手动构建 core 的命令。
- 尚未执行真实 Linux 管理容器部署、SSH/令牌交互登录及模型评测。GitHub 仓库当前为私有，首次安装的机器仍需读取权限。
