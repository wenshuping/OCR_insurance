#!/usr/bin/env python3
"""
补全遗漏的 19 种指标定义到 indicator_definitions 表
"""
import os
import json
import sqlite3
import datetime

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(PROJECT_ROOT, ".runtime", "policy-ocr.sqlite")

MISSING_INDICATORS = [
    # ── 高频遗漏 ──

    # 医疗赔付比例（通用名称，不区分医保/非医保）
    {"id": "direct_019", "name": "医疗赔付比例（通用）", "calc_type": "direct",
     "coverage_type": "医疗保障", "liability": "医疗赔付比例",
     "formula": None,
     "variables": None,
     "example_value": "80 / 90 / 100", "unit": "%", "basis": "条款约定比例", "data_source": "条款文本",
     "note": "未区分医保/非医保身份的通用赔付比例，与「医保结算赔付比例」「未以医保结算赔付比例」互斥出现"},

    # 满期生存保险金（独立 liability，区别于满期返还）
    {"id": "calc_028", "name": "满期生存保险金", "calc_type": "calculable",
     "coverage_type": "现金流", "liability": "满期生存保险金",
     "formula": "满期生存保险金 = 实际交纳保险费 或 基本保险金额 或 max(二者)",
     "variables": json.dumps([
         {"name": "实际交纳保险费", "source": "首期保费×缴费年限"},
         {"name": "基本保险金额", "source": "amount"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "部分产品 liability 标记为\"满期生存保险金\"而非\"满期返还\"，公式相同"},

    # 特定意外伤残
    {"id": "calc_029", "name": "特定意外伤残保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "特定意外伤残",
     "formula": "特定意外伤残保险金 = 基本保险金额 × 条款约定倍数 × 伤残等级比例",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明(如2倍/3倍)"},
         {"name": "伤残等级比例", "source": "1级100%~10级10%"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "航空/交通等特定意外伤残的额外给付，= 基本保额 × 倍数 × 伤残比例"},

    # 万能账户利率/账户价值
    {"id": "direct_020", "name": "万能账户利率/账户价值", "calc_type": "direct",
     "coverage_type": "现金流", "liability": "万能账户利率/账户价值",
     "formula": None,
     "variables": None,
     "example_value": "2.0% / 2.5% / 3.0%", "unit": "%", "basis": "结算利率/保证利率",
     "data_source": "条款文本",
     "note": "万能账户的保证利率、结算利率、账户价值相关指标，与增额终身寿的\"增额/利率\"区分"},

    # ── 年龄分段变体（身故/全残）──
    {"id": "calc_030", "name": "疾病身故/全残保险金(41岁前)", "calc_type": "calculable",
     "coverage_type": "人寿保障", "liability": "疾病身故/全残(41岁前)",
     "formula": "疾病身故/全残保险金 = 累计已交保险费 × 年龄系数(160%)",
     "variables": json.dumps([
         {"name": "累计已交保险费", "source": "首期保费×已交年度数"},
         {"name": "年龄系数", "source": "条款约定(41岁前=160%)"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "身故/全残按年龄分段给付系数，41岁前通常160%"},

    {"id": "calc_031", "name": "疾病身故/全残保险金(41-61岁)", "calc_type": "calculable",
     "coverage_type": "人寿保障", "liability": "疾病身故/全残(41-61岁)",
     "formula": "疾病身故/全残保险金 = 累计已交保险费 × 年龄系数(140%)",
     "variables": json.dumps([
         {"name": "累计已交保险费", "source": "首期保费×已交年度数"},
         {"name": "年龄系数", "source": "条款约定(41-61岁=140%)"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "身故/全残按年龄分段给付系数，41-61岁通常140%"},

    {"id": "calc_032", "name": "疾病身故/全残保险金(61岁后)", "calc_type": "calculable",
     "coverage_type": "人寿保障", "liability": "疾病身故/全残(61岁后)",
     "formula": "疾病身故/全残保险金 = 累计已交保险费 × 年龄系数(120%)",
     "variables": json.dumps([
         {"name": "累计已交保险费", "source": "首期保费×已交年度数"},
         {"name": "年龄系数", "source": "条款约定(61岁后=120%)"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "身故/全残按年龄分段给付系数，61岁后通常120%"},

    # ── 年龄分段变体（护理金）──
    {"id": "calc_033", "name": "护理金(18岁前)", "calc_type": "calculable",
     "coverage_type": "疾病保障", "liability": "护理金(18岁前)",
     "formula": "护理金 = 累计已交保险费 × 年龄系数 或 基本保险金额 × 比例",
     "variables": json.dumps([
         {"name": "累计已交保险费", "source": "首期保费×已交年度数"},
         {"name": "基本保险金额", "source": "amount"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "护理金按年龄分段，18岁前"},

    {"id": "calc_034", "name": "护理金(18-61岁)", "calc_type": "calculable",
     "coverage_type": "疾病保障", "liability": "护理金(18-61岁)",
     "formula": "护理金 = 累计已交保险费 × 年龄系数 或 基本保险金额 × 比例",
     "variables": json.dumps([
         {"name": "累计已交保险费", "source": "首期保费×已交年度数"},
         {"name": "基本保险金额", "source": "amount"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "护理金按年龄分段，18-61岁"},

    {"id": "calc_035", "name": "护理金(61岁后)", "calc_type": "calculable",
     "coverage_type": "疾病保障", "liability": "护理金(61岁后)",
     "formula": "护理金 = 累计已交保险费 × 年龄系数 或 基本保险金额 × 比例",
     "variables": json.dumps([
         {"name": "累计已交保险费", "source": "首期保费×已交年度数"},
         {"name": "基本保险金额", "source": "amount"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "护理金按年龄分段，61岁后"},

    # ── 特定意外场景细分（各 1 条）──
    {"id": "calc_036", "name": "驾乘意外保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "驾乘意外",
     "formula": "驾乘意外保险金 = 基本保险金额 × 条款约定倍数",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "驾乘特定交通工具意外的额外给付"},

    {"id": "calc_037", "name": "电梯意外保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "电梯意外",
     "formula": "电梯意外保险金 = 基本保险金额 × 条款约定倍数",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "电梯事故的额外给付"},

    {"id": "calc_038", "name": "重大自然灾害保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "重大自然灾害",
     "formula": "重大自然灾害保险金 = 基本保险金额 × 条款约定倍数",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "地震/洪水/台风等重大自然灾害的额外给付"},

    {"id": "calc_039", "name": "高空坠物/抛物意外保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "高空坠物/抛物意外",
     "formula": "高空坠物/抛物意外保险金 = 基本保险金额 × 条款约定倍数",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "高空坠物/抛物意外伤害的额外给付"},

    {"id": "calc_040", "name": "步行/骑行交通意外保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "步行/骑行交通意外",
     "formula": "步行/骑行交通意外保险金 = 基本保险金额 × 条款约定倍数",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "步行或骑行时发生交通事故的额外给付"},

    {"id": "calc_041", "name": "客运轮船/汽车意外保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "客运轮船/汽车意外",
     "formula": "客运轮船/汽车意外保险金 = 基本保险金额 × 条款约定倍数",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "乘坐客运轮船/汽车意外的额外给付"},

    {"id": "calc_042", "name": "客运列车/航空意外保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "客运列车/航空意外",
     "formula": "客运列车/航空意外保险金 = 基本保险金额 × 条款约定倍数",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "乘坐客运列车/航空意外的额外给付"},

    {"id": "calc_043", "name": "公共场所特定事故保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "公共场所特定事故",
     "formula": "公共场所特定事故保险金 = 基本保险金额 × 条款约定倍数",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
         {"name": "条款约定倍数", "source": "条款载明"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "公共场所发生的特定事故（如火灾、踩踏等）的额外给付"},

    {"id": "calc_044", "name": "一般意外身故/全残保险金", "calc_type": "calculable",
     "coverage_type": "意外保障", "liability": "一般意外身故/全残",
     "formula": "一般意外身故/全残保险金 = 基本保险金额",
     "variables": json.dumps([
         {"name": "基本保险金额", "source": "amount"},
     ], ensure_ascii=False),
     "example_value": None, "unit": None, "basis": None, "data_source": None,
     "note": "一般意外（非特定交通/场景）的身故/全残给付"},
]


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    added = 0
    for ind in MISSING_INDICATORS:
        # 检查是否已存在
        cur.execute("SELECT id FROM indicator_definitions WHERE id=?", (ind["id"],))
        if cur.fetchone():
            continue

        payload = {
            "id": ind["id"],
            "name": ind["name"],
            "calcType": ind["calc_type"],
            "coverageType": ind["coverage_type"],
            "liability": ind["liability"],
            "formula": ind.get("formula"),
            "variables": json.loads(ind["variables"]) if ind["variables"] else None,
            "example": ind.get("example_value"),
            "unit": ind.get("unit"),
            "basis": ind.get("basis"),
            "dataSource": ind.get("data_source"),
            "note": ind["note"],
            "createdAt": now,
        }

        cur.execute("""
            INSERT INTO indicator_definitions
                (id, name, calc_type, coverage_type, liability, formula, variables,
                 example_value, unit, basis, data_source, note, created_at, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            ind["id"], ind["name"], ind["calc_type"],
            ind["coverage_type"], ind["liability"],
            ind.get("formula"), ind.get("variables"),
            ind.get("example_value"), ind.get("unit"),
            ind.get("basis"), ind.get("data_source"),
            ind["note"], now,
            json.dumps(payload, ensure_ascii=False),
        ))
        added += 1

    # 更新元数据
    cur.execute("SELECT payload FROM state_documents WHERE key='indicator_decomposition'")
    row = cur.fetchone()
    meta = json.loads(row[0]) if row else {}
    cur.execute("SELECT COUNT(*) FROM indicator_definitions WHERE calc_type='calculable'")
    calc_total = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM indicator_definitions WHERE calc_type='direct'")
    direct_total = cur.fetchone()[0]
    meta["updatedAt"] = now
    meta["summary"] = {
        "baseFields": meta.get("summary", {}).get("baseFields", 12),
        "derivedVariables": meta.get("summary", {}).get("derivedVariables", 10),
        "calculableIndicators": calc_total,
        "directIndicators": direct_total,
        "total": calc_total + direct_total,
    }
    cur.execute("""
        INSERT INTO state_documents (key, payload)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload
    """, ("indicator_decomposition", json.dumps(meta, ensure_ascii=False)))

    cur.execute("""
        INSERT INTO app_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    """, ("indicator_definitions_updated_at", now))

    conn.commit()

    # 验证覆盖率
    cur.execute("SELECT coverage_type, liability FROM indicator_definitions")
    defined = set((r[0], r[1]) for r in cur.fetchall())
    cur.execute("SELECT DISTINCT coverage_type, liability FROM insurance_indicator_records")
    existing = set((r[0], r[1]) for r in cur.fetchall())
    missing = existing - defined
    covered = existing & defined

    conn.close()

    print(f"[indicator-definitions] 补充写入 {added} 条")
    print(f"  indicator_definitions 现有: calculable={calc_total}, direct={direct_total}, 共{calc_total+direct_total} 条")
    print(f"")
    print(f"  覆盖率检查:")
    print(f"    库中指标类型: {len(existing)} 种")
    print(f"    已定义:       {len(defined)} 种")
    print(f"    已覆盖:       {len(covered)} 种 ({len(covered)/len(existing)*100:.0f}%)")
    print(f"    仍遗漏:       {len(missing)} 种")
    if missing:
        for cov, lia in sorted(missing):
            print(f"      ❌ {cov} | {lia}")
    else:
        print(f"    ✅ 全部覆盖！")


if __name__ == "__main__":
    main()
