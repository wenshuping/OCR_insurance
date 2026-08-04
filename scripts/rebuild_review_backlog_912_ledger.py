#!/usr/bin/env python3
"""Rebuild REVIEW_BACKLOG_912 from the handoff's authoritative inputs.

This is a read-only audit of manifests, status queues, and (optionally) the
development responsibility-artifact table.  It deliberately does not call a
model or write SQLite, Feishu, or product artifacts.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")

MANIFEST_PATTERNS = [
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-resume-4windows-20260726/manifests/window11.json",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-resume-4windows-20260726/manifests/window22.json",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-resume-4windows-20260726/manifests/window33.json",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-resume-4windows-20260726/manifests/window55.json",
    "artifacts/responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/window-{1,2,3,4}.json",
    "artifacts/responsibility-bulk-dual-pool-20260727/health-critical-fresh-window-5-20260727/manifest.json",
    "artifacts/responsibility-bulk-dual-pool-20260727/next-wave-600-20260727-20260727-203421/window-next-{1,2,4}.json",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-20260726/selected-manifest.json",
    "artifacts/responsibility-402-retry-2windows-20260724-181650/window-{1,2}/manifests/batch-{001,002,003,004,005,006}.json",
    "artifacts/fast-responsibility-requested7-20260726-124058/manifest.json",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/soochow-responsibility-parse-window55-20260726T120810Z/manifest-all.json",
    "artifacts/fosun-prudential-fubaodekang-b-source-manifest-20260725.json",
]

STATUS_ROOTS = [
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-resume-4windows-20260726/runs/window11",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-resume-4windows-20260726/runs/window22",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-resume-4windows-20260726/runs/window33",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-resume-4windows-20260726/runs/window55",
    "artifacts/responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/run-window-11",
    "artifacts/responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/run-window-2-coordinator-20260727",
    "artifacts/responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/run-window-3-33-20260727/final-200-summary-1",
    "artifacts/responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/run-window-4-v2-reconcile-20260727",
    "artifacts/responsibility-bulk-dual-pool-20260727/health-critical-fresh-window-5-20260727/run/shard-1",
    "artifacts/responsibility-bulk-dual-pool-20260727/health-critical-fresh-window-5-20260727/run/shard-2",
    "artifacts/responsibility-bulk-dual-pool-20260727/health-critical-fresh-window-5-20260727/run/shard-3",
    "artifacts/responsibility-bulk-dual-pool-20260727/health-critical-fresh-window-5-20260727/run/shard-4",
    "artifacts/responsibility-bulk-dual-pool-20260727/next-wave-600-20260727-20260727-203421/run-window-next-1",
    "artifacts/source-canary-next-wave-600-20260727",
    "artifacts/source-repair-next-wave-600-remaining82-20260727-final/next-wave-standard-gemini-80-20260728-071056",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/selective-gemini-238-20260726",
    "artifacts/responsibility-402-retry-2windows-20260724-181650/window-1/runs",
    "artifacts/responsibility-402-retry-2windows-20260724-181650/window-2/runs",
    "artifacts/fast-responsibility-requested7-20260726-124058/run",
    "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/soochow-responsibility-parse-window55-20260726T120810Z",
    "artifacts/responsibility-bulk-dual-pool-20260727-125502/reallocation-medical-critical-luna-20260727-125502",
]

QUEUE_NAMES = {
    "approved.jsonl": "approved",
    "published.jsonl": "approved",
    "validation-review.jsonl": "validation-review",
    "model-retry.jsonl": "model-retry",
    "source-retry.jsonl": "source-retry",
    "manual-review.jsonl": "manual-review",
    "skipped.jsonl": "skipped",
    "skipped-existing.jsonl": "skipped",
}
STATUS_RANK = {
    "unprocessed": 0,
    "skipped": 1,
    "manual-review": 2,
    "source-retry": 3,
    "model-retry": 4,
    "validation-review": 5,
    "approved": 6,
}


def norm_text(value: object) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip().lower()


def norm_url(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if "//" not in raw:
        raw = "https://" + raw
    parts = urlsplit(raw)
    host = (parts.netloc or "").lower().rstrip(".")
    path = unquote(parts.path or "/").rstrip("/") or "/"
    return f"{host}{path}"


def identity(row: dict) -> tuple[str, str]:
    url = row.get("normalizedSourceUrl") or row.get("sourceUrl") or row.get("officialUrl")
    canonical_url = norm_url(url)
    if canonical_url:
        return "url", canonical_url
    return "name", f"{norm_text(row.get('company'))}::{norm_text(row.get('productName'))}"


def digest(row: dict) -> str:
    return str(row.get("sourceDigest") or row.get("sourceFileDigest") or "").strip()


def expand(pattern: str) -> list[Path]:
    patterns = [pattern]
    while True:
        next_patterns = []
        changed = False
        for current in patterns:
            match = re.search(r"\{([^{}]+)\}", current)
            if not match:
                next_patterns.append(current)
                continue
            changed = True
            next_patterns.extend(current[: match.start()] + value + current[match.end() :] for value in match.group(1).split(","))
        patterns = next_patterns
        if not changed:
            break
    paths = []
    for expanded in patterns:
        paths.extend(Path(p) for p in glob.glob(str(ROOT / expanded)))
    return sorted({p.resolve() for p in paths if p.is_file()})


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def product_rows(path: Path) -> list[dict]:
    value = load_json(path)
    if isinstance(value, list):
        return [x for x in value if isinstance(x, dict)]
    if not isinstance(value, dict):
        return []
    for key in ("manifestProducts", "products", "selectedProducts", "items", "rows"):
        if isinstance(value.get(key), list):
            return [x for x in value[key] if isinstance(x, dict)]
    if value.get("company") and value.get("productName"):
        return [value]
    numeric = [v for k, v in value.items() if str(k).isdigit() and isinstance(v, dict)]
    return numeric


def excluded_path(path: Path) -> bool:
    text = str(path)
    return any(token in text for token in (".staging.", "aborted", "gap-runs", "stopped_before_model_work", "resume-auth-recovered", "dianjin-", "shadow-", "dry-run", "importer"))


def queue_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    # The handoff explicitly makes these two roots top-level-only.  In
    # particular, the 238 tree contains a large product-artifact subtree.
    if "selective-gemini-238-20260726" in str(root) or "soochow-responsibility-parse-window55" in str(root):
        return sorted({p for p in root.glob("*.jsonl") if p.name in QUEUE_NAMES and not excluded_path(p)})
    # Other authoritative final roots contain bounded route/batch levels, but
    # must not recurse into product directories or excluded historical runs.
    candidates = list(root.glob("*.jsonl"))
    for pattern in ("*/*.jsonl", "*/*/*.jsonl"):
        candidates.extend(root.glob(pattern))
    return sorted({p for p in candidates if p.name in QUEUE_NAMES and not excluded_path(p)})


def queue_rows(path: Path):
    """Yield queue rows without materializing a potentially large JSONL file."""
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for index, line in enumerate(handle):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                yield {"_parseError": str(exc), "_line": index + 1}
                continue
            if isinstance(value, dict):
                yield value


def row_identity(row: dict) -> tuple[str, str] | None:
    if not row.get("company") and not row.get("productName") and not row.get("sourceUrl") and not row.get("normalizedSourceUrl"):
        return None
    return identity(row)


def sqlite_products(db_path: Path) -> tuple[set[tuple[str, str]], dict]:
    result: set[tuple[str, str]] = set()
    meta = {"status": "not_attempted", "rowCount": 0}
    if not db_path.exists():
        meta["status"] = "missing"
        return result, meta
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1)
        con.execute("PRAGMA query_only=ON")
        rows = con.execute("SELECT company, product_name, source_digest, source_url FROM product_responsibility_artifacts").fetchall()
        for company, product_name, source_digest, source_url in rows:
            result.add(identity({"company": company, "productName": product_name, "sourceUrl": source_url, "sourceDigest": source_digest}))
        con.close()
        meta.update(status="ok", rowCount=len(rows))
    except Exception as exc:
        meta.update(status="error", error=str(exc))
    return result, meta


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--db-path", type=Path, default=ROOT / ".runtime/local/policy-ocr.sqlite")
    parser.add_argument("--read-db", action="store_true", help="Optional read-only DB comparison; not part of authoritative status reconstruction")
    args = parser.parse_args()
    out = args.output_dir.resolve()
    if out.exists():
        raise SystemExit(f"immutable output already exists: {out}")
    out.mkdir(parents=True)

    manifest_paths = []
    for pattern in MANIFEST_PATTERNS:
        manifest_paths.extend(expand(pattern))
    manifest_paths = sorted(set(manifest_paths))
    products: dict[tuple[str, str], dict] = {}
    manifest_counts = {}
    manifest_conflicts = []
    for path in manifest_paths:
        rows = product_rows(path)
        manifest_counts[str(path)] = len(rows)
        for index, row in enumerate(rows):
            key = identity(row)
            record = {"inputPath": str(path), "inputIndex": index, "company": row.get("company"), "productName": row.get("productName"), "sourceUrl": row.get("sourceUrl"), "normalizedSourceUrl": row.get("normalizedSourceUrl"), "sourceDigest": digest(row), "dedupKey": f"{key[0]}:{key[1]}", "manifestRow": row}
            if key in products:
                previous = products[key]
                if previous.get("sourceDigest") and record.get("sourceDigest") and previous["sourceDigest"] != record["sourceDigest"]:
                    manifest_conflicts.append({"dedupKey": record["dedupKey"], "left": previous, "right": record})
                products[key].setdefault("manifestInputs", []).append({"inputPath": str(path), "inputIndex": index, "sourceDigest": record["sourceDigest"]})
            else:
                record["manifestInputs"] = [{"inputPath": str(path), "inputIndex": index, "sourceDigest": record["sourceDigest"]}]
                products[key] = record

    observations: dict[tuple[str, str], list[dict]] = defaultdict(list)
    queue_counts = Counter()
    missing_status_roots = []
    for root_rel in STATUS_ROOTS:
        root = (ROOT / root_rel).resolve()
        if not root.exists():
            missing_status_roots.append(str(root))
            continue
        for path in queue_files(root):
            status = QUEUE_NAMES[path.name]
            queue_counts[f"{status}:files"] += 1
            for line_index, row in enumerate(queue_rows(path)):
                queue_counts[f"{status}:rows"] += 1
                key = row_identity(row)
                if key is None:
                    continue
                if key not in products:
                    continue
                raw_status = str(row.get("status") or row.get("terminalStatus") or status)
                classification_text = " ".join(
                    str(row.get(field) or "")
                    for field in ("status", "terminalStatus", "failureClass", "failureLayer", "stage", "primaryBucket", "error")
                ).lower()
                ambiguous = status == "manual-review" and "source_or_model" in classification_text
                observations[key].append({"status": status, "rawStatus": raw_status, "inputPath": str(path), "line": line_index + 1, "sourceDigest": digest(row), "sourceUrl": row.get("sourceUrl"), "artifactPath": row.get("artifactPath") or row.get("mainResult", {}).get("artifactPath"), "resultPath": row.get("resultPath") or row.get("mainResult", {}).get("resultPath"), "ambiguousSourceOrModel": ambiguous, "row": row})

    # The handoff defines the ledger from the listed manifests/status roots.
    # SQLite is deliberately opt-in so parse-only reconstruction cannot block
    # on a large live development database or use it as an unlisted status root.
    if args.read_db:
        db_keys, db_meta = sqlite_products(args.db_path.resolve())
    else:
        db_keys, db_meta = set(), {"status": "skipped_by_parse_only_policy", "rowCount": 0}
    ledger = []
    for key, product in sorted(products.items(), key=lambda item: item[1].get("dedupKey", "")):
        obs = observations.get(key, [])
        best = max(obs, key=lambda x: (STATUS_RANK[x["status"]], x["inputPath"], x["line"]), default=None)
        status = best["status"] if best else "unprocessed"
        if key in db_keys and status != "approved":
            status = "approved"
        ambiguous = any(x["ambiguousSourceOrModel"] for x in obs if x["status"] == "manual-review")
        reasons = []
        if status == "approved": reasons.append("approved_or_published_or_already_in_db")
        elif status == "validation-review": reasons.append("validation_review_action")
        elif status == "model-retry": reasons.append("model_retry_excluded")
        elif status == "source-retry": reasons.append("source_retry_excluded")
        elif status == "manual-review": reasons.append("manual_review_action")
        elif status == "skipped": reasons.append("skipped_excluded")
        else: reasons.append("unprocessed_or_no_final_status")
        if ambiguous: reasons.append("402_source_or_model_requires_layer_classification")
        if not best: reasons.append("no_status_observation")
        ledger.append({"dedupKey": product["dedupKey"], "company": product.get("company"), "productName": product.get("productName"), "sourceUrl": product.get("sourceUrl"), "normalizedSourceUrl": product.get("normalizedSourceUrl"), "sourceDigest": product.get("sourceDigest"), "manifestInputs": product["manifestInputs"], "status": status, "rawStatus": best["rawStatus"] if best else None, "statusSource": best["inputPath"] if best else None, "statusLine": best["line"] if best else None, "artifactPath": best.get("artifactPath") if best else None, "resultPath": best.get("resultPath") if best else None, "ambiguousSourceOrModel": ambiguous, "excluded": status not in {"validation-review", "manual-review"} or ambiguous, "exclusionReason": ";".join(reasons), "allStatusObservations": [{k: v for k, v in o.items() if k != "row"} for o in obs]})

    counts = Counter(row["status"] for row in ledger)
    actionable = [row for row in ledger if row["status"] in {"validation-review", "manual-review"} and not row["ambiguousSourceOrModel"]]
    summary = {"task": "REVIEW_BACKLOG_912", "createdFrom": "authoritative_handoff_inputs", "identityRule": "sourceUrl first; normalized company+productName only without URL", "statusPrecedence": STATUS_RANK, "manifestPathCount": len(manifest_paths), "manifestRawProductRows": sum(manifest_counts.values()), "uniqueManifestProducts": len(products), "statusQueueCounts": dict(queue_counts), "finalUniqueStatusCounts": dict(counts), "baselineValidationReview": counts.get("validation-review", 0), "baselineManualReview": counts.get("manual-review", 0), "actionableReviewCount": len(actionable), "ambiguous402SourceOrModel": sum(row["ambiguousSourceOrModel"] for row in ledger), "manifestConflicts": len(manifest_conflicts), "missingStatusRoots": missing_status_roots, "sqliteRead": db_meta, "sqliteKeysUsedForExclusion": len(db_keys), "parseOnly": True, "sqliteWritten": False, "feishuWritten": False, "published": False, "statusRoots": [str((ROOT / x).resolve()) for x in STATUS_ROOTS], "manifestCounts": manifest_counts, "sha256LedgerInput": None}
    input_manifest = out / "manifest-inputs.json"
    input_manifest.write_text(json.dumps({"manifestPatterns": MANIFEST_PATTERNS, "expandedManifestPaths": [str(x) for x in manifest_paths], "statusRoots": [str((ROOT / x).resolve()) for x in STATUS_ROOTS], "excludedPathTokens": [".staging.", "aborted", "gap-runs", "stopped_before_model_work", "resume-auth-recovered", "dianjin-", "shadow-", "dry-run", "importer"]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "manifest-counts.json").write_text(json.dumps(manifest_counts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "global-review-ledger.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in ledger), encoding="utf-8")
    (out / "actionable-review-batch-001.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in actionable[:100]), encoding="utf-8")
    if manifest_conflicts:
        (out / "manifest-conflicts.json").write_text(json.dumps(manifest_conflicts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    digest_path = out / "global-review-ledger.jsonl"
    summary["sha256LedgerInput"] = "sha256:" + hashlib.sha256(digest_path.read_bytes()).hexdigest()
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputDir": str(out), "uniqueManifestProducts": len(products), "finalUniqueStatusCounts": dict(counts), "actionableReviewCount": len(actionable), "baselineMatches": counts.get("validation-review", 0) == 271 and counts.get("manual-review", 0) == 641, "ambiguous402SourceOrModel": summary["ambiguous402SourceOrModel"], "manifestConflicts": len(manifest_conflicts), "sqliteRead": db_meta}, ensure_ascii=False))


if __name__ == "__main__":
    main()
