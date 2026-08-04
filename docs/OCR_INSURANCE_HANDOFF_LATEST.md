# OCR_insurance 保险责任批处理交接

更新时间：2026-07-28（Asia/Shanghai）  
工作目录：`/Volumes/OCR_ARCHIVE/OCR_insurance`  
文档性质：运行交接记录；不替代各批次的不可变 manifest、summary、audit 或 SHA 文件。

## 1. 接手人先看这里

1. 当前 SQLite 入库明确暂停。不要启动 writer；等待用户提供 SSD 上的新数据库路径和恢复指令。
2. 数据库已迁移到本机 SSD：`/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite`。当前仍只允许只读核验，未收到“恢复入库”指令前不得写入。
3. 现有数据库已恢复到写前 APFS clone，当前无 importer、无 SQLite writer、WAL=0。
4. 所有解析、来源修复、质量审核均为 parse-only/source-only，不写 SQLite、飞书、不发布。
5. Gemini 因 HTTP 429 与首次解析 modern-schema systemic gate 暂停；不要直接恢复 Gemini 批次。
6. DianJin 只能 shadow。新 B（SSH 47378）8000 端口不健康；C（53826）健康但只作为备用端点，不能接主解析。
7. 任何续跑都必须先按 `sourceDigest > sourceUrl > company+productName` 去重，并排除已终态、在途和历史副本。

SSD 目标库只读核验（2026-07-28）：文件存在，大小 `1,629,556,736` bytes；只读连接成功；`journal_mode=wal`、`locking_mode=normal`、`schema_version=237`、`PRAGMA quick_check(1)=ok`；WAL `626,272` bytes、SHM `32,768` bytes。`lsof` 显示 PID `10665`（`node server/index.mjs`）以 FD12u 持有数据库句柄。未发现 importer 或 `sqlite3` 导入进程；Node 服务不是本入库窗口，但恢复 writer 前必须先协调该应用句柄，不能强行并发写入。

## 2. 窗口和任务 ID

| 窗口 | 任务 ID | 当前状态 | 责任边界 |
|---|---|---|---|
| Review 质量修复 | `019fa801-751c-73d0-8ef5-87449e62a48b` | batch004 收口后 idle | 只修 inventory/evidence/validator/importer dry-run，不写库 |
| 来源修复 | `019fa801-c30f-78e3-b75b-1f73356a875d` | batch012 后 idle | 只获取/核验官方来源，不调用模型、不写库 |
| 模型重试 | `019fa801-9b80-7ed2-88f9-be19701ca117` | fallback37 已收口 | 只重试失败模型层，Gemini paused，Luna 最多3并发 |
| 首次解析 | `019fa801-e7c5-76f0-b77f-7b06a76c63b0` | 已锁定 Luna 路由全部收口 | Gemini freeze；新 source_ready 才能生成 append |
| 唯一 SQLite 入库 | `019fa1f5-517f-7970-a35f-68b35c996187` | **暂停** | 唯一 writer；当前不可启动新事务 |
| DianJin 协调 | `019fa377-4b78-7fc0-9143-93ced8bb7246` | idle/shadow-only | 不领取 backlog，不做主解析 |

## 3. 已执行结果（按唯一产品/终态口径）

### 3.1 Review 质量修复（326 条）

| 批次 | 数量 | approved-candidate | source-blocked | unresolved | validation/importer-failure |
|---|---:|---:|---:|---:|---:|
| batch001 | 100 | 11 | 26 | 28 | 35 |
| batch002 | 100 | 8 | 35 | 11 | 46 |
| batch003 | 100 | 0 | 26 | 15 | 59 |
| batch004 | 26 | 6 | 13 | 5 | 2 |
| 合计 | **326** | **25** | **100** | **59** | **142** |

说明：`approved-candidate` 仍是 parse-only 候选，不是 production approval；必须由唯一 importer 独立重验后才能入库。不可把 validation/manual/source 队列相加成更多产品。

权威 ledger：

