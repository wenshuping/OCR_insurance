# 现金价值表 OCR 识别与解析设计

## 概述

用户在保单基本信息确认保存后，通过弹框引导上传保单现金价值页面。系统使用 Paddle OCR（增强版，含坐标信息）按行列扫描解析表格，像人眼一样逐行读取数据。解析失败时回退到视觉大模型。解析结果存入 `policy_cash_values` 表，替换模板计算数据，在现金流页面合并展示。

## 需求确认

| 项目 | 决策 |
|------|------|
| 表结构 | 2列（保险年限 \| 现金价值）或 3列（保险年限 \| 被保险年龄 \| 现金价值），自动识别 |
| 上传入口 | 保单保存成功后弹框引导上传 |
| 数据用途 | 存入 DB，替换模板计算数据 |
| 关联方式 | 先识别保单首页并保存 → 弹框引导追加现金价值页面 |
| 多页支持 | 先做单页，后续迭代 |
| OCR 方式 | Paddle OCR 优先（含坐标） → 解析失败时回退视觉大模型 |

## 用户流程

### 主流程

```
拍照上传保单首页 → OCR 识别基本信息 → 用户确认/编辑表单
       │
       ▼
  用户点击"保存保单"
       │
       ▼
  保单基本信息保存到 DB（现有逻辑不变）
       │
       ▼
  弹出弹框："保单已保存！是否上传现金价值表？"
       │
       ├─ "拍照上传" → 进入现金价值 OCR 流程
       │
       └─ "暂时跳过" → 进入保单列表（不再自动弹出）
```

### 现金价值 OCR 流程

```
用户选择文件/拍照
       │
       ▼
  POST /api/policies/:id/cash-value/scan
       │
       ▼
  Paddle OCR 提取文本 + 坐标
       │
       ▼
  规则解析引擎（行聚类 → 表头识别 → 逐行读取）
       │
       ├─ 成功（置信度 >= 0.7，行数 >= 3）→ 返回结构化数据
       │
       └─ 失败 → 视觉大模型兜底 → 返回结构化数据
       │
       ▼
  前端展示可编辑的解析结果预览
       │
       ├─ "确认保存" → POST /api/policies/:id/cash-value/confirm → 写入 DB
       ├─ "重新拍照" → 重新打开文件选择器
       └─ "跳过" → 关闭弹框
```

### 弹框触发规则

- 仅在**新保单首次保存**时弹出
- 已有现金价值数据的保单不重复弹出
- 用户选择"暂时跳过"后不再自动弹出，可在保单详情页的"现金价值"区域点击"上传现金价值表"按钮手动触发
- 编辑已保存保单时不弹出

## 数据库设计

### 新增表：policy_cash_values

```sql
CREATE TABLE IF NOT EXISTS policy_cash_values (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_id   INTEGER NOT NULL REFERENCES policies(id),
  policy_year INTEGER NOT NULL,       -- 保单年度 (1, 2, 3, ...)
  age         INTEGER,                -- 被保险年龄（3列表时有值，2列表时为 NULL）
  cash_value  REAL    NOT NULL,       -- 现金价值金额
  source      TEXT    DEFAULT 'ocr',  -- 数据来源: 'ocr' | 'vision_llm' | 'manual'
  created_at  TEXT    DEFAULT (datetime('now')),
  UNIQUE(policy_id, policy_year)
);
CREATE INDEX IF NOT EXISTS idx_cash_values_policy
  ON policy_cash_values(policy_id);
```

### 设计决策

- **独立表**：现金价值表与 `policy_cashflows`（现金流/领取记录）是不同概念，分开存储
- **UNIQUE 约束**：`policy_id + policy_year` 唯一，重复上传时 `INSERT OR REPLACE` 自动覆盖
- **source 字段**：标记数据来源，便于排查和统计
- **age 可空**：兼容 2 列格式（无年龄列）

### 与 policy_cashflows 的关系

- `policy_cashflows`：存每年领取/给付的现金流（annual payout）
- `policy_cash_values`：存每年退保可拿回的现金价值（surrender value）
- 前端展示时，从 `policy_cash_values` 读取现金价值列，合并到 cashflow 表格

## OCR 增强：像人眼一样读表

### Paddle OCR 脚本增强

修改 `ocr-service/scripts/policy_ocr_paddle.py`，新增带坐标的数据提取：

```python
def collect_lines_with_boxes(result) -> dict:
    """提取文本及其在页面上的位置坐标"""
    lines = []
    boxes = []
    for item in result or []:
        payload = getattr(item, "res", item)
        if not isinstance(payload, dict):
            continue
        texts = payload.get("rec_texts") or []
        rec_boxes = payload.get("rec_boxes") or []
        scores = payload.get("rec_scores") or []
        for i, text in enumerate(texts):
            text = str(text).strip()
            if not text:
                continue
            lines.append(text)
            box_entry = {"text": text}
            if i < len(rec_boxes):
                box_entry["box"] = rec_boxes[i]
            if i < len(scores):
                box_entry["confidence"] = scores[i]
            boxes.append(box_entry)
    return {"lines": lines, "boxes": boxes}
```

