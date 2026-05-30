#!/usr/bin/env python3
"""
将指标拆解定义写入 SQLite 指标库

新增表：indicator_definitions
  - 可拆解计算指标（calc_type = 'calculable'）
  - 不可拆解直接取值指标（calc_type = 'direct'）

写入 state_documents：
  - indicator_base_fields   → 保单基本字段定义
  - indicator_derived_vars  → 派生计算变量定义
  - indicator_decomposition → 拆解元数据汇总
"""
import os
import json
import sqlite3
import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, ".runtime", "policy-ocr.sqlite")

# ── 保单基本字段 ──────────────────────────────────────────────────
POLICY_BASE_FIELDS = [
    {"key": "company",       "label": "保险公司",     "type": "text",     "description": "承保公司全称"},
    {"key": "name",          "label": "产品名称",     "type": "text",     "description": "保险产品全称"},
    {"key": "applicant",     "label": "投保人",       "type": "person",   "description": "投保人姓名"},
    {"key": "insured",       "label": "被保险人",     "type": "person",   "description": "被保险人姓名"},
    {"key": "effectiveDate", "label": "合同生效日期", "type": "date",     "description": "合同生效日，格式 YYYY-MM-DD"},
    {"key": "paymentMode",   "label": "交费方式",     "type": "enum",     "description": "年交 / 半年交 / 季交 / 月交 / 趸交"},
    {"key": "paymentPeriod", "label": "交费期间",     "type": "duration", "description": "如 20年、交至60周岁"},
    {"key": "coveragePeriod","label": "保险期间",     "type": "duration", "description": "如 终身、30年、保至70周岁"},
    {"key": "amount",        "label": "基本保险金额", "type": "money",    "description": "基本保额（元）"},
    {"key": "firstPremium",  "label": "首期保险费",   "type": "money",    "description": "首期保费（元），年交时 = 年交保费"},
    {"key": "beneficiary",   "label": "身故受益人",   "type": "text",     "description": "身故保险金受益人"},
    {"key": "policyNumber",  "label": "保险合同号",   "type": "text",     "description": "保单号"},
]

# ── 派生计算变量 ──────────────────────────────────────────────────
DERIVED_VARIABLES = [
    {"name": "缴费年限",       "formula": "从 paymentPeriod 中解析年数",                                 "depends_on": ["paymentPeriod"],
     "note": "20年→20；交至60周岁→60-投保年龄；趸交→1"},
    {"name": "年交保费",       "formula": "firstPremium（paymentMode=年交时直接取；其他频率需换算）",       "depends_on": ["firstPremium", "paymentMode"],
     "note": "月交×12 / 季交×4 / 半年交×2"},
    {"name": "保险期间年数",   "formula": "从 coveragePeriod 中解析年数",                                  "depends_on": ["coveragePeriod"],
     "note": "终身→按约定年龄(如105)减投保年龄；30年→30"},
    {"name": "已交保单年度数", "formula": "当前日期 - effectiveDate 的整年数",                              "depends_on": ["effectiveDate"],
     "note": "floor((当前日期-生效日期)/365.25)；不能超过缴费年限"},
    {"name": "实际交纳保险费", "formula": "首期保费 × 缴费年限（全部交满时）或 年交保费 × 已交保单年度数",   "depends_on": ["firstPremium", "paymentPeriod", "effectiveDate"],
     "note": "核心变量：条款中\"实际交纳的保险费\"\"已交保险费\"\"所交保险费\"均指此项"},
    {"name": "投保年龄",       "formula": "effectiveDate 年份 - 被保险人出生年份",                          "depends_on": ["effectiveDate", "insured"],
     "note": "从被保人证件号推算出生日期"},
    {"name": "当前保单年龄",   "formula": "投保年龄 + 已交保单年度数",                                      "depends_on": ["effectiveDate", "insured"],
     "note": "用于年龄系数分段判断"},
    {"name": "年龄系数",       "formula": "按条款约定的年龄分段查表",                                       "depends_on": ["当前保单年龄"],
     "note": "如 17周岁以下160%、18-40周岁140%、41-60周岁120%等"},
    {"name": "max(a,b,...)",   "formula": "Python/Excel max 函数",                                          "depends_on": [],
     "note": "条款中\"二者/三者的较大者\""},
    {"name": "min(a,b,...)",   "formula": "Python/Excel min 函数",                                          "depends_on": [],
     "note": "条款中\"二者/三者的较小者\""},
]

