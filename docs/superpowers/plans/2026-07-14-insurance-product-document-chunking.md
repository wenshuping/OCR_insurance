# 保险产品资料切片第一版实施计划

对应设计：`docs/superpowers/specs/2026-07-13-insurance-product-document-chunking-design.md`

**目标：** 在不推翻现有产品知识库的前提下，保证已发布资料绑定到确定产品、每个切片有独立业务标记、上传资料不会覆盖官方责任，并提高等待期、免赔额、比例、限额等精确问题的召回稳定性。

**实现原则：** 保留现有 `product_documents`、`knowledge_chunks`、`product_facts`、责任卡和客户责任摘要。第一版不引入新数据库、向量服务、知识图谱或新的模型调用链；物理切片由确定性代码完成，模型只允许作为后续候选标注器，不能决定产品身份或发布状态。

**技术范围：** Node.js ESM、SQLite、现有 FTS5、Node test runner。第一版只改 `server/` 和后端测试，不改前端，不触碰生产数据。

---

## 一、关键决策

### 1. 结构类型和语义类型分开

现有 `knowledge_chunks.chunk_type` 继续只表示结构：

- `parent`：页面或章节上下文；
- `child`：正文可检索块；
- `table`：结构化表格块。

不把 `child` 直接改成 `clause/fact/formula`，避免破坏现有查询、审核和回滚逻辑。每个非父切片在 `payload` 中增加独立语义标记：

```json
{
  "semantic": {
    "evidenceKind": "clause",
    "topics": ["coverage"],
    "factKeys": ["benefit_limit"],
    "responsibility": "一般医疗费用保险金",
    "planNames": ["计划一"],
    "contractual": true,
    "nonContractual": false,
    "requiredContextChunkIds": [],
    "classifierVersion": "product-chunk-semantic-v1"
  }
}
```

`evidenceKind` 第一版只允许：

```text
clause | fact | formula | definition | process | claim | other
```

`factKeys` 第一版只抽取六类高价值字段：

```text
waiting_period
annual_deductible
reimbursement_ratio
benefit_limit
entry_age
renewal_period
```

### 2. 产品绑定是发布门，不是提示信息

一份资料可以先解析和预览，但发布时必须满足：

- 至少有一个产品链接；
- 每个 `index_status='ready'` 的非父切片都有 `canonical_product_id`；
- 同一切片不能同时命中两个产品范围；
- 多产品资料不能存在未确认页面范围；
- 如果上传时明确选择了 `product_version_id`，全部切片必须绑定同一版本；未填写版本时第一版允许为空，但不得自动借用其他版本事实。

不再只对“责任指标资料”检查产品身份，所有可发布产品资料使用同一绑定门。

### 3. 官方责任摘要不可被重新推导

保险责任问题的证据优先级固定为：

```text
客户责任摘要（C端同源）
→ 责任卡
→ 官方条款块
→ 已审核上传资料（只补充解释）
```

上传 PPT 不得新增、合并、改名或删除客户责任摘要中的责任。若上传资料冲突，保留官方结果并记录冲突提示。

### 4. DeepSeek/Hermes 不参与物理切片

`product-chunker.service.mjs` 根据页、标题、款项、完整句和表格确定边界。新语义标注服务使用本地规则生成稳定标记。后续如增加模型标注，只能写入 `candidate` 字段并经过质量检查，不能直接发布。

---

## 二、目标数据流

```text
上传/重新解析
  → parseProductDocument
  → detectProductBoundaries + matchProductCandidates
  → chunkProductDocument                  # 只做物理切片
  → annotateProductChunks                 # 每块独立语义标记
  → assessProductChunksQuality
  → replaceParsedArtifacts                # 保存候选索引
  → review publish readiness              # 强制产品绑定门
  → publish candidate index

查询
  → classifyProductKnowledgeQuery
  → buildRetrievalPlan
  → confirmed product_facts（存在时）
  → 按产品/版本/来源/语义过滤切片
  → 加入必要上下文
  → 与客户责任摘要、责任卡、官方资料装配
  → 模型只组织表达
```

---

## 三、文件改动

### 新增

- `server/product-chunk-semantics.service.mjs`
  - 给每个切片生成独立语义标记；
  - 识别有限的必要上下文关系；
  - 不访问数据库、不调用模型。