输出格式：

```json
{
  "ok": true,
  "pipeline": "ocr",
  "lines": ["保单年度", "现金价值", "1", "8,500", "2", "19,200"],
  "ocrText": "保单年度\n现金价值\n1\n8,500\n2\n19,200",
  "boxes": [
    {"text": "保单年度", "box": [[100,50],[200,50],[200,70],[100,70]], "confidence": 0.98},
    {"text": "现金价值", "box": [[350,50],[450,50],[450,70],[350,70]], "confidence": 0.97},
    {"text": "1", "box": [[120,90],[140,90],[140,110],[120,110]], "confidence": 0.99},
    {"text": "8,500", "box": [[360,90],[430,90],[430,110],[360,110]], "confidence": 0.96}
  ]
}
```

### 表格解析算法

新建 `ocr-service/cash-value-parser.mjs`，实现以下算法：

#### Step 1 — 行聚类（模拟人眼"横向扫一行"）

```
输入: boxes[] (带坐标的文本项)

按 Y 坐标中位数分组：
  对每个 box，计算 Y 中位数 = (box[0].y + box[2].y) / 2
  相邻 Y 差值 < 阈值（如 15px，可配置）的归为同一行
  每行内按 X 坐标从左到右排序

输出:
  Row 0: [{text:"保单年度", x:100}, {text:"现金价值", x:350}]
  Row 1: [{text:"1", x:120}, {text:"8,500", x:360}]
  Row 2: [{text:"2", x:120}, {text:"19,200", x:360}]
  ...
```

#### Step 2 — 表头识别（模拟人眼"先看标题理解列含义"）

```
扫描各行，找到含以下关键词的行作为表头：
  - "保单年度" / "保险年限" / "保险年度" / "年度"
  - "现金价值" / "退保金" / "账户价值"

从表头确定列数和列含义：
  表头项数 = 2 → 两列模式 [年度, 现金价值]
  表头项数 = 3 → 三列模式 [年度, 年龄, 现金价值]
  表头含"年龄" / "被保险年龄" → 确认中间列是年龄

若找不到有效表头 → 解析失败，进入视觉大模型兜底
```

#### Step 3 — 逐行读取数据（模拟人眼"从上往下逐行读"）

```
跳过表头行，对后续每一行：

  2列模式: policy_year = col[0], cash_value = col[1]
  3列模式: policy_year = col[0], age = col[1], cash_value = col[2]

  数值规范化:
    去除千分位逗号: "19,200" → 19200
    去除单位后缀: "8,500元" → 8500
    处理空格: "1 9,200" → 19200（OCR 常见错误）
    中文数字转换: "一万" → 10000（如有）

  跳过无法解析的行（如含文字注释、合计行等）
```

#### Step 4 — 校验（模拟人眼"回头看一遍是否合理"）

```
✓ policy_year 递增（1,2,3... 或 5,10,15,20...）
✓ cash_value 非负
✓ age 递增（3列模式，相邻行差值 <= 1）
✓ 解析行数 >= 3（太少可能是误检）
```

### 置信度评估

```
confidence = 综合以下因子:
  - OCR 平均文本置信度（权重 0.4）
  - 行对齐规整度（权重 0.3）— 各行列数是否一致
  - 数值合理性（权重 0.3）— 年份连续性、金额递增性

阈值: confidence >= 0.7 → 成功
      confidence < 0.7  → 进入视觉大模型兜底
```

## 视觉大模型兜底

### 触发条件

- Paddle OCR 返回的 boxes 为空（服务不可用或识别失败）
- 行聚类后无法找到有效表头
- 解析行数 < 3
- 校验失败（年份不递增、金额为负等）
- 综合置信度 < 0.7

### 调用流程

```
1. 将原始图片 base64 + 结构化 prompt 发给视觉大模型
2. Prompt:
   "请识别这张图片中的现金价值表格。
    返回 JSON 数组，每项包含:
    - policyYear: 保单年度(整数)
    - age: 被保险年龄(整数，如无此列则为 null)
    - cashValue: 现金价值金额(数字)
    只返回 JSON，不要其他内容。"
3. 解析返回的 JSON
4. 校验: 同规则解析的校验规则
5. 标记 source = 'vision_llm'
```

### 视觉大模型配置

- 新增环境变量 `VISION_LLM_API_KEY`、`VISION_LLM_ENDPOINT`、`VISION_LLM_MODEL`
- 初始实现支持 OpenAI 兼容 API（覆盖 GPT-4o 及其他兼容服务）
- 若未配置环境变量，视觉大模型兜底功能静默禁用，仅返回 Stage 1 的部分结果 + 警告
- 封装在 `server/vision-llm.mjs` 中

## API 设计

### 新增端点

#### POST /api/policies/:id/cash-value/scan

