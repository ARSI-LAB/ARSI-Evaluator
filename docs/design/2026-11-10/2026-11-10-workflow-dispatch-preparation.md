# 重试前准备和派发回执

日期：2026-11-10

用户已批准本方案，补充有次数上限的重试及业务输入指纹设计。

WorkflowUnitExecutor 增加可选 prepare(request, context)，只返回 bindings 和可选 nodeId。上下文提供 signal、产物写入和日志。内核等待准备与取消清理完成，重新计算 dispatchFingerprint，校验执行身份，再保存 recoveryIdentity 并调用 execute。prepare 不能修改 runId、计划、题目身份和业务输入指纹。

Benchmark 模板声明 selectionBinding 指向准备步骤输出，Ray 执行器据此替换本次准备回执；用户自定义步骤名称时显式改此绑定。首次派发复用已准备结果，同一次运行中重试题目才重新准备，采用 concurrency=1 的 batch barrier，并保留准备历史。本地和远端使用相同的 prepareRetryTask。重新准备可能改变节点位置，位置和新回执在远端启动前进入恢复记录。没有声明 prepare 的执行器保持原行为。

测试覆盖新回执的派发摘要、先写恢复记录再派发、题目身份篡改被拒绝、成功题目复用、本地重试准备，以及真实 WSL Ray/Jobs 的远端重试。