- `server/product-fact-extractor.service.mjs`
  - 从已标记切片提取六类结构化事实候选；
  - 负责数值、单位、适用范围和完整性状态。
- `tests/product-chunk-semantics.test.mjs`
- `tests/product-fact-extractor.test.mjs`

### 修改

- `server/product-ingestion.service.mjs`
  - 在物理切片后调用语义标注；
  - 将事实候选交给知识库存储；
  - 保存分类器和抽取器版本。
- `server/product-document-quality.service.mjs`
  - 增加发布准备度检查，不混入解析质量逻辑。
- `server/product-knowledge-store.mjs`
  - 增加窄方法保存/查询 `product_facts`；
  - `searchChunks` 支持版本、来源和语义过滤；
  - 不新建另一套事实表。
- `server/routes/product-knowledge.routes.mjs`
  - `publish` 前执行绑定与准备度检查；
  - 路由保持薄，只组装数据并返回明确错误。
- `server/product-rag.service.mjs`
  - 按问题类型生成检索计划和证据配额；
  - 返回结构化事实和上传资料证据，不负责最终回答。
- `server/agent-product-knowledge.service.mjs`
  - 保持 C 端责任摘要为保险责任问题的主结果；
  - 上传资料只补充优势、适用场景和说明；
  - 对冲突证据采用官方结果。
- 现有相关测试：
  - `tests/product-ingestion-binding.test.mjs`
  - `tests/product-chunker.test.mjs`
  - `tests/product-knowledge-quality.test.mjs`
  - `tests/product-rag.test.mjs`
  - `tests/agent-product-knowledge.test.mjs`
  - `tests/admin-knowledge-upload.test.mjs`

---

## 四、实施任务

### Task 1：建立所有资料统一的产品绑定发布门

**改动文件：**

- `server/product-document-quality.service.mjs`
- `server/routes/product-knowledge.routes.mjs`
- `tests/admin-knowledge-upload.test.mjs`
- `tests/product-ingestion-binding.test.mjs`

新增纯函数：

```js
export function assessProductPublishReadiness({ document, job, links, chunks }) {
  return {
    decision: 'pass', // pass | blocked
    checks: [],
    blockingReasons: [],
  };
}
```

检查规则：

1. 没有产品链接：`product_binding_missing`；
2. 存在 ready 非父块但无 `canonicalProductId`：`chunk_product_binding_missing`；
3. 多产品页范围重叠且切片不能唯一归属：`product_boundary_ambiguous`；
4. 文档指定了版本但切片未绑定版本：`product_version_binding_missing`；
5. 文档仍处于 `match_required`：`product_match_review_required`。

路由发布前读取：

```js
const document = store.getDocument(...);
const job = store.getIngestionJob(...);
const links = store.listDocumentProductLinks(...);
const chunks = store.getDocumentIndexReview(...)?.candidateChunks || [];
const readiness = assessProductPublishReadiness({ document, job, links, chunks });
if (readiness.decision === 'blocked') throw PRODUCT_DOCUMENT_BINDING_REQUIRED;
```

成功标准：

- 新增产品后上传的资料，只要切片确实绑定到新产品即可发布；
- 未绑定、错绑或多产品范围不清的资料不能发布；
- 原有单产品正常上传流程不受影响。

### Task 2：为每个切片增加独立语义标记

**改动文件：**

- 新增 `server/product-chunk-semantics.service.mjs`
- 修改 `server/product-ingestion.service.mjs`
- 新增 `tests/product-chunk-semantics.test.mjs`
- 修改 `tests/product-chunker.test.mjs`

接口：

```js
export function annotateProductChunks({ document, chunks }) {
  return chunks.map((chunk) => ({
    ...chunk,
    payload: {
      ...chunk.payload,
      semantic: classifyChunk({ document, chunk }),
    },
  }));
}
```

分类优先级：

1. `document_type` 决定是否属于合同资料；
2. `headingPath` 决定责任、免责、释义、投保规则或流程；
3. 正文关键词识别公式和六类事实；
4. 现有 `businessTopics` 识别优势、适用人群、健康服务和销售话术；
5. 无法确定时标记 `other`，不猜测。

必要上下文第一版只连接同一产品、同一父块内的三类关系：

- 含“但、除外、不适用、另有约定”的限制块；
- 表格脚注块；
- 公式变量说明块。

