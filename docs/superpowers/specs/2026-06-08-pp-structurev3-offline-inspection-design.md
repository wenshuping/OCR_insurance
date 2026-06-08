# PP-StructureV3 离线保单结构验证 - 设计文档

> 日期: 2026-06-08  
> 范围: 使用 PP-StructureV3 离线验证保单图片的结构化 OCR 能力  
> 不包含: 正式上传流程接入、SQLite 写入、前端改动、外部 API、PP-ChatOCRv4

## 背景

当前项目已经有本地 PaddleOCR 图片识别链路，并能输出 `lines`、`ocrText` 和 `boxes`。现有字段匹配问题主要不在文字是否识别出来，而在保单版面、表格行列、主险和附加险关系是否能被稳定保留。

直接把普通 OCR 文本交给 `qwen3:8b` 一类本地文本模型，不能可靠恢复保单表格结构。文本模型只看到已经打散的文字，容易把保额、缴费期间、保障期间、行保费和合计保费串到错误产品上。

PP-StructureV3 的价值在于先从图片恢复文档结构，包括版面块、表格、阅读顺序、Markdown 和 JSON 结构。第一阶段只做离线验证，判断它是否值得接入正式 OCR 流程。

## 目标

1. 对单张或一组保单图片运行 PP-StructureV3。
2. 完整保留 PP-StructureV3 原始 JSON 和 Markdown 输出。
3. 把原始结果归一化为项目能理解的 `blocks`、`tables`、`policyFields` 和 `plans`。
4. 验证核心字段是否可辨别:
   - 保险公司
   - 产品名称
   - 投保人
   - 被保险人
   - 受益人
   - 主险
   - 附加险，可以多个
   - 每个计划的保额、缴费期间、保障期间、保费
   - 首期保费合计
5. 判断 PP-StructureV3 原始表格是否可用；能用原始表格时优先使用原始表格。
6. 生成可人工复核的报告，不写正式业务数据。

## 非目标

- 不接 `server/` 正式上传接口。
- 不写 SQLite。
- 不改前端。
- 不修改现有 OCR provider 默认值。
- 不修改 `.env.local`、`.runtime/` 或本机生产配置。
- 不调用外部 API。
- 不使用 PP-ChatOCRv4。
- 不使用 `qwen3:8b` 或其他 LLM 参与字段判断。
- 不把离线候选结果自动保存成正式保单。

## 已确认决策

- 第一阶段选择独立离线验证入口，不接正式 OCR 主链路。
- PP-StructureV3 原始表格优先于 Markdown 表格、layout blocks 和全文文本。
- 第一个有效保险产品行就是主险。
- 附加险可以有多个。
- 每个计划的保额、缴费期间、保障期间、保费必须尽量保持同行对应。
- 首期保费合计必须和行保费分开。
- 缺失字段只标记缺失，不跨行乱补。
- 产品名称和保险公司都属于核心验证字段。

## 命令设计

新增离线命令:

```bash
npm run ocr:structurev3:inspect -- ./samples/policy.jpg
```

支持目录输入:

```bash
npm run ocr:structurev3:inspect -- ./samples/policies/
```

命令只读取输入图片并写入离线验证产物。它不启动本地生产，不访问正式数据目录，不调用应用 API。

## 文件布局

实现阶段新增文件:

| 文件 | 职责 |
| --- | --- |
| `scripts/inspect-pp-structurev3.mjs` | Node 入口，解析参数、遍历文件、创建输出目录、调用 Python、生成报告。 |
| `ocr-service/scripts/policy_ocr_structurev3.py` | Python 入口，调用 `PPStructureV3` 并导出原始 JSON / Markdown。 |
| `ocr-service/policy-structurev3-normalizer.mjs` | 把 PP-StructureV3 原始结果转成项目内部结构和字段候选。 |
| `tests/policy-structurev3-normalizer.test.mjs` | 覆盖表格归一化、主险/附加险、合计保费和缺失字段规则。 |

