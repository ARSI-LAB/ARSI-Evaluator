# 安装与部署

> [English](./installation.md) | 中文

[返回项目主页](../../README.zh-CN.md) · [用户手册](README.zh-CN.md)

## 直接安装

准备好 Evaluator 仓库、Node.js **24.22.1 或更新的 24.x**、pnpm **11 或 12** 和 Git。安装机器需要有 [AgentBundle 私仓](https://github.com/evolving-foundry/agentbundle)的 GitHub 读取权限。

没有 pnpm 时，先运行 `npm install --global pnpm`。然后在 **Evaluator 仓库根目录**执行：

```bash
pnpm install --frozen-lockfile
pnpm add -g .
ember-evaluator --help
```

看到帮助信息即安装成功。依赖和构建会自动完成，无需单独克隆 AgentBundle 或再次执行构建。请保留 Evaluator 目录及其依赖。

顶层 `--help` 列出各命令用途。使用 `ember-evaluator run --help` 查看运行参数，使用 `ember-evaluator cleanup images --help` 查看嵌套命令；各命令的帮助会列出位置参数和选项含义。

更新源码后重新执行 `pnpm install --frozen-lockfile`。使用 WSL 时，安装和运行都在同一个 WSL 环境中完成。

## 安装全局命令

上面的 `pnpm add -g .` 会注册命令。如果提示全局目录未配置或找不到命令，运行：

```bash
pnpm setup
```

按提示重新打开终端，再回到 Evaluator 仓库重试 `pnpm add -g .` 和 `ember-evaluator --help`。

## 在任意目录运行

按[快速上手](quick-start.zh-CN.md)准备评测配置和模型变量，再执行：

```bash
ember-evaluator doctor '/path/to/config.yaml'
ember-evaluator run '/path/to/config.yaml'
```

YAML 中的相对路径以配置文件所在目录为准；`--patch` 建议使用绝对路径。需要 Docker 等额外环境时，按对应[场景指南](README.zh-CN.md)准备。

## 在管理容器中运行（Linux 服务器）

宿主机已有 Docker 时，可以在管理容器内安装和运行，无需在宿主机安装 Node.js 等依赖。步骤见[管理容器指南](deployment/container-toolbox.zh-CN.md)。

## 本机运行时缓存与 Windows 路径长度

运行时依赖会自动缓存。Windows 若出现 `WinError 206`，可指定更短的缓存路径后重试：

```powershell
$env:EVALUATOR_RUNTIME_CACHE_DIR = "D:\ae"
ember-evaluator run "D:\experiments\config.yaml"
```

其他安装或运行问题见[常见问题](faq/README.zh-CN.md)。