`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/review-backlog-912-20260728/global-review-ledger.jsonl`  
SHA-256：`c9ae6606b35ca641ebb905b95c39a220b4213d8f093e5deb5be8cadccbd905c5`

关键批次目录：

- `/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/review-backlog-912-20260728/batch-001/`
- `/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/review-backlog-912-20260728/batch-002/`
- `/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/review-backlog-912-20260728/batch-003/`
- `/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/review-backlog-912-20260728/batch-004/`

### 3.2 来源修复（主账 batch001–012，共1200条）

| 状态 | 数量 |
|---|---:|
| source_ready | **653** |
| version_conflict | **24** |
| source_blocked | **523** |
| ocr_needs_review | **0** |

逐批结果：

`batch001 7/2/91`、`batch002 66/5/29`、`batch003 100/0/0`、`batch004 100/0/0`、`batch005 93/7/0`、`batch006 92/8/0`、`batch007 98/2/0`、`batch008 49/0/51`、`batch009 0/0/100`、`batch010 0/0/100`、`batch011 0/0/100`、`batch012 48/0/52`。

上述三元组均为 `source_ready/version_conflict/source_blocked`。batch009–011 的 JRCPCX detail 阶段没有 verified PDF，已按 bounded 规则终止，不应重复盲查。

主目录：

`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/source-repair-backlog-204-20260728/`

batch012 review-return 去重 manifest：

`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/review-backlog-912-20260728/source-return-batch012/source-return-review-manifest.jsonl`

### 3.3 首次解析（Gemini/Luna）

已落盘终态共 **248 个产品槽位**，不把未发 Gemini 请求算入 processed：

- Luna：136 个；approved 43、validation-review 51、model-retry 42。
- Gemini：112 个；approved 0、validation-review 75、model-retry 37（batch001 100 + batch002 已发12）。
- Gemini batch002 仍有72条未发，batch003及后续 Gemini 未启动。
- 既有 source-return batch001=7、batch002=55 已分别纳入对应 Luna 批；batch003–012 没有新的 first-parse-return。

Luna 终态目录：

`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/first-parse-backlog-920-20260728/execution/luna-shard-1/`  
`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/first-parse-backlog-920-20260728/execution/luna-shard-2/`  
`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/first-parse-backlog-920-20260728/execution/luna-shard-3/`  
`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/first-parse-backlog-920-20260728/execution/luna-batch004-shard-1/`  
`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/first-parse-backlog-920-20260728/execution/luna-batch005-shard-1/`

### 3.4 模型重试

fallback37 最终账：37 个唯一产品、65 条责任：

- approved 26（全部 canonicalizer/validator/importer dry-run 通过）
- validation-review 7
- model-retry 4

最终文件：

`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/global-model-retry-ledger-20260728-final/luna-fallback-429-20260728/final-summary.json`  
`/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/global-model-retry-ledger-20260728-final/luna-fallback-429-20260728/final-approved.jsonl`

approved SHA-256：`af6d559899b6d7b9a58ed4898682eba0988d7926edbc56df5b9f0a0c5906fbd1`。

另外，malformed Luna batch001/002 是独立批次，不要与 fallback37 相加：batch001 最终6 approved；batch002 最终7 approved、2 provider_context_blocked。

### 3.5 DianJin

历史 packetized shadow 去重后：136 个产品、488 个责任 packet；106 aligned、30 review_required、0 failed。它从未作为主解析器，未写 SQLite/飞书。

- B：`ssh -p 47378` 可达，但远端 `127.0.0.1:8000` refused，无 vLLM 服务。
- C：`ssh -p 53826` 健康，`DianJin-R1-32B`，仅作为备用诊断端点。
- 双服务器 8 并发 canary 未恢复；不要自行启动 B 或领取 backlog。

## 4. SQLite 入库暂停状态

唯一 importer 曾准备 batch001：22 产品/88责任，dry-run 通过；用户暂停后已安全终止并恢复写前 APFS clone，最终净写入：

