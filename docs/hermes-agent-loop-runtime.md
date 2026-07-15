# Hermes 语义运行配置

钉钉主路径使用独立 `HERMES_HOME`，不能复用个人 Hermes Profile。Hermes 每轮只做一次语义解析，输出受控意图、原文实体和上下文引用；保险与销售专业任务随后由运营策略路由到保险专家或销冠，领域 Agent 的结果直接交付给客户，不再由 Hermes 重新组织。

## 独立 Profile

独立目录的 `config.yaml` 只需保留实际模型提供方配置。默认语义路径以单轮、无工具模式调用 Hermes，因此个人 Profile 中的终端、文件、网页或其他 MCP 工具不会参与客户请求。

启动 API 时显式传入这个目录：

```bash
HERMES_OCR_HOME=/absolute/path/to/dedicated-hermes-home npm run local:dev
```

运行时先解析上下文中的产品或家庭，再由后端运营策略选择保险专家、销冠或系统处理器；领域执行仍会重新解析账号并检查资源权限。

旧的受控 Agent Loop 仅保留为测试或显式注入的兼容能力，不再由 `HERMES_OCR_HOME` 自动启用。如果未配置 `HERMES_OCR_HOME`，系统使用现有 Direct 安全降级路径。
