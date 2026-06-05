# 保单基本信息坐标版 OCR — 设计文档

> 日期: 2026-06-05  
> 范围: 拍照保单的基本信息页字段定位、整页轻微歪斜校正、附加险区域防误匹配  
> 不包含: 生产环境配置修改、4080 Windows 服务接入、复杂透视/裁切/反光修复

## 背景

当前保单 OCR 识别文字本身已经基本可用，主要问题是拍照后的二维版面语义丢失。用户看到的是“标签和值在同一行、右侧、下方、同一块区域”，但现有保单基础字段主流程仍主要基于 `ocrText` 和 `lines` 做文本规则匹配。这样在照片整体歪斜、OCR 行顺序不稳定、基本信息区和保险利益表/附加险表同时出现日期、金额、产品名时，字段容易串到错误区域。

项目里已经有可复用基础:

- `ocr-service/scripts/policy_ocr_paddle.py` 的普通 PaddleOCR 路径可以输出 `boxes`。
- `ocr-service/cash-value-parser.mjs` 已经用 boxes 做现金价值表的行聚类和列语义解析。
- `ocr-service/insurance-field-matcher.mjs` 和 `insurance-field-rules.mjs` 已经有文本字段候选、噪声过滤、产品名和险种表解析逻辑。

本设计把现金价值表中“按坐标读表”的思路扩展到保单基本信息页，但保持第一版范围可控。

## 目标

1. 对整页完整但轻微歪斜的拍照保单，先进行方向/歪斜校正或记录校正状态，再做 OCR boxes 解析。
2. 把 OCR boxes 分成可信区域，至少区分 `header`、`basic-info`、`benefit-table`、`rider-table`、`footer`。
3. 基本信息字段优先从 `basic-info` 和必要的 `header` 区域抽取，避免从保险利益表或附加险表误取。
4. 第一版尝试识别基本信息页全字段: 保险公司、产品名、投保人、被保险人、保单号、生效日、受益人、证件号、生日。
5. 坐标解析失败时不中断录入，继续回退现有文本规则，并把低置信或冲突字段提示用户确认。

## 非目标

- 不在第一版处理明显透视变形、页面严重裁切、强反光、严重模糊。
- 不让 PaddleOCR-VL 或 4080 Windows 视觉模型直接成为主链路。
- 不重构现有 OCR 服务路由、上传流程、保险责任生成流程。
- 不把保险利益表和附加险表的完整计划解析一次性重写。第一版只保证它们不会覆盖基础字段，并保留现有 `plans` 解析作为主流程。
- 不修改 `.env.local`、`.runtime/` 或本机生产 OCR 配置。

## 已确认决策

- 首个页面类型: 基本信息页。
- 首个拍照问题: 整页完整但整体歪斜。
- 失败表现: 继续旧流程，同时标记低置信字段让用户确认。
- 第一版字段范围: 基本信息页全字段都尝试，但分置信优先级。
- 架构方向: 图像校正 + 坐标字段解析 + 旧文本规则兜底。

## 架构

整体流程:

```text
拍照图片
  ↓
整页歪斜检测 / 旋转校正
  ↓
PaddleOCR 普通 OCR，保留 boxes
  ↓
版面分区
  - header
  - basic-info
  - benefit-table
  - rider-table
  - footer
  ↓
basic-info 坐标字段解析
  ↓
和现有文本规则结果合并
  ↓
低置信字段提示人工确认，失败回退旧流程
```

新增模块建议放在 `ocr-service/`:

| 模块 | 职责 |
| --- | --- |
| `policy-image-preprocessor.mjs` | 判断整页方向和轻微歪斜，输出校正状态。第一版可以只做可验证的旋转/方向状态，不强制做复杂透视变换。 |
| `policy-layout-regions.mjs` | 基于 boxes 的位置、关键词和行聚类，把文本项分到 header/basic-info/benefit-table/rider-table/footer。 |
| `policy-basic-info-layout-parser.mjs` | 只从 header/basic-info 区域提取基础字段候选。 |
| `policy-field-confidence.mjs` | 给字段来源、置信度、冲突和 review 状态打标。 |

这些模块只服务保单 OCR，不进入 `server/` 或 React 组件。

## 中间数据结构

OCR 坐标项:

```js
{
  text: "投保人",
  box: [120, 420, 190, 450],
  confidence: 0.96
}
```

分区结果:

```js
{
  regions: {
    header: [{ text, box, confidence }],
    basicInfo: [{ text, box, confidence }],
    benefitTable: [{ text, box, confidence }],
    riderTable: [{ text, box, confidence }],
    footer: [{ text, box, confidence }]
  },
  regionWarnings: []
}
```