**0 产品 / 0 责任**。

有效写前备份：

`/Volumes/OCR_ARCHIVE/OCR_insurance/.runtime/responsibility-approved-backlog-100-20260728-1758/backups/policy-ocr-before-batch-001-apfsclone.sqlite`

备份 SHA-256：`c95cdbd9beacd4e09f41ecebf32fe0ac15a882b5c8d42f9aad5424c5741acd21`

暂停 ledger v5：

`/Volumes/OCR_ARCHIVE/OCR_insurance/.runtime/responsibility-approved-backlog-100-20260728-1758/manifests/paused-pending-ledger-20260728-v5.jsonl`

v5 SHA-256：`95421b19c26c7c0c8a5afd9cf1eb5dd6cd33b6a92dbd6a192b92021fe9231774`

v5 已登记但未写入的主要新增来源：

- Luna first-parse batch003：41 产品 / 625 责任；batch005 的2产品与既有条目重复，跳过。
- fallback37：26 approved 去重后新增24产品 / 45责任；2个重复跳过。
- Review batch004 的6个 approved-candidate及此前待入库批次均只保留 ledger 记录。

恢复入库前必须：

1. 用户提供 SSD 上的新 SQLite 绝对路径。
2. 只读确认数据库可读、WAL/锁状态和唯一 writer 不存在。
3. 用 v5 ledger 重新去重，重新做全批 dry-run。
4. 先备份并记录 SHA，再按不超过100产品的事务批量写入，逐批 readback/integrity。
5. 只有收到用户明确恢复指令后，才允许启动 importer。

## 5. 本轮协调者做过的事情

- 按 `sourceDigest > sourceUrl > company+productName` 统一去重，并避免把 validation/manual/model/source 队列重复相加。
- 将 source-ready 回流隔离到 review 或 first-parse，不把 source-blocked/version-conflict 当作可解析产品。
- 在 Gemini 429 和 modern-schema systemic failure 后冻结 Gemini，转用有界 Luna，并保持最多3个真实 subagent、互斥小包。
- 让所有模型/来源/review 窗口保持 parse-only/source-only，不写 SQLite、飞书和发布。
- 识别并保护唯一 SQLite writer；暂停时要求安全收口/恢复备份，未强杀写事务。
- 只把 validator approved 且 importer dry-run 通过的产品交给入库窗口；validation/model/source 失败项均排除。
- 保持 DianJin shadow-only，不让其阻塞 Gemini/Luna，也未恢复不健康的 B 服务。

## 6. 下一位接手人的操作顺序

### 如果继续“暂停入库”

- 保持 importer idle，不读写 SQLite。
- 可以继续只读审计、来源整理和 artifact 级去重；不要把新 approved 自动写库。
- 所有新 approved 追加 paused ledger 新版本并记录 SHA。

### 如果恢复入库

- 先确认 SSD 路径和用户恢复授权。
- 复核 v5 ledger 与新路径数据库的 product/digest 去重。
- 一次只允许一个 importer；从 dry-run、备份、事务、readback、integrity 按顺序执行。

### 如果恢复解析/来源

- Gemini 不能直接恢复；先做新的小型 schema/额度 canary。
- Luna 仍按最多3个互斥 subagent，小包完成并回调后再补位。
- 来源继续使用官方 API/static → 真实 Chrome headless → 空密码解密 → 必要 OCR → JRCPCX 末级恢复；版本冲突不猜版本。

## 7. 重要禁止事项

- 不启动第二个 SQLite writer。
- 不把 candidate-only、validation-review、manual-review、model-retry、source-retry 导入生产库。
- 不把 DianJin 结果当主解析或最终 artifact。
- 不因为队列文件行数就直接相加；必须按唯一产品和最终状态统计。
- 不重复下载/重跑已有 digest，不重跑成功 packet。
- 不在没有版本线索时从多个官方版本中猜选一个。
- 不恢复或改写 `.env.local`、生产 secrets、飞书发布状态。
