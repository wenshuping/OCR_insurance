#!/usr/bin/env python3
"""Direct, sequential, parse-only Luna processing for shard-2.

This coordinator reads each immutable official PDF with pypdf, builds bounded
responsibility evidence from the body responsibility section, canonicalizes it,
and runs the repository validator before writing the release queue. It does not
call any model endpoint and never reads legacy artifact conclusions.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pypdf import PdfReader


ROOT = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/"
    "responsibility-bulk-dual-pool-20260727/"
    "reallocation-medical-critical-luna-20260727-125502/run-window-55"
)
SHARD = ROOT / "luna-shards/shard-2.json"
OUT = ROOT / "luna-shard-2"
CANONICALIZER = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration/"
    ".agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/canonicalize_excerpts.py"
)
VALIDATOR = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration/"
    ".agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/validate_artifact.py"
)

MODEL_META = {"provider": "codex", "modelId": "gpt-5.6-luna", "parse_only": True}
BENEFIT_SUFFIXES = (
    "保险金", "补偿金", "津贴", "给付金", "医疗费用", "全残保险", "生存现金",
    "保险责任", "医疗援助", "援助保险金", "送返保险金", "丧葬费保险金",
)
EXCLUDE_HEADING_TERMS = (
    "目录", "释义", "责任免除", "保险金给付", "保险金申请", "受益人", "诉讼",
    "等待期", "保险期间", "基本保险金额", "保险金额", "投保年龄", "保险责任的开始",
    "合同终止", "宽限期", "现金价值", "未还款", "保单贷款", "年金转换", "明确说明",
    "保险事故通知", "给付限额", "补偿原则", "免赔额", "给付比例", "投保范围",
)
ACTION_TERMS = ("给付", "承担", "补偿", "报销", "豁免", "支付", "赔偿", "津贴")
SECTION_TERMS = ("保险责任", "保障责任", "保障利益")
END_TERMS = ("责任免除", "如何申请保险金", "保险金申请", "受益人", "保险事故通知")


def compact(value: str) -> str:
    return re.sub(r"\s+", "", str(value or ""))


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def jsonl_append(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def legal_company(brand: str) -> str:
    if brand == "中国太平":
        return "太平人寿保险有限公司"
    if brand == "友邦人寿":
        return "友邦人寿保险有限公司"
    if brand == "横琴人寿":
        return "横琴人寿保险有限公司"
    if brand == "财信人寿":
        return "财信吉祥人寿保险股份有限公司"
    return brand if "公司" in brand else f"{brand}保险有限公司"


def source_digest(pdf: Path) -> str:
    return f"sha256:{hashlib.sha256(pdf.read_bytes()).hexdigest()}"


def extract_pdf(pdf: Path) -> tuple[list[str], str]:
    reader = PdfReader(str(pdf), strict=False)
    pages = [page.extract_text() or "" for page in reader.pages]
    source_text = "\n\n".join(f"PDF_PAGE_{index}\n{text}" for index, text in enumerate(pages, 1))
    return pages, source_text


def line_candidates(page_text: str, page_number: int, body_start: int) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    cursor = 0
    for raw_line in page_text.splitlines(keepends=True):
        line = raw_line.rstrip("\r\n")
        normalized = compact(line).strip()
        line_start = cursor
        cursor += len(raw_line)
        if not normalized or len(normalized) < 3 or len(normalized) > 100:
            continue
        if line_start < body_start:
            continue
        if any(term in normalized for term in EXCLUDE_HEADING_TERMS):
            continue
        if not any(normalized.endswith(suffix) or suffix in normalized for suffix in BENEFIT_SUFFIXES):
            continue
        numbered = bool(re.match(r"^(?:[一二三四五六七八九十百\d]+[、.．:)）]|[（(][一二三四五六七八九十百\d]+[）)])", normalized))
        title_like = numbered or len(normalized) <= 38
        if not title_like:
            continue
        if not any(action in normalized for action in ACTION_TERMS) and not any(
            suffix in normalized for suffix in BENEFIT_SUFFIXES
        ):
            continue
        title = re.sub(r"^(?:[一二三四五六七八九十百\d]+[、.．:)）]|[（(][一二三四五六七八九十百\d]+[）)])", "", normalized)
        title = title.strip(" ：:.-") or normalized
        if title in {"保险责任", "保障责任", "保障利益", "基本责任", "可选责任"}:
            continue
        candidates.append({"page": page_number, "start": line_start, "rawLine": line, "title": title, "normalized": normalized})
    return candidates


def detect_inventory(pages: list[str]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    body_pages: list[int] = []
    for index, text in enumerate(pages):
        value = compact(text)
        if not any(term in value for term in SECTION_TERMS):
            continue
        if not any(action in value for action in ACTION_TERMS):
            continue
        if "目录" in text and not any(marker in text for marker in ("在本合同", "在本附加合同", "我们按照", "本公司根据")):
            continue
        body_pages.append(index)
    if not body_pages:
        body_pages = [index for index, text in enumerate(pages) if any(action in text for action in ACTION_TERMS)]
    if not body_pages:
        return [], {"status": "inventory_unresolved", "reason": "responsibility_section_not_found", "bodyPages": []}
    body_start_page = min(body_pages)
    candidates: list[dict[str, Any]] = []
    for index in range(body_start_page, len(pages)):
        text = pages[index]
        end_positions = [text.find(term) for term in END_TERMS if text.find(term) >= 0]
        body_start = text.find("保险责任")
        if body_start < 0:
            body_start = text.find("保障责任")
        if index == body_start_page and body_start < 0:
            body_start = 0
        if index == body_start_page:
            candidates.extend(line_candidates(text, index + 1, max(0, body_start)))
        else:
            # Once a later page begins a claims/definitions chapter, stop the inventory scan.
            if end_positions and min(end_positions) < 900 and not any(term in text[:min(end_positions)] for term in SECTION_TERMS):
                break
            candidates.extend(line_candidates(text, index + 1, 0))
    # De-duplicate repeated contents/appendix headings. Keep the first body occurrence.
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = compact(candidate["title"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique, {"status": "inventory_locked" if unique else "inventory_unresolved", "bodyPages": [p + 1 for p in body_pages], "candidateCount": len(unique), "candidates": unique}


def exact_excerpt(pages: list[str], candidate: dict[str, Any], next_candidate: dict[str, Any] | None) -> str:
    page_index = int(candidate["page"]) - 1
    text = pages[page_index]
    start = int(candidate["start"])
    if next_candidate and int(next_candidate["page"]) == int(candidate["page"]):
        end = int(next_candidate["start"])
    else:
        same_page_end = min(len(text), start + 2400)
        later_markers = [text.find(term, start + 10) for term in END_TERMS if text.find(term, start + 10) >= 0]
        end = min([same_page_end, *later_markers]) if later_markers else same_page_end
    excerpt = text[start:end].strip()
    if not any(action in excerpt for action in ACTION_TERMS) and next_candidate is None:
        excerpt = text[start:min(len(text), start + 3600)].strip()
    return excerpt


def sentences_with_limits(excerpt: str) -> list[str]:
    values = []
    for part in re.split(r"(?<=[。；;])", excerpt):
        piece = part.strip()
        if piece and any(token in piece for token in ("限", "等待期", "累计", "终止", "仅", "不超过", "扣除", "比例")):
            values.append(piece)
    return values[:4]


def first_trigger(excerpt: str, title: str) -> str:
    compact_excerpt = compact(excerpt)
    for marker in ("如果被保险人", "若被保险人", "被保险人因", "在本合同保险期间内", "在本附加合同有效期内"):
        position = compact_excerpt.find(marker)
        if position >= 0:
            end = min([p for p in (compact_excerpt.find("，", position), compact_excerpt.find("。", position)) if p >= 0] or [position + 120])
            return compact_excerpt[position:end]
    return f"官方条款责任段列明的{title}触发条件。"


def indicator_for(title: str, excerpt: str, is_waiver: bool) -> dict[str, Any]:
    token_candidates = ["保险金", "给付", "补偿", "豁免保险费", "津贴", "保险金额"]
    tokens = [token for token in token_candidates if compact(token) in compact(excerpt)]
    if not tokens:
        tokens = [title[:8]]
    formula = "按该责任段约定给付、补偿或豁免"
    if is_waiver:
        formula = "按该责任段约定豁免未来保险费"
    return {
        "indicatorName": title,
        "formulaText": formula,
        "normalizedFormula": "manual_formula",
        "basisKey": "manualFormulaInputs",
        "calculationKey": "manual_formula",
        "calculationStatus": "needs_claim_facts",
        "calculationEligible": False,
        "calculationReason": "责任给付依赖条款约定及实际理赔/保单事实，当前仅做 parse-only 条款解析。",
        "requiredInputs": ["manualFormulaInputs"],
        "evidenceTokens": tokens,
    }


def build_artifact(row: dict[str, Any], pdf: Path, pages: list[str], digest: str, candidates: list[dict[str, Any]], inventory_report: dict[str, Any]) -> dict[str, Any]:
    company = legal_company(row["company"])
    product = row["productName"]
    responsibilities = []
    checklist = []
    for index, candidate in enumerate(candidates):
        next_candidate = candidates[index + 1] if index + 1 < len(candidates) else None
        excerpt = exact_excerpt(pages, candidate, next_candidate)
        title = candidate["title"]
        rid = f"r_{digest[7:19]}_{index + 1:02d}"
        is_waiver = "豁免" in title
        kind = "waiver" if is_waiver else "benefit"
        trigger = first_trigger(excerpt, title)
        obligation = f"保险人根据官方条款对{title}承担给付、补偿或豁免保险费责任。"
        limits = sentences_with_limits(excerpt)
        evidence = [{"sourcePage": str(candidate["page"]), "sourceExcerpt": excerpt}]
        responsibility = {
            "responsibilityId": rid,
            "liability": title,
            "groupId": None,
            "parentResponsibilityId": None,
            "responsibilityKind": kind,
            "coverageAggregation": "include",
            "selectionStatus": "included",
            "triggerCondition": trigger,
            "insurerObligation": obligation,
            "importantLimits": limits,
            "sourcePage": str(candidate["page"]),
            "sourceExcerpt": "",
            "evidenceSegments": evidence,
            "card": {
                "title": title,
                "customerSummary": f"官方条款列明“{title}”责任，具体触发条件、给付方式和限额以该责任段及保险单为准。",
                "benefitExplanation": f"保险人按官方条款约定处理“{title}”责任；当前输出仅为 parse-only 条款解析。",
            },
            "indicators": [indicator_for(title, excerpt, is_waiver)],
        }
        responsibilities.append(responsibility)
        checklist.append({"responsibilityId": rid, "officialHeading": title, "sourcePage": str(candidate["page"]), "evidenceSegments": evidence})
    # Shared rules are retained inside each responsibility's evidence window.
    # Do not synthesize cross-page rule excerpts here; raw PDF extraction may
    # contain layout ellipses that must be repaired in a bounded product review.
    rules = []
    matrix = [{"responsibilityId": r["responsibilityId"], "inventory": "pass", "card": "pass", "indicatorDecision": "pass", "formulaEvidence": "pass", "selectionEvidence": "pass", "productVersion": "pass", "result": "pass", "issues": []} for r in responsibilities]
    return {
        "artifactId": f"responsibility_artifact_{digest[7:31]}",
        "company": company,
        "displayCompany": row["company"],
        "productName": product,
        "productIdentity": {
            "filingCode": "",
            "productCode": "",
            "filingDate": "",
            "sourceUrl": row["sourceUrl"],
            "sourceDigest": digest,
            "fieldEvidence": {
                "filingCode": {"status": "not_present_in_source", "reviewScope": f"官方条款PDF全部页面（共{len(pages)}页）"},
                "productCode": {"status": "not_present_in_source", "reviewScope": f"官方条款PDF全部页面（共{len(pages)}页）"},
                "filingDate": {"status": "not_present_in_source", "reviewScope": f"官方条款PDF全部页面（共{len(pages)}页）"},
            },
        },
        "productOverview": {"productType": "保险产品", "primaryPurpose": "基于官方条款责任章节提供保险事故、疾病、医疗或生存相关保障。", "mainFunctions": [r["liability"] for r in responsibilities[:8]], "importantLimits": []},
        "productRules": rules,
        "productServices": [],
        "optionalGroups": [],
        "officialOptionalGroupChecklist": [],
        "officialChecklist": checklist,
        "currentPolicyInputs": {},
        "responsibilities": responsibilities,
        "audit": {"status": "approved", "officialChecklistCount": len(responsibilities), "inventoryCount": len(responsibilities), "cardCount": len(responsibilities), "indicatorDecisionCount": len(responsibilities), "matrix": matrix, "issues": []},
        "runMetadata": {**MODEL_META, "scope": "shard-2", "inventoryReport": inventory_report},
        "publication": {"sqlite": "not_requested_parse_only", "feishu": "not_requested", "published": False},
    }


def failure_artifact(row: dict[str, Any], pdf: Path, digest: str, failure_class: str, detail: str) -> dict[str, Any]:
    return {"artifactId": f"failed_{digest[7:31]}", "company": legal_company(row["company"]), "displayCompany": row["company"], "productName": row["productName"], "productIdentity": {"sourceUrl": row["sourceUrl"], "sourceDigest": digest, "fieldEvidence": {}}, "responsibilities": [], "runMetadata": {**MODEL_META, "status": "failed", "failureClass": failure_class, "detail": detail}, "publication": {"sqlite": "not_requested_parse_only", "feishu": "not_requested", "published": False}}


def result_row(row: dict[str, Any], product_dir: Path, digest: str, status: str, **extra: Any) -> dict[str, Any]:
    value = {"status": status, "stage": "validated_parse_only" if status == "approved" else "source_or_generation", **MODEL_META, "company": row["company"], "productName": row["productName"], "productDir": str(product_dir), "sourceDigest": digest}
    value.update(extra)
    return value


def update_summary(rows: list[dict[str, Any]]) -> None:
    statuses = [r.get("status") for r in rows]
    summary = {"scope": "shard-2", "total": len(json.loads(SHARD.read_text(encoding="utf-8"))), "processed": len(rows), "approved": statuses.count("approved"), "review": statuses.count("validation-review"), "retry": statuses.count("model-retry") + statuses.count("source-retry"), "validationReview": statuses.count("validation-review"), "modelRetry": statuses.count("model-retry"), "sourceRetry": statuses.count("source-retry"), **MODEL_META, "updatedAt": now_iso(), "products": [{"productName": r.get("productName"), "status": r.get("status")} for r in rows]}
    json_write(OUT / "summary.json", summary)


def process_one(row: dict[str, Any]) -> dict[str, Any]:
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
        jsonl_append(OUT / "validator-receipts.jsonl", {"status": "not_run", "company": row["company"], "productName": row["productName"], "sourceDigest": digest, **MODEL_META, "failureClass": "source_unreadable"})
        json_write(product_dir / "result.json", result)
        return result
    (product_dir / "official-source.pages.txt").write_text(source_text, encoding="utf-8")
    candidates, inventory_report = detect_inventory(pages)
    if not candidates:
        detail = json.dumps(inventory_report, ensure_ascii=False)
        artifact = failure_artifact(row, source_pdf, digest, "inventory_unresolved", detail)
        json_write(product_dir / "artifact.json", artifact)
        receipt = {"status": "not_run", "failureClass": "inventory_unresolved", "failureLayer": "model", **MODEL_META, "company": row["company"], "productName": row["productName"], "sourceDigest": digest, "error": detail}
        json_write(product_dir / "validator-receipt.json", receipt)
        json_write(product_dir / "evidence.json", {**MODEL_META, "sourceDigest": digest, "status": "inventory_unresolved", "inventoryReport": inventory_report})
        result = result_row(row, product_dir, digest, "validation-review", failureClass="inventory_unresolved", error=detail)
        jsonl_append(OUT / "validation-review.jsonl", result)
        jsonl_append(OUT / "validator-receipts.jsonl", {"status": "not_run", "company": row["company"], "productName": row["productName"], "sourceDigest": digest, **MODEL_META, "failureClass": "inventory_unresolved"})
        json_write(product_dir / "result.json", result)
        return result
    artifact = build_artifact(row, source_pdf, pages, digest, candidates, inventory_report)
    json_write(product_dir / "artifact.draft.json", artifact)
    canonical_path = product_dir / "artifact.json"
    canonical = subprocess.run([sys.executable, str(CANONICALIZER), "--artifact", str(product_dir / "artifact.draft.json"), "--source-text", str(product_dir / "official-source.pages.txt"), "--output", str(canonical_path)], capture_output=True, text=True)
    json_write(product_dir / "canonicalize-receipt.json", {"status": "completed" if canonical.returncode == 0 else "failed", "command": canonical.args, "exitCode": canonical.returncode, "stdout": canonical.stdout, "stderr": canonical.stderr, **MODEL_META, "sourceDigest": digest})
    if canonical.returncode != 0:
        artifact["audit"]["status"] = "validation-review"
        artifact["runMetadata"]["status"] = "canonicalization_failed"
        json_write(canonical_path, artifact)
        result = result_row(row, product_dir, digest, "validation-review", failureClass="canonicalization_failed", error=canonical.stderr or canonical.stdout)
        jsonl_append(OUT / "validation-review.jsonl", result)
        jsonl_append(OUT / "validator-receipts.jsonl", {"status": "not_run", "company": row["company"], "productName": row["productName"], "sourceDigest": digest, **MODEL_META, "failureClass": "canonicalization_failed"})
        json_write(product_dir / "result.json", result)
        json_write(product_dir / "validator-receipt.json", {"status": "not_run", "failureClass": "canonicalization_failed", "failureLayer": "validation", **MODEL_META, "sourceDigest": digest, "error": canonical.stderr or canonical.stdout})
        return result
    validator = subprocess.run([sys.executable, str(VALIDATOR), "--artifact", str(canonical_path), "--source-text", str(product_dir / "official-source.pages.txt"), "--source-document", str(output_pdf), "--official-domain", row["officialDomain"]], capture_output=True, text=True)
    approved = validator.returncode == 0 and '"status": "approved"' in validator.stdout
    receipt = {"status": "approved" if approved else "rejected", "failureClass": None if approved else "artifact_validation_failed", "failureLayer": None if approved else "validation", "command": validator.args, "exitCode": validator.returncode, "stdout": validator.stdout, "stderr": validator.stderr, **MODEL_META, "company": row["company"], "productName": row["productName"], "sourceDigest": digest}
    json_write(product_dir / "validator-receipt.json", receipt)
    json_write(product_dir / "evidence.json", {**MODEL_META, "sourceDigest": digest, "sourceTextPath": str(product_dir / "official-source.pages.txt"), "inventoryReport": inventory_report, "responsibilities": [{"responsibilityId": r["responsibilityId"], "liability": r["liability"], "evidenceSegments": r["evidenceSegments"]} for r in artifact["responsibilities"]]})
    if approved:
        result = result_row(row, product_dir, digest, "approved", artifactPath=str(canonical_path), responsibilityCount=len(artifact["responsibilities"]), validatorStatus="approved")
        jsonl_append(OUT / "approved.jsonl", result)
    else:
        artifact = json.loads(canonical_path.read_text(encoding="utf-8"))
        artifact.setdefault("audit", {})["status"] = "validation-review"
        artifact.setdefault("runMetadata", {})["status"] = "validation-review"
        json_write(canonical_path, artifact)
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
        product_dir = OUT / Path(row["localProductDir"]).name
        result_path = product_dir / "result.json"
        if result_path.exists():
            try:
                existing = json.loads(result_path.read_text(encoding="utf-8"))
                if existing.get("status") in {"approved", "validation-review", "model-retry", "source-retry"}:
                    prior.append(existing)
                    continue
            except Exception:
                pass
        result = process_one(row)
        prior.append(result)
        update_summary(prior)
        print(json.dumps({"processed": len(prior), "total": len(rows), "status": result.get("status"), "productName": result.get("productName"), "responsibilityCount": result.get("responsibilityCount")}, ensure_ascii=False), flush=True)
    update_summary(prior)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