不构建通用图数据库。关系直接保存在 `semantic.requiredContextChunkIds`。

成功标准：

- “适合人群”和“产品优势”是两个独立切片标记；
- 正式条款责任块标记为 `contractual=true`；
- PPT 卖点标记为 `claim + nonContractual=true`；
- 重新切片相同内容得到相同语义结果。

### Task 3：复用现有表保存六类结构化事实

**改动文件：**

- 新增 `server/product-fact-extractor.service.mjs`
- 修改 `server/product-ingestion.service.mjs`
- 修改 `server/product-knowledge-store.mjs`
- 新增 `tests/product-fact-extractor.test.mjs`
- 修改 `tests/product-knowledge-index-version.test.mjs`

事实对象：

```json
{
  "fieldKey": "annual_deductible",
  "normalizedValue": { "value": 10000, "unit": "CNY" },
  "displayValue": "1万元",
  "scope": {
    "plan": "计划一",
    "responsibility": "一般医疗费用保险金",
    "period": "每个保险期间"
  },
  "exceptions": [],
  "status": "candidate",
  "completeness": "complete",
  "evidenceChunkIds": ["..."],
  "confidence": 0.92
}
```

状态规则：

- 已发布正式资料且字段完整：可成为 `confirmed`；
- 已审核培训/PPT：仍为 `candidate`，不能独立支持合同结论；
- 同产品同版本同字段出现不同值：`conflicted`；
- 缺单位或适用范围：保留为 `candidate` 且 `completeness=incomplete`。

知识库增加窄方法：

```js
replaceDocumentFacts({ tenantId, documentId, facts })
listProductFacts({ tenantId, canonicalProductId, productVersionId, fieldKeys, statuses })
```

事实通过现有 `product_facts.payload` 保存 `scope`、`exceptions`、`evidenceChunkIds` 和抽取器版本，不增加重复表。

事实与候选索引使用相同生命周期：

- 解析时写入 `candidate`，并在 payload 保存 `documentId` 和 `indexVersion`；
- 发布正式资料时，同一 `documentId + indexVersion` 中完整的候选事实转为 `confirmed`；
- 公司培训/PPT 发布后仍保持 `candidate`；
- 候选索引被拒绝时对应事实转为 `rejected`；
- 发布新索引或回滚旧索引时，事实状态跟随目标索引切换，不能留下两个活动版本。

事实状态切换应放进 `product-knowledge-store.mjs` 的文档审核事务，不能由路由分两次写入。

成功标准：

- 计划一、计划二免赔额保存为两条不同 scope 的事实；
- PPT 中的“最高400万”不能自动成为 confirmed；
- 候选索引被拒绝时不污染正在使用的 confirmed facts；
- 重复处理同一文档不会生成重复事实。

### Task 4：按问题类型装配证据并限制 PPT 权重

**改动文件：**

- `server/product-knowledge-store.mjs`
- `server/product-rag.service.mjs`
- `tests/product-rag.test.mjs`

`searchChunks` 增加可选过滤条件：

```js
searchChunks({
  tenantId,
  query,
  canonicalProductId,
  productVersionId,
  sourceAuthorities,
  semanticKinds,
  factKeys,
  limit,
})
```

`product-rag.service.mjs` 新增本地检索计划：

```js
export function buildProductRetrievalPlan(queryType) {
  if (queryType === 'exact_field') {
    return { useFacts: true, materialLimit: 2, allowedKinds: ['fact', 'clause', 'table'] };
  }
  if (queryType === 'clause_explanation') {
    return { useFacts: true, materialLimit: 2, allowedKinds: ['clause', 'definition', 'table'] };
  }
  if (queryType === 'product_advantage') {
    return { useFacts: true, materialLimit: 6, allowedKinds: ['claim', 'fact', 'clause', 'process'] };
  }
  return { useFacts: false, materialLimit: 4, allowedKinds: [] };
}
```

证据预算：

- 保险责任/精确字段：上传资料最多 2 个块，只作补充；
- 产品优势：上传资料最多 6 个块，其中优势最多 3 个、适用人群最多 1个、健康服务最多 1 个、保障说明最多 1 个；
- 同页重复块只保留一个；
- `requiredContextChunkIds` 不参与排名，但随命中块一起装配；
- 版本明确时禁止召回其他版本。

