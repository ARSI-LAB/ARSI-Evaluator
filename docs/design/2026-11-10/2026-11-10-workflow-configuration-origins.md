# 工作流诊断的配置来源

日期：2026-11-10

状态：用户已明确同意增加运行时配置来源信息。补充[网络资源设计](2026-11-10-workflow-network-resource.md)。

## 问题

network.runtime 正确保存未展开模板，但没有保留本次读入的文件位置。doctor 因而把 template 当作文件名，并推测实验名为 workflow.yaml，生成不可直接运行的修复命令。

## 实现

- 应用配置读取返回独立的 origins：实际实验文件、可选 patch 文件以及按资源绑定名记录的网络文件。
- WorkflowContext.runtime 可携带这份本进程诊断信息；资源创建上下文提供可选 binding 名，网络提供者据此设置客户端的 origin。
- origins 不加入 WorkflowPlan、指纹、持久化资源身份或 WorkflowUnitRequest。执行节点重新建立自己的运行时，不接收提交端路径。
- Benchmark 诊断使用真实配置来源生成命令；路径解析使用 runtime.resolvePath，不能用诊断文件位置替代执行路径。
- 显式内联网络资源没有独立网络文件，命令不添加 --network。Jobs 无本机文件来源时返回空的具体命令并提示使用提交端原命令，不生成虚构路径。

## 验证

检查本地 doctor 的实际文件及 patch 参数、相同网络内容换文件后指纹不变、计划不包含来源路径、无来源的维护提示，以及现有网络、预热和 Jobs 行为。