OCR 识别现金价值表，返回解析结果（不写入 DB）。

```
Request:
{
  uploadItem: {
    dataUrl: string,   // 图片 base64
    type: string,      // MIME type
    name: string       // 文件名
  }
}

Response (成功):
{
  ok: true,
  source: 'ocr' | 'vision_llm',
  tableType: 2 | 3,
  rows: [
    { policyYear: 1, age: 30, cashValue: 8500 },
    { policyYear: 2, age: 31, cashValue: 19200 }
  ],
  rowCount: 25,
  confidence: 0.92
}

Response (失败):
{
  ok: false,
  error: 'CASH_VALUE_TABLE_NOT_DETECTED' | 'PARSE_FAILED' | 'VISION_LLM_FAILED',
  message: '未能识别现金价值表，请确保照片清晰且包含完整表格'
}
```

#### POST /api/policies/:id/cash-value/confirm

用户确认/编辑后保存解析结果到 DB。

```
Request:
{
  rows: [
    { policyYear: 1, age: 30, cashValue: 8500 },
    { policyYear: 2, age: 31, cashValue: 19200 }
  ]
}

Response:
{
  ok: true,
  savedCount: 25
}
```

### 现有端点变更

#### GET /api/policies/:id

响应新增 `cashValues` 字段：

```json
{
  "id": 1,
  "company": "中国平安保险",
  "name": "平安盛世金越终身寿险",
  "cashValues": [
    { "policyYear": 1, "age": 30, "cashValue": 8500, "source": "ocr" },
    { "policyYear": 2, "age": 31, "cashValue": 19200, "source": "ocr" }
  ]
}
```

## 前端设计

### 现金价值上传弹框

触发时机：`handleSubmit()` 中保单保存成功后。

弹框内容：
- 标题："保单已保存！是否上传现金价值表？"
- 说明文字："拍照上传保单的现金价值页面，系统将自动识别并录入"
- 按钮："拍照上传"（主按钮）、"暂时跳过"（次按钮）

状态管理：
- 新增 `cashValueDialogOpen` 状态控制弹框显隐
- 新增 `cashValuePolicyId` 记录当前要录入的保单 ID
- 在 `handleSubmit` 成功后设置这两个状态

### 解析结果预览（可编辑表格）

弹框第二步，OCR 识别完成后展示：

- 顶部：来源标识（Paddle OCR / AI识别）+ 置信度
- 表格：保单年度 | (年龄) | 现金价值，每个单元格可点击编辑
- 低置信度行（< 0.8）黄色高亮
- 底部按钮："确认保存"、"重新拍照"、"跳过"
- 编辑时使用 inline input，失焦自动保存修改

### 现金价值在现金流页面合并展示

在现有 `CashflowAnnualTable` 组件中：
- 从 `policy.cashValues` 读取 OCR 数据
- 按 `policyYear` 计算对应的 calendar year：`calendarYear = effectiveDate.year + policyYear - 1`，匹配到 cashflow 行
- 将 `cashValue` 填入"现金价值"列
- OCR 数据优先于模板计算数据
- 若某年无 OCR 数据，回退到模板计算值
- `effectiveDate` 从保单基本信息中获取（已在现有 policy 对象中）

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 图片不是现金价值表 | 返回 `CASH_VALUE_TABLE_NOT_DETECTED`，提示用户确认拍照内容 |
| Paddle OCR 服务不可用 | 自动切换视觉大模型 |
| 规则解析行数 < 3 | 进入视觉大模型兜底 |
| 规则解析置信度 < 0.7 | 进入视觉大模型兜底 |
| 视觉大模型也失败 | 返回 `PARSE_FAILED`，提示手动输入或重新拍照 |
| 视觉大模型 API 不可用 | 返回 Stage 1 的部分结果 + 低置信度警告 |
| policyId 不存在 | 返回 404 |
| 重复上传（同保单） | `INSERT OR REPLACE` 覆盖旧数据 |

## 文件变更范围

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `ocr-service/scripts/policy_ocr_paddle.py` | 修改 | 新增 `collect_lines_with_boxes()` 返回坐标 |
| `ocr-service/insurance-ocr.service.mjs` | 修改 | 新增现金价值表检测逻辑 |
| `ocr-service/cash-value-parser.mjs` | **新建** | 表格解析核心（行聚类、列检测、数值提取、置信度） |
| `ocr-service/router.mjs` | 修改 | 新增 `/internal/ocr/policies/cash-value/scan` 路由 |
| `server/app.mjs` | 修改 | 新增 2 个 API 端点（scan + confirm） |
| `server/cashflow-store.mjs` | 修改 | 新增 `policy_cash_values` 表 DDL + CRUD |
| `server/vision-llm.mjs` | **新建** | 视觉大模型调用封装 |
| `src/App.tsx` | 修改 | 保存后弹框、现金价值上传/预览/编辑组件 |
| `src/api.ts` | 修改 | 新增 API 类型定义和调用函数 |