第一阶段不修改 `server/`、`src/`、正式 OCR router 或 SQLite store。

## 输出目录

输出写入项目根目录下的离线验证目录:

```text
.structurev3-inspect/
  2026-06-08-153000-policy/
    input.meta.json
    raw.structurev3.json
    raw.structurev3.md
    normalized.json
    candidates.json
    report.md
```

`input.meta.json` 记录输入和运行环境:

```json
{
  "input": "samples/policy.jpg",
  "ranAt": "2026-06-08T15:30:00+08:00",
  "python": "python3",
  "device": "gpu",
  "useFormulaRecognition": false,
  "useChartRecognition": false
}
```

`raw.structurev3.json` 和 `raw.structurev3.md` 保留 PP-StructureV3 原始输出，用于排查和后续适配。

`normalized.json` 保存归一化结构:

```json
{
  "ocrText": "按阅读顺序拼接的文本",
  "blocks": [
    {
      "type": "title",
      "text": "保险单",
      "bbox": [0, 0, 0, 0],
      "confidence": 0.98
    }
  ],
  "tables": [
    {
      "title": "保险利益表",
      "source": "raw-table",
      "headers": ["险种名称", "保险金额", "保险期间", "交费期间", "保险费"],
      "rows": [
        ["主险名称", "100000", "终身", "20年交", "4334"]
      ]
    }
  ],
  "warnings": []
}
```

`candidates.json` 保存字段候选:

```json
{
  "policyFields": {
    "company": {
      "value": "新华保险",
      "source": "header",
      "evidence": "新华保险"
    },
    "productName": {
      "value": "主险名称",
      "source": "plans[0].name",
      "evidence": "保险利益表第1个有效产品行"
    },
    "firstPremium": {
      "value": "5000",
      "source": "premium-total-row",
      "evidence": "首期保险费合计 5000"
    }
  },
  "plans": [
    {
      "role": "main",
      "name": "主险名称",
      "amount": "100000",
      "paymentPeriod": "20年交",
      "coveragePeriod": "终身",
      "premium": "4334",
      "source": "raw table row 1"
    },
    {
      "role": "rider",
      "name": "附加险名称",
      "amount": "20000",
      "paymentPeriod": "20年交",
      "coveragePeriod": "1年",
      "premium": "666",
      "source": "raw table row 2"
    }
  ],
  "missingFields": [],
  "ambiguousFields": []
}
```

`report.md` 保存人工评估报告。

## 数据来源优先级

字段和计划候选按以下顺序取数:

```text
PP-StructureV3 原始 table cell / table html / table block
  > PP-StructureV3 Markdown 表格
  > layout blocks + OCR lines
  > 普通全文文本候选
```

只要原始表格能稳定解析出表头和行，就必须优先用原始表格。Markdown 和全文文本只作为降级来源。

## 字段规则

### 保险公司

优先从页眉、公司名称、logo 附近文本、标题区识别。若表格或正文重复出现保险公司，只作为辅助证据，不覆盖页眉候选。

### 产品名称

产品名称优先使用主险名称。主险名称来自第一个有效保险产品行。

附加险不能覆盖整张保单的 `productName`。

### 投保人、被保险人、受益人

优先从基础信息区、受益人区域和结构化 blocks 中提取。若只能从全文候选提取，报告中标记来源较弱。

### 计划行

计划输出统一进入 `plans[]`:

```json
{
  "role": "main",
  "name": "产品名称",
  "amount": "保额",
  "paymentPeriod": "缴费期间",
  "coveragePeriod": "保障期间",
  "premium": "本行保费",
  "source": "raw table row 1"
}
```

规则:

- 第一个有效保险产品行是主险。
- 后续含 `附加`、`附加险`、`附加合同`、`附加医疗`、`附加意外` 等关键词的产品行为附加险。
- 后续不含附加关键词但像保险产品的行标记为 `unknown`，报告提示人工确认。
- 合计行、标题行、表头行、空行、说明行不算有效保险产品行。
- 一行缺字段时，只标记该行字段缺失，不从别的行补值。

