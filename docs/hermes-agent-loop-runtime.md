# Hermes 受控 Agent Loop 运行配置

钉钉主路径使用独立 `HERMES_HOME`，不能复用个人 Hermes Profile。Hermes 负责理解上下文并选择 `ask_insurance_expert` 或 `ask_sales_champion`；后端负责账号与数据权限、参数校验、调用预算和证据约束。领域 Agent 的权威结果直接交付，不由 Hermes 改写。

## 独立 Profile

独立目录的 `config.yaml` 只保留实际模型提供方配置，并注册名为 `ocr-insurance-domain` 的 stdio MCP，入口为当前代码版本的 `server/hermes-domain-mcp-server.mjs`。钉钉主路径启用 `ocr-insurance-domain,web`：领域 MCP 只暴露上述两个领域工具，`web` 只检索公开网页；终端、文件、浏览器自动化和个人 MCP 不参与客户请求。客户、家庭、保单、身份和健康信息不得进入网页查询，网页结果也不能取代领域工具的权限校验、保险事实核验或证据结论。

开发栈默认使用 `~/.hermes/profiles/insuranceagent`，也可以在启动时显式覆盖这个目录：

```bash
HERMES_OCR_HOME=/absolute/path/to/dedicated-hermes-home npm run local:dev
```

每次领域工具调用都会重新解析钉钉账号并检查资源权限。单次 Hermes 调用默认最长 20 秒；在尚未执行领域工具时，Provider、Session、超时或响应格式失败会用空 Session 重试一次。已经执行领域工具后不会重放请求；权威工具结果一产生就直接交付并终止本轮 CLI，不再等待第二次模型润色。

未配置 `HERMES_OCR_HOME` 时 Agent Loop 关闭并返回“语义服务暂不可用”，不会降级到 Direct 或旧分类器。仅调试旧语义协议时可显式设置 `AGENT_CONVERSATION_RUNTIME=semantic`；`direct` 也只能显式开启。
