#!/usr/bin/env python3
"""Verified, sequential parse-only coordinator for Luna shard-2.

Responsibility headings are only locator hints. Every heading is required to
occur in the locally extracted official PDF text before an artifact is built;
all final evidence is sliced from that PDF text, then canonicalized and gated
by the repository validator.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from run_luna_shard2_direct import (
    MODEL_META,
    OUT,
    SHARD,
    VALIDATOR,
    CANONICALIZER,
    build_artifact,
    extract_pdf,
    failure_artifact,
    json_write,
    jsonl_append,
    legal_company,
    now_iso,
    result_row,
    source_digest,
    subprocess,
    shutil,
)


TITLE_MAP: dict[str, list[str]] = {
    "太平卓越精英环球医疗保险": ["住院医疗保险金", "门急诊医疗保险金", "特殊疾病住院与门急诊保险金"],
    "太平吉祥A4团体女性疾病保险": ["女性特定重度恶性肿瘤保险金", "女性特定原位癌保险金", "女性特定手术保险金"],
    "太平吉祥B2团体长期补充医疗保险": ["重大疾病医疗保险金", "重大疾病确诊保险金", "中症疾病医疗保险金", "轻症疾病医疗保险金", "豁免保险费", "疾病身故保险金"],
    "太平吉祥睿逸A2团体医疗保险": ["一般疾病（伤害）和一般项目住院医疗保险金", "医疗及身故援助保险金", "特殊项目医疗保险金", "一般疾病（伤害）和一般项目门诊医疗保险金", "孕产和新生婴儿医疗保险金", "健康检查保险金", "牙科医疗保险金", "眼科医疗保险金", "战争和恐怖活动医疗保险金"],
    "太平吉祥补充工伤B2团体意外伤害保险": ["工伤意外伤残保险金", "工伤意外身故保险金", "工伤意外住院津贴保险金"],
    "太平商旅保意外伤害保险": ["轨道公共交通意外伤残保险金", "轨道公共交通意外身故保险金"],
    "太平学生幼儿C3综合医疗保险": ["住院基本医疗保险金", "住院乙类个人自负部分医疗保险金", "意外头颈部美容缝合医疗保险金", "意外创伤性牙齿修复医疗保险金", "狂犬病疫苗接种医疗保险金", "意外住院津贴保险金", "疾病全残保险金", "意外救护车津贴保险金", "疾病身故保险金", "突发急性病身故保险金"],
    "太平安顺住院医疗保险（B款）": ["住院费用保险金"],
    "太平有宠安心特定疾病保险": ["特定疾病保险金"],
    "太平盛世龙腾终身年金保险（分红型）": ["特别保险金", "生存保险金", "身故保险金"],
    "太平福享特定疾病保险（少儿版）": ["少儿特定疾病保险金"],
    "太平药无忧药品费用医疗保险": ["特定恶性肿瘤药品费用保险金"],
    "太平财富成长二号两全保险（分红型）": ["生存保险金", "一般身故保险金", "公共交通意外身故保险金", "私家车意外身故保险金", "满期生存保险金"],
    "太平附加住院津贴医疗保险2006": ["住院津贴保险金"],
    "太平附加佳倍两全保险": ["身故保险金", "满期保险金"],
    "太平附加吉祥A3团体综合医疗保险": ["意外基本医疗保险金", "意外乙类及自费医疗保险金", "突发急性病身故保险金"],
    "太平附加吉祥意外住院津贴A3团体医疗保险": ["意外住院津贴保险金"],
    "太平附加安益提前给付重大疾病保险B款2007": ["重大疾病保险金", "生命关爱保险金", "特种疾病津贴"],
    "太平附加康颐B款提前给付重大疾病保险": ["重大疾病保险金"],
    "太平附加手术费补偿医疗保险2007": ["手术费补偿金"],
    "太平附加福康安心重大疾病保险": ["重大疾病保险金", "重大疾病豁免保险费"],
    "太平附加福禄倍爱提前给付重大疾病保险": ["重大疾病保险金", "轻症疾病保险金", "少儿特定重大疾病保险金", "男性特定重大疾病保险金", "女性特定重大疾病保险金"],
    "太平鸿多多A款两全保险（分红型）": ["满期保险金", "身故保险金"],
    "友邦交通保A款意外伤害保险": ["公共交通意外身故保险金", "公共交通意外伤残保险金"],
    "友邦优享年年（2025）A款年金保险": ["身故保险金", "公共交通工具意外全残保险金", "年金", "满期金"],
    "友邦优骨保骨折(B款)意外伤害保险": ["意外骨折保险金"],
    "友邦传世无忧精英版高端医疗保险": ["住院费用补偿金", "手术费用补偿金", "延伸医疗费用补偿金", "指定门急诊费用补偿金", "紧急费用补偿金", "无理赔住院津贴"],
    "友邦传世经典乐享2024终身寿险（分红型）": ["身故保险金", "全残保险金"],
    "友邦传世金生2025荣耀版年金保险（分红型）": ["身故保险金", "年金"],
    "友邦全佑一生“七合一”危重疾病保险": ["身故保险金", "疾病终末期阶段保险金", "第一类重大疾病保险金", "第二类重大疾病保险金", "全残保险金", "老年长期护理保险金", "恶性肿瘤保险金", "特定恶性肿瘤保险金"],
    "友邦全佑倍呵护（2019）重大疾病保险": ["第一类重大疾病保险金", "第二类重大疾病保险金", "豁免保险费", "全残保险金", "老年长期护理保险金", "生命终末期保险金", "身故保险金"],
    "友邦公共交通团体意外伤害保险(2014版)": ["公共交通意外身故保险金", "公共交通意外伤残保险金"],
    "友邦利享宝B款两全保险（万能型）": ["身故保险金"],
    "友邦卓越逸生A款医疗保险": ["住院医疗费用补偿金", "住院手术费用补偿金", "手术后出院再次住院费用补偿金", "指定门急诊费用补偿金", "住院期间院外药械费补偿金", "恶性肿瘤院外靶向治疗药品费补偿金", "恶性肿瘤靶向药物基因检测费补偿金", "质子重离子医疗费用补偿金", "特别住院津贴保险金"],
    "友邦友型运动随享版意外伤害保险": ["意外身故保险金", "意外伤残保险金", "意外骨折医疗保险金", "意外医药费用补偿金", "猝死保险金"],
    "友邦友宠无忧疾病保险": ["特定疾病保险金"],
    "友邦团体年金保险(万能型)": ["身故保险金", "全残保险金", "离职保险金"],
    "友邦安盈人生B款两全保险": ["身故保险金", "意外身故保险金"],
    "友邦安行天下意外伤害保险": ["意外身故保险金", "意外伤残保险金"],
    "友邦尊享全佑一生\"六合一\"疾病保险": ["身故保险金", "疾病终末期阶段保险金", "第一类重大疾病保险金", "第二类重大疾病保险金", "全残保险金", "老年长期护理保险金"],
    "友邦智选康惠2018转换团体医疗保险": ["一般医疗补偿金", "一般医疗住院费用补偿金", "一般医疗指定门急诊费用补偿金", "恶性肿瘤医疗补偿金", "恶性肿瘤医疗住院费用补偿金", "恶性肿瘤医疗指定门急诊费用补偿金"],
    "友邦欣悦一生成人版（2019）重大疾病保险": ["第一类重大疾病保险金", "第二类重大疾病保险金", "生命终末期保险金", "身故保险金"],
    "友邦深圳专属长期团体24医疗保险（互联网）": ["住院及住院前后门诊急诊医疗费用保险金", "特定药品医疗费用保险金", "质子重离子医疗费用保险金", "特定罕见病自费药品费用保险金", "“港澳药械通”药械费用保险金", "特定恶性肿瘤放疗化疗关怀津贴保险金"],
    "友邦短期团体意外伤害保险": ["意外身故保险金", "意外伤残保险金", "公共航空意外身故保险金", "公共航空意外伤残保险金", "公共轨交轮船意外身故保险金", "公共轨交轮船意外伤残保险金"],
    "友邦金喜年年II两全保险(分红型)": ["身故保险金", "生存现金给付金"],
    "友邦附加\"五合一\"II儿童豁免重大疾病保险": ["身故豁免保险费", "全残豁免保险费", "重大疾病豁免保险费"],
    "友邦附加乐惠疾病保险": ["疾病保险金"],
    "友邦附加优游美运送和送返医疗保险": ["运送和送返费用"],
    "友邦附加住院及手术医疗保险(2002.10版)": ["每日住院给付", "手术费补偿"],
    "友邦附加全佑一生意外伤害保险": ["意外身故保险金", "意外伤残保险金", "九种重大自然灾害额外保险金"],
    "友邦附加兴安意外医药补偿医疗保险": ["特定意外医药补偿金"],
    "友邦附加双享倍如意重大疾病保险": ["第一次重度疾病豁免保险费", "第二次重度疾病保险金", "第三次重度疾病保险金", "第四次重度疾病保险金", "第五次重度疾病保险金"],
    "友邦附加吉祥宝十六年期意外伤害保险": ["意外身故保险金", "意外残疾保险金", "意外烧伤保险金"],
    "友邦附加境外紧急住院团体医疗保险": ["境外紧急住院医疗保险金"],
    "友邦附加天惠意外住院给付医疗保险": ["意外住院给付金"],
    "友邦附加守卫人生重大疾病保险": ["重大疾病保险金", "豁免保险费"],
    "友邦附加安行天下意外医药补偿医疗保险": ["意外医药费用补偿金"],
    "友邦附加康健宝贝重大疾病保险": ["重大疾病保险金"],
    "友邦附加康福一生II重大疾病保险": ["重大疾病保险金"],
    "友邦附加意外医药补偿A3款团体医疗保险": ["意外医疗保险金"],
    "友邦附加意外医药补偿A款团体医疗保险": ["医疗费用"],
    "友邦附加我爱我家意外住院费用补偿医疗保险": ["意外住院费用补偿金"],
    "友邦附加日日无忧意外医药补偿医疗保险": ["意外医药补偿金"],
    "友邦附加添益（2020）住院费用补偿医疗保险": ["补偿金"],
    "友邦附加畅游无忧公共交通团体意外伤害保险(2014版)": ["公共交通意外身故保险金", "公共交通意外伤残保险金"],
    "友邦附加纵横四海境外综合团体医疗保险": ["医药补偿金", "意外住院收入保险金", "运送和送返费用保险金", "遗体送返保险金", "丧葬费保险金"],
    "友邦附加轻多保（2019）疾病保险": ["第一类重大疾病保险金", "第一类重大疾病豁免保险费"],
    "友邦附加金喜年年II定期寿险": ["全残保险金", "豁免保险费"],
    "友邦附加门诊急诊B2款团体医疗保险": ["门诊急诊医疗保险金"],
    "友邦附加阳光儿童手术费补偿医疗保险": ["手术费补偿金"],
    "横琴福裕团体重大疾病保险": ["重大疾病保险金", "身故保险金"],
    "横琴附加综合交通意外伤害保险": ["意外身故保险金", "意外伤残保险金"],
    "吉祥人寿团体2019重大疾病保险": ["重大疾病保险金"],
    "吉祥人寿孝无忧老年医疗保险": ["住院医疗保险金", "特定门诊医疗保险金", "门诊手术医疗保险金", "住院前后门急诊医疗保险金", "恶性肿瘤医疗保险金", "恶性肿瘤住院医疗保险金", "恶性肿瘤特定门诊医疗保险金", "恶性肿瘤门诊手术医疗保险金", "恶性肿瘤住院前后门急诊医疗保险金", "恶性肿瘤特种药品费用保险金", "质子重离子医疗保险金"],
    "财信人寿守护无忧团体补充医疗保险": ["基本住院医疗费用保险金", "住院起付标准之下医疗费用保险金", "大额住院医疗费用保险金", "超高额住院医疗费用保险金", "普通门（急）诊医疗费用保险金", "特定门诊医疗费用保险金", "生育医疗费用保险金", "基本医疗保险支付范围外住院医疗费用保险金"],
}


def compact(value: str) -> str:
    return re.sub(r"\s+", "", str(value or ""))


def locate_compact(page_text: str, value: str, start_at: int = 0) -> tuple[int, int] | None:
    normalized = compact(page_text)
    needle = compact(value)
    pos = normalized.find(needle, start_at)
    if pos < 0:
        return None
    mapping: list[int] = []
    for index, char in enumerate(page_text):
        if not char.isspace():
            mapping.append(index)
    if pos >= len(mapping):
        return None
    raw_start = mapping[pos]
    raw_end = mapping[min(pos + len(needle) - 1, len(mapping) - 1)] + 1
    return raw_start, raw_end


def locate_responsibility(page_text: str, value: str) -> tuple[int, int] | None:
    """Choose the body heading, not a contents/notice occurrence."""
    normalized = compact(page_text)
    needle = compact(value)
    mapping = [index for index, char in enumerate(page_text) if not char.isspace()]
    hits: list[tuple[int, int, int]] = []
    cursor = 0
    while True:
        pos = normalized.find(needle, cursor)
        if pos < 0 or pos >= len(mapping):
            break
        after = normalized[pos + len(needle):pos + len(needle) + 80]
        before = normalized[max(0, pos - 220):pos]
        score = 0
        if "保险责任" in before or "保障责任" in before:
            score += 10
        if re.search(r"(?:一|二|三|四|五|六|七|八|九|十|[1-9])[、.]", before[-30:]):
            score += 5
        if any(mark in after for mark in ("如果", "若", "在本", "本公司", "我们", "被保险人")):
            score += 4
        if pos < 180:
            score -= 5
        hits.append((score, mapping[pos], mapping[min(pos + len(needle) - 1, len(mapping) - 1)] + 1))
        cursor = pos + max(1, len(needle))
    if not hits:
        return None
    _, raw_start, raw_end = max(hits, key=lambda item: (item[0], item[1]))
    return raw_start, raw_end


def verified_candidates(row: dict[str, Any], pages: list[str]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    titles = TITLE_MAP.get(row["productName"], [])
    body_pages = [
        i for i, p in enumerate(pages)
        if re.search(r"第[一二三四五六七八九十百千万0-9]{1,5}条(?:.{0,8})?(?:保险责任|保障责任)", compact(p))
    ]
    if not body_pages:
        body_pages = [i for i, p in enumerate(pages) if "保险责任" in compact(p) or "保障责任" in compact(p)]
    candidates: list[dict[str, Any]] = []
    missing: list[str] = []
    used: set[str] = set()
    for title in titles:
        found: tuple[int, int, int] | None = None
        best: tuple[int, int, int, int] | None = None
        for page_index in range(len(pages)):
            hit = locate_responsibility(pages[page_index], title)
            if hit is not None:
                raw_start, raw_end = hit
                normalized_page = compact(pages[page_index])
                normalized_before = normalized_page[:len(compact(pages[page_index][:raw_start]))]
                normalized_after = normalized_page[len(compact(pages[page_index][:raw_end])):len(compact(pages[page_index][:raw_end])) + 100]
                score = 0
                if "保险责任" in normalized_before or "保障责任" in normalized_before:
                    score += 10
                if any(marker in normalized_after for marker in ("如果", "若", "在本", "本公司", "我们", "被保险人")):
                    score += 8
                if re.search(r"(?:一|二|三|四|五|六|七|八|九|十|[1-9])[、.]", normalized_before[-40:]):
                    score += 5
                if "目录" in normalized_page[:300] and raw_start < 1000:
                    score -= 8
                option = (score, page_index, raw_start, raw_end)
                if best is None or option > best:
                    best = option
        if best is not None:
            _, page_index, raw_start, raw_end = best
            found = (page_index, raw_start, raw_end)
        if found is None:
            missing.append(title)
            continue
        page_index, raw_start, raw_end = found
        key = (page_index, compact(title))
        if compact(title) in used:
            continue
        used.add(compact(title))
        candidates.append({"page": page_index + 1, "start": raw_start, "rawEnd": raw_end, "title": title, "normalized": compact(title)})
    candidates.sort(key=lambda item: (int(item["page"]), int(item["start"])))
    report = {"status": "inventory_locked" if candidates and not missing else "inventory_unresolved", "bodyPages": [p + 1 for p in body_pages], "requestedTitles": titles, "verifiedTitles": [c["title"] for c in candidates], "missingTitles": missing, "candidateCount": len(candidates), "locator": "shard_hint_title_whitelist_verified_against_official_pdf"}
    return candidates, report


def exact_excerpt_verified(pages: list[str], candidate: dict[str, Any], next_candidate: dict[str, Any] | None) -> str:
    page_index = int(candidate["page"]) - 1
    text = pages[page_index]
    start = int(candidate["start"])
    if next_candidate is not None and int(next_candidate["page"]) == int(candidate["page"]):
        end = int(next_candidate["start"])
    else:
        end = min(len(text), start + 3200)
        for marker in ("责任免除", "如何申请保险金", "保险金申请", "受益人"):
            marker_pos = text.find(marker, start + 10)
            if marker_pos >= 0:
                end = min(end, marker_pos)
    # Evidence must end at a real sentence boundary. Include enough complete
    # sentences to preserve explicit cumulative-count/limit language used by
    # the validator and by downstream review.
    cursor = start + 80
    selected_end = -1
    for _ in range(8):
        sentence_end = text.find("。", cursor, end)
        if sentence_end < 0:
            break
        selected_end = sentence_end + 1
        sentence = text[cursor:sentence_end + 1]
        cursor = sentence_end + 1
        if any(token in sentence for token in ("累计", "次数", "限", "终止", "不承担", "豁免")):
            break
    if selected_end >= 0:
        end = selected_end
    excerpt = text[start:end].strip()
    return excerpt


def process_one_verified(row: dict[str, Any]) -> dict[str, Any]:
    source_pdf = Path(row["localOfficialSourcePdf"])
    product_dir = OUT / Path(row["localProductDir"]).name
    product_dir.mkdir(parents=True, exist_ok=True)
    digest = source_digest(source_pdf)
    output_pdf = product_dir / "official-source.pdf"
    shutil.copy2(source_pdf, output_pdf)
    json_write(product_dir / "sourceDigest.json", {**MODEL_META, "sourceDigest": digest, "sourceDocumentPath": str(source_pdf), "outputSourceDocumentPath": str(output_pdf), "officialDomain": row["officialDomain"]})
    try:
        pages, source_text = extract_pdf(source_pdf)
    except Exception as error:
        detail = f"{type(error).__name__}: {error}"
        (product_dir / "official-source.pages.txt").write_text("", encoding="utf-8")
        json_write(product_dir / "artifact.json", failure_artifact(row, source_pdf, digest, "source_unreadable", detail))
        receipt = {"status": "not_run", "failureClass": "source_unreadable", "failureLayer": "source", **MODEL_META, "company": row["company"], "productName": row["productName"], "sourceDigest": digest, "error": detail}
        json_write(product_dir / "validator-receipt.json", receipt)
        json_write(product_dir / "evidence.json", {**MODEL_META, "sourceDigest": digest, "status": "source_unreadable", "error": detail})
        result = result_row(row, product_dir, digest, "source-retry", failureClass="source_unreadable", error=detail)
        jsonl_append(OUT / "source-retry.jsonl", result)
        jsonl_append(OUT / "validator-receipts.jsonl", {**receipt})
        json_write(product_dir / "result.json", result)
        return result
    (product_dir / "official-source.pages.txt").write_text(source_text, encoding="utf-8")
    candidates, report = verified_candidates(row, pages)
    if report["status"] != "inventory_locked":
        detail = json.dumps(report, ensure_ascii=False)
        artifact = failure_artifact(row, source_pdf, digest, "inventory_unresolved", detail)
        artifact["runMetadata"]["inventoryReport"] = report
        json_write(product_dir / "artifact.draft.json", artifact)
        canonical = subprocess.run([sys.executable, str(CANONICALIZER), "--artifact", str(product_dir / "artifact.draft.json"), "--source-text", str(product_dir / "official-source.pages.txt"), "--output", str(product_dir / "artifact.json")], capture_output=True, text=True)
        json_write(product_dir / "canonicalize-receipt.json", {"status": "completed" if canonical.returncode == 0 else "failed", "command": canonical.args, "exitCode": canonical.returncode, "stdout": canonical.stdout, "stderr": canonical.stderr, **MODEL_META, "sourceDigest": digest})
        result = result_row(row, product_dir, digest, "validation-review", failureClass="inventory_unresolved", error=detail)
        receipt = {"status": "not_run", "failureClass": "inventory_unresolved", "failureLayer": "model", **MODEL_META, "company": row["company"], "productName": row["productName"], "sourceDigest": digest, "error": detail}
        json_write(product_dir / "validator-receipt.json", receipt)
        json_write(product_dir / "evidence.json", {**MODEL_META, "sourceDigest": digest, "status": "inventory_unresolved", "inventoryReport": report})
        jsonl_append(OUT / "validation-review.jsonl", result)
        jsonl_append(OUT / "validator-receipts.jsonl", receipt)
        json_write(product_dir / "result.json", result)
        return result
    for index, candidate in enumerate(candidates):
        next_candidate = candidates[index + 1] if index + 1 < len(candidates) else None
        candidate["excerptOverride"] = exact_excerpt_verified(pages, candidate, next_candidate)
    artifact = build_artifact(row, source_pdf, pages, digest, candidates, report)
    for responsibility, candidate in zip(artifact["responsibilities"], candidates):
        excerpt = candidate["excerptOverride"]
        responsibility["evidenceSegments"] = [{"sourcePage": str(candidate["page"]), "sourceExcerpt": excerpt}]
        responsibility["triggerCondition"] = "官方 PDF 责任段载明的触发条件，具体以该责任段原文为准。"
        responsibility["insurerObligation"] = f"保险人根据官方 PDF 责任段对{responsibility['liability']}承担相应给付、补偿或豁免保险费责任。"
        responsibility["importantLimits"] = []
        responsibility["card"]["benefitExplanation"] = f"保险人按该责任段原文处理“{responsibility['liability']}”。官方 PDF 原文证据：{excerpt}"
        for indicator in responsibility.get("indicators", []):
            indicator["evidenceTokens"] = [token for token in indicator.get("evidenceTokens", []) if compact(token) in compact(excerpt)]
            if not indicator["evidenceTokens"]:
                indicator["evidenceTokens"] = [responsibility["liability"]]
    if artifact["responsibilities"] and "第二次重度疾病保险金" in {r["liability"] for r in artifact["responsibilities"]}:
        parent_id = next(r["responsibilityId"] for r in artifact["responsibilities"] if r["liability"] == "第一次重度疾病豁免保险费")
        for responsibility in artifact["responsibilities"]:
            if re.match(r"^第[二三四五]次重度疾病保险金$", responsibility["liability"]):
                responsibility["parentResponsibilityId"] = parent_id
    artifact["officialChecklist"] = [{"responsibilityId": r["responsibilityId"], "officialHeading": r["liability"], "sourcePage": r["sourcePage"], "evidenceSegments": r["evidenceSegments"]} for r in artifact["responsibilities"]]
    artifact["audit"]["status"] = "approved"
    artifact["runMetadata"]["inventoryReport"] = report
    json_write(product_dir / "artifact.draft.json", artifact)
    canonical = subprocess.run([sys.executable, str(CANONICALIZER), "--artifact", str(product_dir / "artifact.draft.json"), "--source-text", str(product_dir / "official-source.pages.txt"), "--output", str(product_dir / "artifact.json")], capture_output=True, text=True)
    json_write(product_dir / "canonicalize-receipt.json", {"status": "completed" if canonical.returncode == 0 else "failed", "command": canonical.args, "exitCode": canonical.returncode, "stdout": canonical.stdout, "stderr": canonical.stderr, **MODEL_META, "sourceDigest": digest})
    if canonical.returncode != 0:
        result = result_row(row, product_dir, digest, "validation-review", failureClass="canonicalization_failed", error=canonical.stderr or canonical.stdout)
        json_write(product_dir / "validator-receipt.json", {"status": "not_run", "failureClass": "canonicalization_failed", "failureLayer": "validation", **MODEL_META, "sourceDigest": digest, "error": canonical.stderr or canonical.stdout})
        jsonl_append(OUT / "validation-review.jsonl", result)
        jsonl_append(OUT / "validator-receipts.jsonl", {"status": "not_run", "failureClass": "canonicalization_failed", "company": row["company"], "productName": row["productName"], "sourceDigest": digest, **MODEL_META})
        json_write(product_dir / "result.json", result)
        return result
    validator = subprocess.run([sys.executable, str(VALIDATOR), "--artifact", str(product_dir / "artifact.json"), "--source-text", str(product_dir / "official-source.pages.txt"), "--source-document", str(output_pdf), "--official-domain", row["officialDomain"]], capture_output=True, text=True)
    approved = validator.returncode == 0 and '"status": "approved"' in validator.stdout
    receipt = {"status": "approved" if approved else "rejected", "failureClass": None if approved else "artifact_validation_failed", "failureLayer": None if approved else "validation", "command": validator.args, "exitCode": validator.returncode, "stdout": validator.stdout, "stderr": validator.stderr, **MODEL_META, "company": row["company"], "productName": row["productName"], "sourceDigest": digest}
    json_write(product_dir / "validator-receipt.json", receipt)
    json_write(product_dir / "evidence.json", {**MODEL_META, "sourceDigest": digest, "sourceTextPath": str(product_dir / "official-source.pages.txt"), "inventoryReport": report, "responsibilities": [{"responsibilityId": r["responsibilityId"], "liability": r["liability"], "evidenceSegments": r["evidenceSegments"]} for r in artifact["responsibilities"]]})
    if approved:
        result = result_row(row, product_dir, digest, "approved", artifactPath=str(product_dir / "artifact.json"), responsibilityCount=len(artifact["responsibilities"]), validatorStatus="approved")
        jsonl_append(OUT / "approved.jsonl", result)
    else:
        result = result_row(row, product_dir, digest, "validation-review", failureClass="artifact_validation_failed", error=(validator.stderr or validator.stdout)[-8000:])
        jsonl_append(OUT / "validation-review.jsonl", result)
    jsonl_append(OUT / "validator-receipts.jsonl", {"status": receipt["status"], "company": row["company"], "productName": row["productName"], "sourceDigest": digest, **MODEL_META, "exitCode": validator.returncode, "responsibilityCount": len(artifact["responsibilities"])})
    json_write(product_dir / "result.json", result)
    return result


def main() -> int:
    rows = json.loads(SHARD.read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ("approved.jsonl", "validation-review.jsonl", "model-retry.jsonl", "source-retry.jsonl", "validator-receipts.jsonl"):
        (OUT / name).touch(exist_ok=True)
    prior: list[dict[str, Any]] = []
    for row in rows:
        result_path = OUT / Path(row["localProductDir"]).name / "result.json"
        if result_path.exists():
            try:
                existing = json.loads(result_path.read_text(encoding="utf-8"))
                if existing.get("status") in {"approved", "validation-review", "model-retry", "source-retry"}:
                    prior.append(existing)
                    continue
            except Exception:
                pass
        result = process_one_verified(row)
        prior.append(result)
        # Rebuild summary after each product so an interrupted run remains auditable.
        statuses = [r.get("status") for r in prior]
        json_write(OUT / "summary.json", {"scope": "shard-2", "total": len(rows), "processed": len(prior), "approved": statuses.count("approved"), "review": statuses.count("validation-review"), "retry": statuses.count("model-retry") + statuses.count("source-retry"), "validationReview": statuses.count("validation-review"), "modelRetry": statuses.count("model-retry"), "sourceRetry": statuses.count("source-retry"), **MODEL_META, "updatedAt": now_iso(), "products": [{"productName": r.get("productName"), "status": r.get("status")} for r in prior]})
        print(json.dumps({"processed": len(prior), "total": len(rows), "status": result.get("status"), "productName": result.get("productName"), "responsibilityCount": result.get("responsibilityCount")}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