字段解析结果:

```js
{
  fields: {
    company: "新华保险",
    name: "盛世荣耀臻享版终身寿险（分红型）",
    applicant: "张三",
    insured: "李四",
    policyNumber: "990123456789",
    effectiveDate: "2025-12-23",
    beneficiary: "法定",
    insuredIdNumber: "330106198712072413",
    insuredBirthday: "1987-12-07"
  },
  evidence: {
    applicant: {
      value: "张三",
      source: "basic-info-layout",
      confidence: 0.91,
      labelBox: [120, 420, 190, 450],
      valueBox: [260, 420, 330, 450],
      region: "basic-info"
    }
  },
  warnings: [
    {
      field: "name",
      reason: "主险和附加险均出现产品名，已优先选择基本信息区或主险候选"
    }
  ]
}
```

前端可消费的简化状态:

```js
{
  fieldConfidence: {
    applicant: "high",
    insured: "high",
    name: "review",
    insuredBirthday: "review"
  },
  ocrWarnings: [
    "产品名称识别到多个候选，请确认是否为主险名称"
  ]
}
```

如果短期不方便扩展 API 合同，第一版可以先在 OCR 服务内部使用完整 evidence，并只把 warnings 以兼容字段返回。实现计划需要再确认当前 API 类型可接受的最小扩展方式。

## 图像校正策略

第一版只覆盖“整页完整但整体歪斜”:

1. 优先依赖 PaddleOCR 已启用的 `use_doc_orientation_classify`、`use_doc_unwarping`、`use_textline_orientation`。
2. 如果 OCR boxes 足够多，基于文本框中心线估算整体倾斜角，记录 `skewAngle` 和 `deskewApplied`。
3. 倾斜角在可控范围内时进入坐标解析；超过阈值时不强行相信坐标结果，继续旧文本规则并返回 review warning。
4. 第一版不实现复杂透视四角裁切。明显梯形、缺边、反光属于后续增强。

验收重点不是“把所有图片修正到完美”，而是避免在明显不可靠时继续用错误坐标做强匹配。

## 区域分割规则

区域分割按行聚类和关键词边界共同决定:

- `header`: 页面上方的保司 logo、公司名、文档标题、合同标题。
- `basic-info`: 出现投保人、被保险人、保单号、合同号、生效日期、证件号码、受益人等标签的一组邻近区域。
- `benefit-table`: 出现保险利益表、险种名称、保险金额、保险期间、交费方式、交费期间、保险费等表头后形成的区域。
- `rider-table`: benefit table 内被识别为附加险、附加责任、附加医疗、附加意外等计划的行或块。
- `footer`: 特别约定、保险单说明、保单制作日期、保险公司签章、业务员、页码等区域。

基础字段默认只允许来源:

| 字段 | 允许区域 |
| --- | --- |
| 保险公司 | header、basic-info |
| 产品名 | header、basic-info；必要时可读取 benefit-table 的主险候选 |
| 投保人 | basic-info |
| 被保险人 | basic-info |
| 保单号/合同号 | basic-info、header |
| 生效日 | basic-info |
| 受益人 | basic-info |
| 证件号/生日 | basic-info |

禁止规则:

- `benefit-table` 和 `rider-table` 不得覆盖投保人、被保险人、保单号、生效日、证件号、生日、受益人。
- 附加险产品名不得覆盖 `policy.name`，只能进入 `plans` 或作为 review warning。
- 金额和日期如果来自险种表，默认只作为计划字段候选，不作为整张保单基础字段。

## 字段匹配规则

坐标字段解析以 label 为起点:

1. 先用现有 label aliases 和 fuzzy label matching 找标签。
2. 对每个标签寻找候选值:
   - 同一行右侧最近值: 高分。
   - 同列或近似同列下方最近值: 中高分。
   - 标签后带冒号的同框文本: 高分。
   - 跨距离过大、跨区域、落在表格区: 降分或拒绝。
3. 对候选值做字段类型校验:
   - 姓名: 中文姓名长度和噪声过滤。
   - 保单号: 排除身份证号、手机号、页码。
   - 日期: 格式化为现有 `date` 风格。
   - 证件号和生日: 身份证号解析生日，生日字段可由证件号派生。
   - 产品名: 保司/文档标题/附加险噪声过滤。

产品名特殊处理:

- 优先取基本信息区或标题区里的产品名称/合同名称。
- 如果基本信息区没有产品名，可以参考保险利益表主险行。
- 主险判断优先依据行顺序、非附加险关键词、产品完整度。
- 附加险只能进入 plans，不覆盖整单 `name`。

## 合并策略

