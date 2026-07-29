# 指定 9 产品生产增量同步预检收据（2026-07-29）

状态：`PREPARED / NOT WRITTEN`。本文件只记录对生产 SQLite 的精确 company+productName 查询、开发 clone dry-run 和安全阻断；没有生产写入、删除、全量替换、ECS 操作或模型/网络调用。

生产目标：`/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite`。当前发现 `/usr/local/bin/node server/index.mjs` PID `62493` 持有该 SQLite writer handle，因此未执行备份、`BEGIN IMMEDIATE` 或正式导入。`PRAGMA integrity_check` 也未在 2 GB 活跃库上强行运行；生产完整校验须在用户安排停写后执行。

| # | 精确 company / productName | 当前 canonical key | sourceDigest | 当前行数 K/A/C/I/O/S | 结论 |
|---:|---|---|---|---|---|
| 1 | 新华人寿保险股份有限公司 / 阳光灿烂少儿两全保险（分红型） | `company_product:新华人寿保险股份有限公司:阳光灿烂少儿两全保险（分红型）` | `sha256:59fd54ca8bf21d10e8ed3094b2d7640c17f4526a1361baed624986e18ff5754e` | `0/0/6/6/0/0` | 可按同一 digest 补 artifact；缺 K/S |
| 2 | 新华人寿保险股份有限公司 / 尊尚人生两全保险（分红型） | `company_product:新华人寿保险股份有限公司:尊尚人生两全保险（分红型）` | `sha256:3e68295dd2a8657d997352e03bc3d7767e8b03c219e003aabcf23a8c85315a2c` | `0/1/6/6/2/0` | 已有同 digest，可替换 |
| 3 | 工银安盛人寿保险有限公司 / 工银安盛人寿御享人生重大疾病保险 | `company_product:工银安盛人寿保险有限公司:工银安盛人寿御享人生重大疾病保险` | `sha256:f0c9e994824f411567a01ccb13e9064a5a43f1eb29370d2d11d1d45b4311f7d4` | `0/1/9/10/0/0` | 已有同 digest，可替换 |
| 4 | 工银安盛人寿保险有限公司 / 工银安盛人寿附加综合意外伤害保险 | `company_product:工银安盛人寿保险有限公司:工银安盛人寿附加综合意外伤害保险` | `sha256:7901e9eae3b55bec87b36cce33cf5fdb14fc45231c36e5bd8275206a04d70758` | `0/1/4/4/0/0` | 已有同 digest，可替换 |
| 5 | 工银安盛人寿保险有限公司 / 工银安盛人寿附加住院津贴医疗保险 | `company_product:工银安盛人寿保险有限公司:工银安盛人寿附加住院津贴医疗保险` | `sha256:1214d5cf4795ffeb6d2ed07ac0549ff562d7ba1c13fcd79c90adef9a3cfc2252` | `0/1/2/2/0/0` | 已有同 digest，可替换 |
| 6 | 工银安盛人寿保险有限公司 / 工银安盛人寿附加住院费用医疗保险 | `company_product:工银安盛人寿保险有限公司:工银安盛人寿附加住院费用医疗保险` | `sha256:c3512894f66db61b1aec541bc6aa79c532f92256bdb367f5005e4d9d66375619` | `0/1/1/1/0/0` | 已有同 digest，可替换 |
| 7 | 工银安盛人寿保险有限公司 / 工银安盛人寿附加意外伤害医疗保险（B款） | `company_product:工银安盛人寿保险有限公司:工银安盛人寿附加意外伤害医疗保险（B款）` | `sha256:d501ca06f1a1c8ce8eb354fbd9240cf0246f80e2a131c518ad34b9baad16ff44` | `0/1/1/1/0/0` | 已有同 digest，可替换 |
| 8 | 富德生命人寿保险股份有限公司 / 富德生命长盈六号两全保险（万能型） | 未发现目标行 | 未发现目标 digest；仅有“（荣耀版）”候选 `sha256:98527971af33db3d2f303a7039697d8c684de2dd408c4a3e02be8b7d9a87c5b3` | `0/0/0/0/0/0` | **阻断：不得用荣耀版代替目标版本** |
| 9 | 中邮人寿 / 中邮年年好邮保一生A款终身寿险 | `responsibility_product:c463f75055945215` | `sha256:450072db40460a871173a06cd6eb9b90eadb6d03442f7fef0bdf4cd72d2384ed` | `4/1/1/1/0/0` | 已有同 digest，可替换 |

`K/A/C/I/O/S` 分别为 `knowledge_records / product_responsibility_artifacts / product_responsibility_cards / insurance_indicator_records / optional_responsibility_records / product_customer_responsibility_summaries`。以上行数均来自精确双键查询，不是模糊全表扫描。

已确认的 8 个可用 approved artifact（#8 不含入清单）：

- #1 `artifacts/fast-responsibility-sunshine-child-20260726-130312/run-ocr/products/新华保险-阳光灿烂少儿两全保险-分红型-18f4d83dd6/artifact.json`
- #2 `artifacts/fast-responsibility-requested7-recovery-20260728/luna-merge-repair-run/products/01-新华保险-尊尚人生两全保险-分红型-3c63eb23f8/artifact.json`
- #3 `artifacts/fast-responsibility-requested7-20260726-124058/model-retry-1/products/工银安盛-工银安盛人寿御享人生重大疾病保险-dd93db52f6/artifact.json`
- #4–#6 `artifacts/fast-responsibility-requested7-recovery-20260728/luna-merge-repair-run/products/05-工银安盛-附加综合意外伤害保险-f42c2208d2/artifact.json`、`04-工银安盛-附加住院津贴医疗保险-99003aa5e1/artifact.json`、`03-工银安盛-附加住院费用医疗保险-f8ea38280d/artifact.json`
- #7 `artifacts/fast-responsibility-requested7-recovery-20260728/deepseek-remaining5-run/products/工银安盛-工银安盛人寿附加意外伤害医疗保险-B款-cd6b867c60/artifact.json`
- #9 `/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration/artifacts/20260729-zhongyou-ybysz-a-responsibility.jsonl`

开发 clone dry-run：8 个精确 artifact，`dryRun=true`，`ok=true`，`validationIssueCount=0`，`productsReviewed=8`，`productsWithAcceptedResponsibilities=8`，`acceptedResponsibilities=28`；未写生产，materialized/pruned 均为 0。

生产写入前仍需补齐：#8 精确官方版本 artifact；#1–#7 的 K 行（现有 approved artifact 不等于 `knowledge_records` 行）；用户安排单 writer 后的目标 DB 备份与 SHA；9 个产品逐项卡/指标/公式/requiredInputs/operands/branches/sourceUrl/sourceDigest/客户摘要读回；FK、integrity、前后 counts/SHA 和回滚收据。任一项失败，整批不写或回滚，不得改动非目标产品。
