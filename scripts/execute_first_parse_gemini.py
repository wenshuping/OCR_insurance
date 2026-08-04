#!/usr/bin/env python3
"""Parse-only Gemini runner for an immutable FIRST_PARSE batch.

The batch manifest is read-only. Each product receives one isolated output
directory, then canonicalization, validator, and importer dry-run gates are
recorded without any database write.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
FAST = ROOT / ".agents/skills/ocr-insurance-fast-responsibility-pipeline"
PIPELINE = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline"
CANONICALIZER = PIPELINE / "scripts/canonicalize_excerpts.py"
VALIDATOR = PIPELINE / "scripts/validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"
MODEL = "gemini-flash-latest"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_jsonl(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def safe_name(value: object) -> str:
    text = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", str(value or ""))
    return re.sub(r"\s+", "-", text).strip(".-")[:120] or "product"


def meta() -> dict[str, Any]:
    return {
        "provider": "gemini",
        "modelId": MODEL,
        "parseOnly": True,
        "databaseWrites": False,
        "sqliteWritten": False,
        "feishuWrites": False,
        "publication": False,
    }


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load_key() -> str:
    value = os.environ.get("GEMINI_API_KEY", "")
    if value:
        return value
    env = ROOT / ".env.local"
    if not env.is_file():
        return ""
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip("\"'")
    return ""


def parse_json(value: str) -> dict[str, Any]:
    text = value.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```$", "", text)
    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ValueError("model response root is not an object")
    return parsed


def prompt_for(row: dict[str, Any], source_text: str, source_digest: str) -> str:
    official_domain = urlparse(row.get("sourceUrl", "")).hostname or ""
    return f"""你是 Gemini 保险责任解析 worker。只处理一个固定产品，不联网、不下载、不换来源。
产品公司：{row.get('company')}
产品名称：{row.get('productName')}
官方 sourceUrl：{row.get('sourceUrl')}
官方域名：{official_domain}
锁定 sourceDigest：{source_digest}

这是已落盘的官方来源分页文本。请完整读取并重建 official inventory，覆盖所有责任、责任免除影响、条件分支、给付表格、数字和公式。每个责任必须和一个 indicator 一一对应；所有 sourceExcerpt/evidenceSegments 必须是下面文本中同页的连续原文，带 sourcePage，不得省略号、拼接页、改写证据。没有足够事实时 calculationEligible=false，不要编造数值。

必须只输出一个 JSON 对象（不要 Markdown 围栏），包含：company、displayCompany、productName、productIdentity、productOverview、productServices、productRules、currentPolicyInputs、optionalGroups、officialOptionalGroupChecklist、officialChecklist、responsibilities、audit、publication。每个 responsibility 必须包含 responsibilityId、liability、groupId、parentResponsibilityId、responsibilityKind、coverageAggregation、selectionStatus、triggerCondition、insurerObligation、importantLimits、ruleRefs、sourcePage、sourceExcerpt、evidenceSegments、card、indicators。每个 indicator 必须包含 indicatorName、formulaText、normalizedFormula、basisKey、calculationKey、calculationStatus、calculationEligible、calculationReason、requiredInputs、ruleRefs、sourcePage、evidenceTokens、basisDefinition、branches、operands、evidenceSegments（适用时）。publication.sqlite=development_required_after_approval，publication.feishu=not_requested，发布关闭。parse-only。

