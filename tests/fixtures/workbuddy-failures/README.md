# WorkBuddy 提交验证失败夹具

原始 verifier 来自 WorkBuddy Code 数据集 revision `3e8ad839685c589d83a1dd60fe2d15eabb75f27a`，文件未修改：

- data_reporting-hard-invoice_line_export：SHA256 `70296239815be0a978ffcec740bc719a84ca41cd08fe7db29194104487a751b1`。
- data_reporting-medium-customer_health_export：SHA256 `5683641b78d1383bc6a0fee07848e922b7e5b89f7f0c3b7fdbe45099ad3e4e75`。

数据集：[Tencent/workbuddy-bench](https://huggingface.co/datasets/tencent/workbuddy-bench/tree/3e8ad839685c589d83a1dd60fe2d15eabb75f27a)。原始项目：[Tencent/workbuddy-bench](https://github.com/Tencent/workbuddy-bench/tree/625b2233093ae4f23e76be28c1f341d41cc70373)。原始 verifier 沿用上游 WorkBuddy Bench 许可，完整条款见本目录 [LICENSE](LICENSE)；该许可不是标准 Apache-2.0。

CSV 从 2026-10-30 两次原始 agent.patch 中的 export.csv 新增行恢复，保留 BOM，行分隔归一为 LF；error.txt 是对应原生 traceback，不含认证或宿主路径。测试夹具不参与 solver 输入。