# ── 可拆解计算指标 ─────────────────────────────────────────────────
CALCULABLE_INDICATORS = [
    {"name": "实际交纳保险费", "coverage_type": "通用", "liability": "保费计算",
     "formula": "实际交纳保险费 = 首期保费 × 缴费年限",
     "variables": [{"name": "首期保费", "source": "firstPremium"}, {"name": "缴费年限", "source": "paymentPeriod→年数"}],
     "note": "满期/身故等条款中\"实际交纳的保险费\"均指此值"},
    {"name": "累计已交保险费", "coverage_type": "通用", "liability": "保费计算",
     "formula": "累计已交保险费 = 首期保费 × min(缴费年限, 已交保单年度数)",
     "variables": [{"name": "首期保费", "source": "firstPremium"}, {"name": "缴费年限", "source": "paymentPeriod→年数"}, {"name": "已交保单年度数", "source": "effectiveDate推算"}],
     "note": "保单有效期内某时点的实际已交金额"},
    {"name": "疾病身故保险金（max型）", "coverage_type": "人寿保障", "liability": "疾病身故",
     "formula": "疾病身故保险金 = max(现金价值, 累计已交保险费 × 年龄系数)",
     "variables": [{"name": "现金价值", "source": "保单现金价值表查询"}, {"name": "累计已交保险费", "source": "首期保费×已交年度数"}, {"name": "年龄系数", "source": "条款年龄分段表"}],
     "note": "常见于增额终身寿险/两全保险"},
    {"name": "疾病身故保险金（基本保额型）", "coverage_type": "人寿保障", "liability": "疾病身故",
     "formula": "疾病身故保险金 = 基本保险金额",
     "variables": [{"name": "基本保险金额", "source": "amount"}],
     "note": "常见于定期寿险"},
    {"name": "疾病身故保险金（sum型）", "coverage_type": "人寿保障", "liability": "疾病身故",
     "formula": "疾病身故保险金 = 累计已交保险费 + 基本保险金额",
     "variables": [{"name": "累计已交保险费", "source": "首期保费×已交年度数"}, {"name": "基本保险金额", "source": "amount"}],
     "note": "部分两全保险"},
    {"name": "疾病全残保险金（max型）", "coverage_type": "人寿保障", "liability": "疾病全残",
     "formula": "疾病全残保险金 = max(现金价值, 累计已交保险费 × 年龄系数)",
     "variables": [{"name": "现金价值", "source": "保单现金价值表查询"}, {"name": "累计已交保险费", "source": "首期保费×已交年度数"}, {"name": "年龄系数", "source": "条款年龄分段表"}],
     "note": "与身故保险金公式通常一致"},
    {"name": "疾病全残保险金（基本保额型）", "coverage_type": "人寿保障", "liability": "疾病全残",
     "formula": "疾病全残保险金 = 基本保险金额",
     "variables": [{"name": "基本保险金额", "source": "amount"}],
     "note": "常见于定期寿险"},
    {"name": "重疾保险金（首次,基本保额型）", "coverage_type": "疾病保障", "liability": "重疾(首次给付)",
     "formula": "重疾保险金 = 基本保险金额",
     "variables": [{"name": "基本保险金额", "source": "amount"}],
     "note": "条款约定按基本保险金额给付"},
    {"name": "重疾保险金（首次,max型）", "coverage_type": "疾病保障", "liability": "重疾(首次给付)",
     "formula": "重疾保险金 = max(基本保险金额, 累计已交保险费 × 年龄系数, 现金价值)",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "累计已交保险费", "source": "首期保费×已交年度数"}, {"name": "现金价值", "source": "保单现金价值表"}],
     "note": "部分重疾险取三者较大值"},
    {"name": "重疾保险金（首次,比例保额型）", "coverage_type": "疾病保障", "liability": "重疾(首次给付)",
     "formula": "重疾保险金 = 基本保险金额 × 条款约定比例",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "条款约定比例", "source": "条款载明(如100%)"}],
     "note": ""},
    {"name": "中症保险金（首次）", "coverage_type": "疾病保障", "liability": "中症(首次给付)",
     "formula": "中症保险金 = 基本保险金额 × 条款约定比例",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "条款约定比例", "source": "条款载明(如50%/60%)"}],
     "note": "常见比例 50%-60%"},
    {"name": "轻症保险金（首次）", "coverage_type": "疾病保障", "liability": "轻症(首次给付)",
     "formula": "轻症保险金 = 基本保险金额 × 条款约定比例",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "条款约定比例", "source": "条款载明(如20%/30%)"}],
     "note": "常见比例 20%-30%"},
    {"name": "特定疾病保险金", "coverage_type": "疾病保障", "liability": "特定疾病(首次给付)",
     "formula": "特定疾病保险金 = 基本保险金额 × 条款约定比例",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "条款约定比例", "source": "条款载明(如100%/额外给付)"}],
     "note": "少儿/女性/男性特定疾病额外给付"},
    {"name": "防癌/恶性肿瘤保险金", "coverage_type": "疾病保障", "liability": "防癌/恶性肿瘤(首次给付)",
     "formula": "防癌保险金 = 基本保险金额 × 条款约定比例",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "条款约定比例", "source": "条款载明(如100%)"}],
     "note": ""},
    {"name": "疾病终末期保险金", "coverage_type": "疾病保障", "liability": "疾病终末期",
     "formula": "疾病终末期保险金 = 基本保险金额 或 max(基本保额, 已交保费×比例)",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "累计已交保险费", "source": "首期保费×已交年度数"}],
     "note": "部分产品按基本保额给付"},
    {"name": "意外身故保险金", "coverage_type": "意外保障", "liability": "意外身故",
     "formula": "意外身故保险金 = 基本保险金额",
     "variables": [{"name": "基本保险金额", "source": "amount"}],
     "note": "意外险基本保额"},
    {"name": "意外伤残保险金", "coverage_type": "意外保障", "liability": "意外伤残",
     "formula": "意外伤残保险金 = 基本保险金额 × 伤残等级比例",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "伤残等级比例", "source": "1级100%~10级10%"}],
     "note": "按《人身保险伤残评定标准》比例"},
    {"name": "特定意外身故/全残保险金", "coverage_type": "意外保障", "liability": "特定意外身故/全残",
     "formula": "特定意外保险金 = 基本保险金额 × 条款约定倍数",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "条款约定倍数", "source": "条款载明(如2倍/3倍)"}],
     "note": "航空/交通/电梯等特定意外额外给付"},
    {"name": "意外全残保险金", "coverage_type": "意外保障", "liability": "意外全残",
     "formula": "意外全残保险金 = 基本保险金额",
     "variables": [{"name": "基本保险金额", "source": "amount"}],
     "note": ""},
    {"name": "满期生存保险金（已交保费型）", "coverage_type": "现金流", "liability": "满期返还",
     "formula": "满期生存保险金 = 实际交纳保险费",
     "variables": [{"name": "实际交纳保险费", "source": "首期保费×缴费年限"}],
     "note": "两全/年金险满期时返还已交保费"},
    {"name": "满期生存保险金（max型）", "coverage_type": "现金流", "liability": "满期返还",
     "formula": "满期生存保险金 = max(基本保险金额, 实际交纳保险费)",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "实际交纳保险费", "source": "首期保费×缴费年限"}],
     "note": "部分两全取保额与保费较大者"},
    {"name": "满期生存保险金（保额型）", "coverage_type": "现金流", "liability": "满期返还",
     "formula": "满期生存保险金 = 基本保险金额",
     "variables": [{"name": "基本保险金额", "source": "amount"}],
     "note": ""},
    {"name": "年金/生存金（比例保额型）", "coverage_type": "现金流", "liability": "教育/养老金/两全等返还",
     "formula": "年金 = 基本保险金额 × 条款约定比例",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "条款约定比例", "source": "条款载明(如10%/20%)"}],
     "note": "每年/每月领取"},
    {"name": "年金/生存金（比例保费型）", "coverage_type": "现金流", "liability": "教育/养老金/两全等返还",
     "formula": "年金 = 实际交纳保险费 × 条款约定比例",
     "variables": [{"name": "实际交纳保险费", "source": "首期保费×缴费年限"}, {"name": "条款约定比例", "source": "条款载明"}],
     "note": ""},
    {"name": "身故保险金（储蓄型max）", "coverage_type": "现金流", "liability": "身故/全残(储蓄型)",
     "formula": "身故保险金 = max(现金价值, 累计已交保险费 × 年龄系数)",
     "variables": [{"name": "现金价值", "source": "保单现金价值表查询"}, {"name": "累计已交保险费", "source": "首期保费×已交年度数"}, {"name": "年龄系数", "source": "条款年龄分段表"}],
     "note": "增额终身寿/年金险常见"},
    {"name": "身故保险金（储蓄型sum型）", "coverage_type": "现金流", "liability": "身故/全残(储蓄型)",
     "formula": "身故保险金 = 累计已交保险费 + 基本保险金额",
     "variables": [{"name": "累计已交保险费", "source": "首期保费×已交年度数"}, {"name": "基本保险金额", "source": "amount"}],
     "note": "部分两全保险"},
    {"name": "护理保险金", "coverage_type": "疾病保障", "liability": "护理",
     "formula": "护理保险金 = 基本保险金额 × 条款约定比例 或 每日金额 × 天数",
     "variables": [{"name": "基本保险金额", "source": "amount"}, {"name": "条款约定比例/日额", "source": "条款载明"}],
     "note": ""},
]