官方分页文本：
{source_text[:180000]}"""


def api_call(prompt: str, key: str) -> tuple[str, dict[str, Any]]:
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }
    request = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={key}",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                body = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))
    parts = body.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    raw = "".join(part.get("text", "") for part in parts)
    return raw, body


def result_row(row: dict[str, Any], product_dir: Path, status: str, source_digest: str | None, **extra: Any) -> dict[str, Any]:
    result = {**meta(), "status": status, "terminalStatus": status, "route": "gemini", "company": row.get("company"), "productName": row.get("productName"), "sourceUrl": row.get("sourceUrl"), "sourceDigest": source_digest, "productDir": str(product_dir), "artifactPath": str(product_dir / "artifact.json") if (product_dir / "artifact.json").is_file() else "", "resultPath": str(product_dir / "result.json")}
    result.update(extra)
    return result


def process(row: dict[str, Any], output: Path, key: str) -> dict[str, Any]:
    source_path = Path(row["sourceTextPath"])
    product_dir = output / "products" / f"{safe_name(row.get('company'))}-{safe_name(row.get('productName'))}-{hashlib.sha256(row.get('dedupKey', '').encode()).hexdigest()[:12]}"
    product_dir.mkdir(parents=True, exist_ok=True)
    source_digest = row.get("sourceDigest")
    try:
        if not source_path.is_file():
            raise FileNotFoundError(str(source_path))
        actual = digest(Path(row["sourceDocumentPath"])) if Path(row.get("sourceDocumentPath", "")).is_file() else None
        if actual and source_digest and actual != source_digest:
            raise ValueError(f"source digest mismatch: expected={source_digest} actual={actual}")
        text = source_path.read_text(encoding="utf-8", errors="replace")
        write_json(product_dir / "sourceDigest.json", {**meta(), "status": "source_ready", "sourceDigest": source_digest, "sourceTextPath": str(source_path), "sourceDocumentPath": row.get("sourceDocumentPath"), "sourceUrl": row.get("sourceUrl")})
        if not key:
            raise RuntimeError("GEMINI_API_KEY unavailable")
        raw, api_body = api_call(prompt_for(row, text, source_digest or ""), key)
        (product_dir / "round-1-raw.txt").write_text(raw, encoding="utf-8")
        write_json(product_dir / "provider-receipt.json", {**meta(), "status": "model_succeeded", "sourceDigest": source_digest, "httpResponseCaptured": True, "rawResponsePath": str(product_dir / "round-1-raw.txt")})
        artifact = parse_json(raw)
        write_json(product_dir / "round-1-raw-artifact.json", artifact)
        canonical_cmd = ["python3", str(CANONICALIZER), "--artifact", str(product_dir / "round-1-raw-artifact.json"), "--source-text", str(source_path), "--output", str(product_dir / "artifact.json")]
        canonical = subprocess.run(canonical_cmd, capture_output=True, text=True, check=False)
        write_json(product_dir / "canonicalize-receipt.json", {**meta(), "sourceDigest": source_digest, "status": "completed" if canonical.returncode == 0 else "failed", "command": canonical_cmd, "exitCode": canonical.returncode, "stdout": canonical.stdout, "stderr": canonical.stderr})
        if canonical.returncode != 0:
            raise ValueError("canonicalizer failed: " + (canonical.stderr or canonical.stdout)[-6000:])
        validator_cmd = ["python3", str(VALIDATOR), "--artifact", str(product_dir / "artifact.json"), "--source-text", str(source_path), "--source-document", str(row.get("sourceDocumentPath", "")), "--official-domain", urlparse(row.get("sourceUrl", "")).hostname or ""]
        validator = subprocess.run(validator_cmd, capture_output=True, text=True, check=False)
        validator_json = {**meta(), "sourceDigest": source_digest, "status": "approved" if validator.returncode == 0 and '"status": "approved"' in validator.stdout else "rejected", "command": validator_cmd, "exitCode": validator.returncode, "stdout": validator.stdout, "stderr": validator.stderr}
        write_json(product_dir / "validator-receipt.json", validator_json)
        if validator_json["status"] != "approved":
            write_json(product_dir / "importer-dry-run-receipt.json", {**meta(), "sourceDigest": source_digest, "status": "not_run", "reason": "validator_not_approved", "sqliteWritten": False})
            result = result_row(row, product_dir, "validation-review", source_digest, failureClass="artifact_validation_failed", error=(validator.stderr or validator.stdout)[-12000:])
            write_json(product_dir / "result.json", result)
            return result
        importer_cmd = ["node", str(IMPORTER), f"--artifacts={product_dir / 'artifact.json'}", f"--db-path={product_dir / 'importer-dry-run.sqlite'}"]
        importer = subprocess.run(importer_cmd, capture_output=True, text=True, check=False)
        importer_result = json.loads(importer.stdout) if importer.returncode == 0 else {}
        importer_receipt = {**meta(), "sourceDigest": source_digest, "command": importer_cmd, "exitCode": importer.returncode, "result": importer_result, "databasePathCreated": (product_dir / "importer-dry-run.sqlite").exists()}
        write_json(product_dir / "importer-dry-run-receipt.json", importer_receipt)
        importer_ok = importer.returncode == 0 and importer_result.get("ok") is True and importer_result.get("dryRun") is True and importer_result.get("validationIssueCount") == 0 and not importer_receipt["databasePathCreated"]
        if not importer_ok:
            result = result_row(row, product_dir, "validation-review", source_digest, failureClass="importer_dry_run_failed", importerResult=importer_result)
            write_json(product_dir / "result.json", result)
            return result
        result = result_row(row, product_dir, "approved", source_digest, responsibilityCount=len(artifact.get("responsibilities", [])), validatorStatus="approved", importerDryRunStatus="passed")
        write_json(product_dir / "result.json", result)
        return result
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError, OSError, RuntimeError) as error:
        failure = "source-retry" if isinstance(error, FileNotFoundError) else "model-retry"
        write_json(product_dir / "provider-receipt.json", {**meta(), "status": failure, "sourceDigest": source_digest, "error": f"{type(error).__name__}: {error}"})
        result = result_row(row, product_dir, failure, source_digest, error=f"{type(error).__name__}: {error}")
        write_json(product_dir / "result.json", result)
        return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    rows = [row for row in manifest["products"] if row.get("route") == "gemini"]
    if not rows:
        raise RuntimeError("manifest has no Gemini rows")
    args.output.mkdir(parents=True, exist_ok=True)
    key = load_key()
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(process, row, args.output, key) for row in rows]
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            results.append(result)
            print(json.dumps({"productName": result.get("productName"), "status": result.get("status")}, ensure_ascii=False), flush=True)
    results.sort(key=lambda value: (value.get("company", ""), value.get("productName", ""), value.get("sourceDigest", "")))
    for result in results:
        append_jsonl(args.output / f"{result['status']}.jsonl", result)
    from collections import Counter
    summary = {**meta(), "status": "completed", "manifest": str(args.manifest), "output": str(args.output), "selected": len(rows), "processed": len(results), "counts": dict(Counter(result.get("status") for result in results)), "products": results}
    write_json(args.output / "summary.json", summary)
    print("SUMMARY " + json.dumps(summary["counts"], ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