成功标准：

- 问免赔额时优先返回结构化事实和对应证据；
- 问优势时既能使用 PPT，也不会被同一页重复内容占满；
- 未绑定产品的块永远不能进入正式检索；
- 旧数据没有语义标记时保持现有检索降级能力。

### Task 5：锁定责任回答与 C 端一致

**改动文件：**

- `server/agent-product-knowledge.service.mjs`
- `tests/agent-product-knowledge.test.mjs`

规则：

1. 责任问题必须把 `customerResponsibilitySummary.mainResponsibilities` 作为允许输出的责任集合；
2. 责任卡和官方块只能补充触发条件、给付方式和限制；
3. 上传资料只能补充产品解释，不能增加责任标题；
4. 模型输出引用不存在的证据编号时继续静默移除；
5. 模型不可用时直接返回 C 端摘要，不回退到 PPT 摘要。

回归断言：

```js
assert.deepEqual(
  outputResponsibilityTitles,
  customerResponsibilitySummary.mainResponsibilities.map((item) => item.title),
);
```

至少覆盖：

- 康健无忧两全保险：只输出满期生存和三种身故情形；
- 医药安欣：基本责任和可选责任不被 PPT 合并；
- 上传资料有额外营销责任名称时，答案不增加该名称；
- 问产品优势时仍可组合官方资料和已审核 PPT。

### Task 6：现有资料迁移与验收

不写一次性数据改写脚本。现有资料通过原来的“重新解析/重新切片”生成候选索引，审核后再发布，因此：

- 不需要重新上传原文件；
- 旧活动索引在新候选索引发布前继续可用；
- 新候选索引失败可以拒绝或回滚；
- 不直接修改 `.runtime/` 或生产数据库。

首批开发库验收产品：

1. 新华保险医药安欣（易核版）医疗保险；
2. 新华保险康健无忧两全保险；
3. 一款有计划表的年金险或医疗险。

首批问题控制在 30～40 条，覆盖：

- 产品绑定与多产品页范围；
- 保险责任；
- 等待期、免赔额、比例、限额、年龄、续保；
- 产品优势与适用人群；
- PPT 与官网冲突；
- 同名不同版本隔离。

---

## 五、实施顺序和提交边界

建议按以下顺序实施，每步都可独立回滚：

1. **发布绑定门**：先阻止错误资料进入正式索引；
2. **切片语义标记**：不改变现有检索结果，只增加元数据；
3. **事实候选落库**：先写候选，不立即改变回答；
4. **检索计划与证据配额**：开始使用语义标记和 confirmed facts；
5. **责任回答回归**：锁定与 C 端一致；
6. **开发库真实产品验收**：重新解析现有资料并测试。

不把六项合成一次大改。每项只修改计划列出的文件，不顺手重构相邻模块。

---

## 六、验证命令

每个任务先运行最近的聚焦测试：

```bash
node --test tests/product-ingestion-binding.test.mjs
node --test tests/product-chunk-semantics.test.mjs tests/product-chunker.test.mjs
node --test tests/product-fact-extractor.test.mjs tests/product-knowledge-index-version.test.mjs
node --test tests/product-rag.test.mjs
node --test tests/agent-product-knowledge.test.mjs
node --test tests/admin-knowledge-upload.test.mjs
```

涉及 `server/` 的每个完成节点最终运行：

```bash
npm run check
npm test
```

验收完成条件：

- 未绑定产品资料发布失败，并返回明确原因；
- 已绑定新增产品资料可以发布和检索；
- 每个 ready 非父切片有独立 `payload.semantic`；
- PPT 合同数字不会自动成为 confirmed fact；
- 责任问题的责任标题与 C 端摘要一致；
- 优势问题同时使用官方和上传资料，且 PPT 不挤掉官方证据；
- 无跨产品、跨版本引用；
- 本地生产环境和生产数据保持未触碰。

---

## 七、明确不做

第一版不做以下内容：

- 不引入向量数据库或新依赖；
- 不把所有历史产品一次性重切；
- 不让 DeepSeek/Hermes 决定产品绑定；
- 不建立通用知识图谱；
- 不重写客户责任摘要服务；
- 不增加新的管理后台页面；
- 不用固定 800 字限制答案；
- 不在查询时无上限地重新解析整份 PDF。