合并来源按可靠性排序:

```text
高置信坐标基础字段
  > 高置信 inline/labeled 文本字段
  > 现有保险字段 matcher 候选
  > 旧 fallback 规则
```

但有硬约束:

- 基础字段禁止被 benefit-table/rider-table 来源覆盖。
- 坐标来源低置信时不能强行覆盖文本来源。
- 坐标和文本冲突时，保留更可靠来源，并返回 warning。
- 如果坐标解析失败，完整保留旧流程结果。

字段置信状态:

| 状态 | 含义 |
| --- | --- |
| `high` | 来源区域正确、标签和值空间关系清晰、值类型校验通过。 |
| `review` | 候选冲突、来源距离偏远、来自主险表兜底、或 OCR 置信度较低。 |
| `missing` | 未识别到该字段。 |

## 前端提示

第一版只做轻量提示，不新增复杂审核页面。

在 OCR 完成后的保单确认页显示:

```text
OCR 已完成，部分字段建议确认:
- 产品名称: 识别到主险和附加险候选，已优先选择主险
- 被保险人生日: 来源区域不明确，请核对
```

如果 API 合同暂时不扩展，也可以先把 warnings 合并进已有扫描消息或调试字段；最终实现计划需要选择最小兼容方式。

## 错误处理

- 图片缺失或 OCR 完全无结果: 保持现有错误行为。
- boxes 缺失: 跳过坐标解析，走旧文本规则。
- 分区失败: 走旧文本规则，并返回 review warning。
- 倾斜角过大: 不使用坐标强匹配，走旧文本规则并提示重拍或确认。
- 坐标结果和文本结果冲突: 保留高置信来源，返回 warning，不静默覆盖。

## 测试策略

新增 focused tests，优先放在 `tests/insurance-field-matcher.test.mjs` 或新建 OCR layout parser 测试文件。

必测场景:

1. 整页轻微歪斜但 boxes 可聚行时，能从 basic-info 区域取投保人、被保险人、保单号、生效日。
2. 基本信息区和附加险表同时出现姓名、日期、金额时，基础字段不从 rider-table/benefit-table 取值。
3. 险种表里有主险和附加险时，`policy.name` 不被附加险覆盖，附加险只进入 plans 或 warning。
4. boxes 缺失或分区失败时，旧文本规则仍能产出字段。
5. 坐标规则和文本规则冲突时，返回 warning，不静默覆盖。
6. 证件号能派生生日，但证件号不被误认为保单号。

验证命令按项目规则:

- OCR 代码变更: `npm run check` 和 `npm test`。
- 如果 API 合同或前端提示也变更: 追加 `npm run typecheck` 和 `npm run build`。

## 分阶段落地

### Phase 1: 纯坐标 parser

- 复用 PaddleOCR boxes。
- 新增区域分割和 basic-info parser。
- 不改变 OCR 服务外部行为，先用单元测试验证字段候选和 warnings。

### Phase 2: 接入保单 OCR 主流程

- 在 `scanInsurancePolicyLocal()` 的 PaddleOCR 路径中保留 boxes。
- 坐标结果与 `extractPolicyFieldsFromText()` 结果合并。
- 坐标失败自动回退旧流程。

### Phase 3: 前端低置信提示

- 根据 API 最小扩展方式展示 warnings。
- 不要求用户额外操作才能保存，但提示需要核对的字段。

### Phase 4: 后续增强

- 接入 4080 Windows 或 PaddleOCR-VL 作为低置信复核服务。
- 增加透视变形、裁切、反光等图片质量检测。
- 将保险利益表和附加险 plans 做成完整坐标表格解析。

## 成功标准

第一版成功标准:

- 歪斜但完整的基本信息页，不再主要依赖 OCR 文本顺序猜字段。
- 基础字段明显减少串到保险利益表或附加险表的情况。
- 附加险候选不会覆盖整张保单的核心字段。
- 坐标解析不可靠时，旧流程仍可继续工作。
- 用户能看到哪些字段需要确认，而不是系统静默保存错误字段。

## 风险与控制

| 风险 | 控制 |
| --- | --- |
| 坐标 parser 误判区域 | 低置信时不覆盖旧流程，并返回 warning。 |
| 保单版式差异大 | 第一版只承诺基本信息页和整页轻微歪斜；其它情况回退。 |
| API 合同扩展影响前端 | 实现计划选择最小兼容返回方式，并补类型检查。 |
| PaddleOCR-VL 速度慢 | 不纳入第一版主链路，只作为后续增强。 |
| 附加险和主险边界不清 | 基础字段禁用 rider-table 来源；产品名冲突进入 review。 |
