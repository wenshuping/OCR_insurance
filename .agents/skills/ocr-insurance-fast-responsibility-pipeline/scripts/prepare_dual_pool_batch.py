#!/usr/bin/env python3
"""Prepare disjoint standard-Gemini and complex-Luna batch manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


HEALTH_CATEGORY_PATTERN = re.compile(
    r"医疗|重大疾病|重疾|中症|轻症|疾病保险|恶性肿瘤|癌症"
)

STRONG_COMPLEX_PATTERNS = (
    ("illness_tiers", r"(?:轻症|轻度疾病).{0,300}(?:中症|中度疾病)|(?:中症|中度疾病).{0,300}(?:轻症|轻度疾病)"),
    ("repeated_claims", r"最多给付.{0,20}[二三四五六七八九十0-9]+次|第[二三四五六七八九十]+次.{0,20}保险金|多次给付"),
    ("disease_groups_or_intervals", r"疾病.{0,12}分为.{0,12}组|每组.{0,20}给付|间隔期|间隔.{0,8}(?:日|月|年)"),
    ("numeric_table", r"返还比例表|给付比例表|伤残等级.{0,40}给付比例|给付比例.{0,40}伤残等级"),
)

STRUCTURAL_PATTERNS = (
    ("medical_formula", r"免赔额|赔付比例|补偿原则|第三方.{0,12}(?:支付|补偿)|(?:社会基本医疗保险|基本医疗保险).{0,20}(?:结算|支付)"),
    ("medical_limits", r"分项限额|共享限额|每次.{0,12}限额|年度.{0,12}限额|累计给付.{0,20}限额"),
    ("provider_or_plan_branches", r"指定医疗机构|特需部|国际部|计划[一二三四AB]|有无.{0,8}(?:医保|社保)"),
    ("scheduled_cashflow", r"领取起始日|领取日|每个保单周年日|生存保险金|养老年金|满期保险金"),
    ("schedule_options", r"领取频次|按月领取|按年领取|月领|年领|保证领取|领取方式"),
    ("value_or_growth_formula", r"账户价值|累积生息|交清增额|有效保险金额.{0,20}(?:递增|增长|乘以)|红利.{0,20}(?:购买|累积|领取)"),
    ("max_min_formula", r"下列[二两三四].{0,30}(?:较大者|较小者)|三者.{0,20}(?:较大者|较小者)"),
    ("multiple_formula_branches", r"计算公式|分别按.{0,40}给付|(?:基本保险金额|已交保险费|现金价值).{0,80}[×^]"),
    ("benefit_interactions", r"必选责任|可选责任|不重复给付|仅承担.{0,20}一项|给付.{0,30}后.{0,30}不再承担|豁免保险费"),
)

PRIOR_REVIEW_PATTERN = re.compile(
    r"validation[-_ ]?review|high[-_ ]?capability[-_ ]?review|"
    r"review[-_ ]?required|validation[-_ ]?failure",
    re.IGNORECASE,
)

PRIOR_REVIEW_FIELDS = (
    "validationStatus",
    "reviewStatus",
    "previousStatus",
    "priorStatus",
    "reviewQueue",
)


def product_key(product: dict) -> tuple[str, str, str]:
    return (
        str(product.get("company") or ""),
        str(product.get("productName") or ""),
        str(product.get("sourceUrl") or ""),
    )


def digest_key(product: dict) -> str:
    value = str(product.get("sourceDigest") or "")
    if value:
        return value
    return "sha256:" + hashlib.sha256(
        json.dumps(product_key(product), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def classify(product: dict) -> tuple[str, list[str]]:
    review_evidence = " ".join(str(product.get(field) or "") for field in PRIOR_REVIEW_FIELDS)
    if PRIOR_REVIEW_PATTERN.search(review_evidence):
        return "luna_review", ["prior_review"]

    product_name = str(product.get("productName") or "")
    if HEALTH_CATEGORY_PATTERN.search(product_name):
        return "luna_review", ["medical_or_critical_illness_category"]

    # Non-health product categories are only hints. Their complexity must come
    # from responsibility text or an explicit prior-review receipt.
    evidence = str(product.get("existingResponsibilityHint") or "")
    strong_reasons = [
        name for name, pattern in STRONG_COMPLEX_PATTERNS if re.search(pattern, evidence)
    ]
    if strong_reasons:
        return "luna_review", strong_reasons

    structural_reasons = [
        name for name, pattern in STRUCTURAL_PATTERNS if re.search(pattern, evidence)
    ]
    if len(structural_reasons) >= 2:
        return "luna_review", structural_reasons
    return "standard_gemini", []


def read_json_array(path: Path) -> list[dict]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"expected JSON array: {path}")
    return value


def collect_reserved(paths: list[Path]) -> set[tuple[str, str, str]]:
    return {product_key(item) for path in paths for item in read_json_array(path)}


def collect_completed(root: Path) -> set[tuple[str, str, str]]:
    completed: set[tuple[str, str, str]] = set()
    for result_path in root.rglob("result.json"):
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if result.get("status") in {"approved", "published", "skipped"}:
            completed.add(product_key(result))
    return completed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--reserved-manifest", action="append", type=Path, default=[])
    parser.add_argument("--shards", type=int, default=4)
    parser.add_argument("--per-shard", type=int, default=100)
    args = parser.parse_args()

    if args.shards < 1 or args.per_shard < 1:
        raise ValueError("shards and per-shard must be positive")
    reserved = collect_reserved(args.reserved_manifest)
    completed = collect_completed(args.source_root)
    candidates: list[dict] = []
    seen: set[tuple[str, str, str]] = set()

    manifests = sorted(args.source_root.glob("lane-*/manifests/batch-*.json"))
    for manifest in manifests:
        for product in read_json_array(manifest):
            key = product_key(product)
            if key in seen or key in reserved or key in completed:
                continue
            seen.add(key)
            route, reasons = classify(product)
            enriched = dict(product)
            enriched["route"] = route
            enriched["routeReasons"] = reasons
            enriched["manifestSource"] = str(manifest)
            candidates.append(enriched)
            if len(candidates) >= args.shards * args.per_shard:
                break
        if len(candidates) >= args.shards * args.per_shard:
            break

    required = args.shards * args.per_shard
    if len(candidates) < required:
        raise RuntimeError(f"only {len(candidates)} disjoint candidates available; need {required}")

    args.output_root.mkdir(parents=True, exist_ok=False)
    shards = []
    for index in range(args.shards):
        shard = candidates[index * args.per_shard : (index + 1) * args.per_shard]
        path = args.output_root / f"window-{index + 1}.json"
        path.write_text(json.dumps(shard, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        shards.append({
            "window": index + 1,
            "path": str(path),
            "selected": len(shard),
            "standardGemini": sum(item["route"] == "standard_gemini" for item in shard),
            "lunaReview": sum(item["route"] == "luna_review" for item in shard),
        })

    report = {
        "sourceRoot": str(args.source_root),
        "outputRoot": str(args.output_root),
        "selected": len(candidates),
        "reservedExcluded": len(reserved),
        "completedExcluded": len(completed),
        "shards": shards,
        "routing": "medical and critical-illness categories route to luna_review; other categories require prior review, one strong structural signal, or at least two independent responsibility-structure signals",
    }
    (args.output_root / "routing-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