### 首期保费合计

包含以下语义的行或字段作为整单 `firstPremium` 候选:

```text
首期保险费合计
首期保费合计
保险费合计
合计保费
应交保险费合计
```

这些值进入 `policyFields.firstPremium`，不能作为某个主险或附加险的 `premium`。

每个计划行自己的保费保留在 `plans[].premium`。

## 报告内容

`report.md` 至少包含:

- 输入图片和运行配置。
- PP-StructureV3 是否成功运行。
- 原始表格是否可用。
- 保险公司、产品名称、投保人、被保险人、受益人是否可辨别。
- 识别到了几个计划。
- 哪个计划是主险。
- 哪些计划是附加险。
- 每个计划的 `name / amount / paymentPeriod / coveragePeriod / premium`。
- 首期保费合计是否单独识别。
- 哪些字段来自原始 table，哪些来自 Markdown，哪些只是文本候选。
- 缺失字段和多候选字段。
- 结论: `建议接入正式流程`、`暂不建议接入` 或 `需要更多样本`。

## 错误处理

离线工具失败时只写报告或错误 JSON，不影响正式系统。

错误类型:

| 错误 | 含义 |
| --- | --- |
| `structurev3_import_failed` | 环境不能导入 `PPStructureV3`。 |
| `structurev3_runtime_failed` | 模型运行失败、超时或显存不足。 |
| `no_table_detected` | 没识别出可用表格。 |
| `table_unusable` | 有表格，但行列错乱，无法保持同行字段。 |
| `missing_core_fields` | 核心字段缺失。 |
| `ambiguous_policy_field` | 同一个字段有多个候选。 |
| `ambiguous_plan_role` | 主险之外的计划角色不明确。 |
| `premium_total_conflict` | 首期保费合计和行保费关系冲突。 |

降级策略:

```text
原始表格可用 -> 用 raw table
原始表格不可用 -> 看 Markdown 表格
Markdown 表格不可用 -> 看 layout blocks / OCR lines
还不可用 -> 标记失败，不猜
```

## 验收标准

一张图片算 PP-StructureV3 有价值，需要满足:

- 保险公司、产品名称、投保人、被保险人、受益人大部分可辨别。
- 能识别第一个有效保险产品行为主险。
- 能识别多个附加险，且不丢产品行。
- 每个计划的保额、缴费期间、保障期间、保费能保持同行对应。
- 首期保费合计能和行保费分开。
- 报告能清楚说明每个字段的来源。

批量样本进入第二阶段正式接入前，需要满足:

- 至少 5-10 张真实保单图片离线报告可读。
- 主险/附加险表格行关系明显优于当前普通 OCR 文本。
- 首期保费合计能稳定和行保费分开。
- 失败时能明确标记，不乱猜。
- 不依赖外部 API。
- 运行时间和 4080 12GB 显存可接受。

## 后续接入条件

只有离线验证通过后，才考虑新增正式 OCR provider，例如 `paddle_structurev3_local`。正式接入时仍应沿用现有边界:

```text
图片 -> OCR service -> field evidence / confidence -> server policy mapping -> 人工确认 -> SQLite
```

PP-StructureV3 只能作为结构化 OCR 和字段候选来源，不能绕过现有字段校验、证据链和人工确认。

## 测试策略

第一阶段测试重点放在 normalizer，不需要真实加载大模型:

```bash
node --test tests/policy-structurev3-normalizer.test.mjs
npm run check
```

测试覆盖:

- 原始表格优先于 Markdown 表格。
- 第一个有效保险产品行标记为主险。
- 多个附加险进入 `plans[]`。
- 合计保费进入 `policyFields.firstPremium`，不进入行保费。
- 每行保额、缴费期间、保障期间、保费保持同行关系。
- 缺失字段只标记缺失，不跨行补值。
- 无可用表格时输出明确 warning。

文档和离线脚本本身不需要运行前端 `typecheck` 或 `build`，除非后续实现改动触及 `src/` 或 API 合同。