# ── 不可拆解直接取值指标 ──────────────────────────────────────────
DIRECT_INDICATORS = [
    {"name": "等待期", "coverage_type": "规则参数", "liability": "等待期",
     "example": "90 / 180 / 0", "unit": "日", "basis": "合同等待期", "source": "条款文本",
     "note": "直接读取条款等待期天数，不涉及保单计算"},
    {"name": "重疾疾病种数", "coverage_type": "疾病保障", "liability": "重疾疾病种数",
     "example": "120", "unit": "种", "basis": "疾病定义数量", "source": "条款文本",
     "note": "条款中定义的重度疾病种数"},
    {"name": "中症疾病种数", "coverage_type": "疾病保障", "liability": "中症疾病种数",
     "example": "25", "unit": "种", "basis": "疾病定义数量", "source": "条款文本",
     "note": "条款中定义的中度疾病种数"},
    {"name": "轻症疾病种数", "coverage_type": "疾病保障", "liability": "轻症疾病种数",
     "example": "40", "unit": "种", "basis": "疾病定义数量", "source": "条款文本",
     "note": "条款中定义的轻度疾病种数"},
    {"name": "特定疾病种数", "coverage_type": "疾病保障", "liability": "特定疾病种数",
     "example": "20", "unit": "种", "basis": "疾病定义数量", "source": "条款文本",
     "note": "少儿/女性/男性特定疾病种数"},
    {"name": "责任给付次数上限", "coverage_type": "规则参数", "liability": "责任给付次数上限",
     "example": "3 / 5 / 6", "unit": "次", "basis": "条款给付次数", "source": "条款文本",
     "note": "重疾/中症/轻症等多次给付次数上限"},
    {"name": "赔付方式", "coverage_type": "规则参数", "liability": "赔付方式",
     "example": "定额给付型 / 费用报销型 / 津贴给付型 / 定额给付型+费用报销型", "unit": "方式", "basis": "保险责任赔付机制", "source": "条款文本",
     "note": "识别保险责任按固定金额/比例给付、按实际费用报销、按天数津贴给付，组合责任用+连接"},
    {"name": "免赔额", "coverage_type": "医疗保障", "liability": "免赔额",
     "example": "10000 / 0", "unit": "元", "basis": "免赔额", "source": "条款/保险单",
     "note": "医疗险年免赔额，部分产品0免赔"},
    {"name": "医疗赔付比例（医保结算）", "coverage_type": "医疗保障", "liability": "医保结算赔付比例",
     "example": "100", "unit": "%", "basis": "条款约定比例", "source": "条款文本",
     "note": "以基本医疗保险身份结算的赔付比例"},
    {"name": "医疗赔付比例（未医保结算）", "coverage_type": "医疗保障", "liability": "未以医保结算赔付比例",
     "example": "60", "unit": "%", "basis": "条款约定比例", "source": "条款文本",
     "note": "未以基本医疗保险身份结算的赔付比例"},
    {"name": "医疗保障限额", "coverage_type": "医疗保障", "liability": "医疗保障限额",
     "example": "2000000 / 4000000", "unit": "元", "basis": "年度/累计限额", "source": "条款/保险单",
     "note": "医疗保险金年度或累计给付限额"},
    {"name": "住院津贴日额", "coverage_type": "医疗保障", "liability": "住院津贴日额",
     "example": "100 / 200", "unit": "元/日", "basis": "住院津贴", "source": "条款/保险单",
     "note": "每日住院津贴金额"},
    {"name": "医疗给付天数上限", "coverage_type": "医疗保障", "liability": "给付天数上限",
     "example": "180 / 365", "unit": "日", "basis": "条款天数限制", "source": "条款文本",
     "note": "住院津贴/护理等给付天数上限"},
    {"name": "交通/航空特定给付倍数", "coverage_type": "意外保障", "liability": "交通/航空等给付倍数",
     "example": "2 / 3 / 5", "unit": "倍", "basis": "特定意外额外给付倍数", "source": "条款文本",
     "note": "航空/交通等特定意外额外给付的倍数"},
    {"name": "骨折/关节脱位给付比例", "coverage_type": "意外保障", "liability": "骨折/关节脱位给付比例",
     "example": "10 / 20", "unit": "%", "basis": "条款约定比例", "source": "条款文本",
     "note": "骨折/关节脱位按比例给付"},
    {"name": "万能账户最低保证利率", "coverage_type": "现金流", "liability": "增额/利率",
     "example": "2.0 / 2.5 / 3.0", "unit": "%", "basis": "最低保证利率", "source": "条款文本",
     "note": "万能账户保底利率"},
    {"name": "有效保额递增比例", "coverage_type": "现金流", "liability": "增额/利率",
     "example": "3.0 / 3.5", "unit": "%", "basis": "年度递增比例", "source": "条款文本",
     "note": "增额终身寿有效保额年递增比例"},
    {"name": "领取起始年龄", "coverage_type": "现金流", "liability": "领取起始年龄",
     "example": "55 / 60 / 65", "unit": "周岁", "basis": "年金/养老金领取年龄", "source": "条款/保险单",
     "note": "年金/养老金开始领取的年龄"},
    {"name": "意外医疗免赔额", "coverage_type": "意外保障", "liability": "意外医疗免赔额",
     "example": "100 / 0", "unit": "元", "basis": "免赔额", "source": "条款/保险单",
     "note": "意外医疗的免赔额"},
]


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    # 1. 创建 indicator_definitions 表
    cur.execute("DROP TABLE IF EXISTS indicator_definitions")
    cur.execute("""
        CREATE TABLE indicator_definitions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            calc_type TEXT NOT NULL,
            coverage_type TEXT,
            liability TEXT,
            formula TEXT,
            variables TEXT,
            example_value TEXT,
            unit TEXT,
            basis TEXT,
            data_source TEXT,
            note TEXT,
            created_at TEXT NOT NULL,
            payload TEXT NOT NULL
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ind_def_calc_type ON indicator_definitions(calc_type)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ind_def_coverage ON indicator_definitions(coverage_type)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_ind_def_liability ON indicator_definitions(liability)")

    # 2. 插入可拆解计算指标
    calc_count = 0
    for i, ind in enumerate(CALCULABLE_INDICATORS):
        ind_id = f"calc_{i+1:03d}"
        variables_json = json.dumps(ind["variables"], ensure_ascii=False)
        payload = {
            "id": ind_id,
            "name": ind["name"],
            "calcType": "calculable",
            "coverageType": ind["coverage_type"],
            "liability": ind["liability"],
            "formula": ind["formula"],
            "variables": ind["variables"],
            "note": ind["note"],
            "createdAt": now,
        }
        cur.execute("""
            INSERT INTO indicator_definitions (id, name, calc_type, coverage_type, liability, formula, variables, note, created_at, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (ind_id, ind["name"], "calculable", ind["coverage_type"], ind["liability"],
              ind["formula"], variables_json, ind["note"], now, json.dumps(payload, ensure_ascii=False)))
        calc_count += 1

    # 3. 插入不可拆解直接取值指标
    direct_count = 0
    for i, ind in enumerate(DIRECT_INDICATORS):
        ind_id = f"direct_{i+1:03d}"
        payload = {
            "id": ind_id,
            "name": ind["name"],
            "calcType": "direct",
            "coverageType": ind["coverage_type"],
            "liability": ind["liability"],
            "example": ind["example"],
            "unit": ind["unit"],
            "basis": ind["basis"],
            "dataSource": ind["source"],
            "note": ind["note"],
            "createdAt": now,
        }
        cur.execute("""
            INSERT INTO indicator_definitions (id, name, calc_type, coverage_type, liability, example_value, unit, basis, data_source, note, created_at, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (ind_id, ind["name"], "direct", ind["coverage_type"], ind["liability"],
              ind["example"], ind["unit"], ind["basis"], ind["source"], ind["note"],
              now, json.dumps(payload, ensure_ascii=False)))
        direct_count += 1

    # 4. 写入 state_documents：保单基本字段
    cur.execute("""
        INSERT INTO state_documents (key, payload)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload
    """, ("indicator_base_fields", json.dumps({
        "fields": POLICY_BASE_FIELDS,
        "count": len(POLICY_BASE_FIELDS),
        "updatedAt": now,
    }, ensure_ascii=False)))

    # 5. 写入 state_documents：派生计算变量
    cur.execute("""
        INSERT INTO state_documents (key, payload)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload
    """, ("indicator_derived_vars", json.dumps({
        "variables": DERIVED_VARIABLES,
        "count": len(DERIVED_VARIABLES),
        "updatedAt": now,
    }, ensure_ascii=False)))

    # 6. 写入 state_documents：拆解元数据汇总
    cur.execute("""
        INSERT INTO state_documents (key, payload)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload
    """, ("indicator_decomposition", json.dumps({
        "version": datetime.date.today().isoformat(),
        "updatedAt": now,
        "summary": {
            "baseFields": len(POLICY_BASE_FIELDS),
            "derivedVariables": len(DERIVED_VARIABLES),
            "calculableIndicators": calc_count,
            "directIndicators": direct_count,
            "total": calc_count + direct_count,
        },
        "description": "指标拆解定义：可拆解计算指标可由保单基本字段+条款参数组合计算；不可拆解指标仅从条款直接读取",
    }, ensure_ascii=False)))

    # 7. 更新 app_meta
    cur.execute("""
        INSERT INTO app_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    """, ("indicator_definitions_updated_at", now))

    conn.commit()

    # 验证
    cur.execute("SELECT COUNT(*) FROM indicator_definitions")
    total = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM indicator_definitions WHERE calc_type='calculable'")
    calc_total = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM indicator_definitions WHERE calc_type='direct'")
    direct_total = cur.fetchone()[0]

    conn.close()

    print(f"[indicator-definitions] 已写入 SQLite: {DB_PATH}")
    print(f"  indicator_definitions 表：共 {total} 条")
    print(f"    可拆解计算指标 (calculable): {calc_total} 条")
    print(f"    不可拆解直接取值 (direct):   {direct_total} 条")
    print(f"  state_documents 新增 3 项：")
    print(f"    indicator_base_fields   → {len(POLICY_BASE_FIELDS)} 个保单基本字段")
    print(f"    indicator_derived_vars  → {len(DERIVED_VARIABLES)} 个派生计算变量")
    print(f"    indicator_decomposition → 拆解元数据汇总")


if __name__ == "__main__":
    main()
