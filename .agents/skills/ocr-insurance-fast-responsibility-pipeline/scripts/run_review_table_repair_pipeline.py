#!/usr/bin/env python3
"""Repair table-only review items, then run validator and importer dry-run."""

import argparse
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse


TABLE_CONFLICT_TYPE = "numeric_tokens_missing_from_artifact"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def read_jsonl(path):
    records = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number}: expected JSON object")
        records.append(value)
    return records


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "".join(
        json.dumps(record, ensure_ascii=False) + "\n" for record in records
    )
    path.write_text(content, encoding="utf-8")


def safe_name(value):
    normalized = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", str(value or "").strip())
    return normalized.strip("-._") or "unknown"


def resolve_record_path(value, queue_path):
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    cwd_path = (Path.cwd() / path).resolve()
    if cwd_path.exists():
        return cwd_path
    return (queue_path.parent / path).resolve()


def load_repair_module(script_path):
    spec = importlib.util.spec_from_file_location(
        "deterministic_table_repair",
        script_path,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load repair module: {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def table_repair_targets(comparison):
    conflicts = comparison.get("materialConflicts")
    if not isinstance(conflicts, list) or not conflicts:
        return None, "comparison has no material conflicts"
    unsupported = [
        conflict.get("type")
        for conflict in conflicts
        if not isinstance(conflict, dict)
        or conflict.get("type") != TABLE_CONFLICT_TYPE
    ]
    if unsupported:
        return None, f"contains non-table conflicts: {unsupported}"
    targets = []
    for conflict in conflicts:
        responsibility_id = str(conflict.get("responsibilityId") or "").strip()
        tokens = [
            str(token).strip()
            for token in conflict.get("tokens") or []
            if str(token).strip()
        ]
        if not responsibility_id or not tokens:
            return None, "table conflict requires responsibilityId and tokens"
        targets.append((responsibility_id, tokens))
    return targets, None


def target_indicator_text(artifact, responsibility_id):
    for responsibility in artifact.get("responsibilities") or []:
        if responsibility.get("responsibilityId") != responsibility_id:
            continue
        return json.dumps(
            responsibility.get("indicators") or [],
            ensure_ascii=False,
            sort_keys=True,
        )
    return ""


def source_metadata(artifact_path, artifact):
    result_path = artifact_path.parent / "result.json"
    result = read_json(result_path) if result_path.exists() else {}
    source_url = str(
        result.get("sourceUrl")
        or artifact.get("sourceUrl")
        or ""
    ).strip()
    official_domain = str(result.get("officialDomain") or "").strip()
    if not official_domain and source_url:
        official_domain = urlparse(source_url).hostname or ""
    return {
        "sourceTextPath": result.get("sourceTextPath"),
        "sourceDocumentPath": result.get("sourceDocumentPath"),
        "officialDomain": official_domain,
        "sourceUrl": source_url,
    }


def run_command(command):
    completed = subprocess.run(
        [str(part) for part in command],
        check=False,
        capture_output=True,
        text=True,
    )
    return {
        "command": [str(part) for part in command],
        "returnCode": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }


def parse_stdout_json(receipt):
    if not receipt["stdout"]:
        raise ValueError("command produced no JSON output")
    return json.loads(receipt["stdout"])


def parse_args(argv=None):
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parents[3]
    parser = argparse.ArgumentParser(
        description="Run deterministic table repair and read-only release gates",
    )
    parser.add_argument("--review-queue", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--repair-script",
        type=Path,
        default=script_dir / "deterministic_table_repair.py",
    )
    parser.add_argument(
        "--validator",
        type=Path,
        default=(
            project_root
            / ".worktrees/dev-agent-semantic-integration/.agents/skills"
            / "ocr-insurance-product-responsibility-pipeline/scripts"
            / "validate_artifact.py"
        ),
    )
    parser.add_argument(
        "--importer",
        type=Path,
        default=project_root / "scripts/import-reviewed-responsibility-artifacts.mjs",
    )
    parser.add_argument("--node", default="node")
    return parser.parse_args(argv)


def process_record(record, index, args, repair_module):
    artifact_value = record.get("artifactPath")
    comparison_value = record.get("comparisonPath")
    if not artifact_value or not comparison_value:
        return "pipeline_error", {
            **record,
            "status": "pipeline_error",
            "reason": "artifactPath and comparisonPath are required",
        }

    artifact_path = resolve_record_path(artifact_value, args.review_queue)
    comparison_path = resolve_record_path(comparison_value, args.review_queue)
    artifact = read_json(artifact_path)
    comparison = read_json(comparison_path)
    targets, reason = table_repair_targets(comparison)
    if reason:
        return "unhandled_review", {
            **record,
            "status": "unhandled_review",
            "reason": reason,
        }

    company = str(record.get("company") or artifact.get("company") or "")
    product_name = str(
        record.get("productName") or artifact.get("productName") or ""
    )
    product_dir = (
        args.output_dir
        / "products"
        / f"{index:04d}-{safe_name(company)}-{safe_name(product_name)}"
    )
    product_dir.mkdir(parents=True, exist_ok=True)

    repaired = artifact
    repair_receipts = []
    for responsibility_id, expected_tokens in targets:
        repaired, receipt = repair_module.repair_artifact(
            repaired,
            responsibility_id,
        )
        repair_receipts.append(receipt)
        if repaired is None:
            output = {
                **record,
                "company": company,
                "productName": product_name,
                "status": "source_repair_required",
                "reason": receipt.get("reason"),
                "repairReceipts": repair_receipts,
            }
            write_json(product_dir / "pipeline-receipt.json", output)
            return "source_repair_required", output
        indicator_text = target_indicator_text(repaired, responsibility_id)
        missing_after_repair = [
            token for token in expected_tokens if token not in indicator_text
        ]
        if missing_after_repair:
            output = {
                **record,
                "company": company,
                "productName": product_name,
                "status": "source_repair_required",
                "reason": "reviewed numeric tokens remain absent after repair",
                "missingTokens": missing_after_repair,
                "repairReceipts": repair_receipts,
            }
            write_json(product_dir / "pipeline-receipt.json", output)
            return "source_repair_required", output

    repaired_path = product_dir / "artifact.json"
    write_json(repaired_path, repaired)
    metadata = source_metadata(artifact_path, artifact)
    missing_metadata = [
        key
        for key in ("sourceTextPath", "sourceDocumentPath", "officialDomain")
        if not metadata.get(key)
    ]
    if missing_metadata:
        output = {
            **record,
            "company": company,
            "productName": product_name,
            "status": "pipeline_error",
            "reason": f"missing validator source metadata: {missing_metadata}",
            "artifactPath": str(repaired_path.resolve()),
        }
        write_json(product_dir / "pipeline-receipt.json", output)
        return "pipeline_error", output

    validator_receipt = run_command([
        sys.executable,
        args.validator,
        "--artifact",
        repaired_path,
        "--source-text",
        metadata["sourceTextPath"],
        "--source-document",
        metadata["sourceDocumentPath"],
        "--official-domain",
        metadata["officialDomain"],
    ])
    write_json(product_dir / "validator-receipt.json", validator_receipt)
    expected_count = len(repaired.get("responsibilities") or [])
    if validator_receipt["returnCode"] != 0:
        output = {
            **record,
            "company": company,
            "productName": product_name,
            "status": "validation_failed",
            "artifactPath": str(repaired_path.resolve()),
            "validatorReceiptPath": str(
                (product_dir / "validator-receipt.json").resolve()
            ),
        }
        write_json(product_dir / "pipeline-receipt.json", output)
        return "validation_failed", output
    validator_result = parse_stdout_json(validator_receipt)
    if (
        not validator_result.get("ok")
        or validator_result.get("responsibilityCount") != expected_count
    ):
        output = {
            **record,
            "company": company,
            "productName": product_name,
            "status": "validation_failed",
            "reason": "validator count or status mismatch",
            "artifactPath": str(repaired_path.resolve()),
            "validatorResult": validator_result,
        }
        write_json(product_dir / "pipeline-receipt.json", output)
        return "validation_failed", output

    dry_run_db = product_dir / "importer-dry-run.sqlite"
    if dry_run_db.exists():
        raise ValueError(f"dry-run database path already exists: {dry_run_db}")
    importer_receipt = run_command([
        args.node,
        args.importer,
        f"--artifacts={repaired_path}",
        f"--db-path={dry_run_db}",
    ])
    write_json(product_dir / "importer-dry-run-receipt.json", importer_receipt)
    importer_result = (
        parse_stdout_json(importer_receipt)
        if importer_receipt["returnCode"] == 0
        else {}
    )
    importer_ok = (
        importer_receipt["returnCode"] == 0
        and importer_result.get("ok") is True
        and importer_result.get("dryRun") is True
        and importer_result.get("validationIssueCount") == 0
        and importer_result.get("acceptedResponsibilities") == expected_count
        and importer_result.get("materializedProducts") == 0
        and not dry_run_db.exists()
    )
    if not importer_ok:
        output = {
            **record,
            "company": company,
            "productName": product_name,
            "status": "importer_dry_run_failed",
            "artifactPath": str(repaired_path.resolve()),
            "importerResult": importer_result,
            "dryRunDatabaseCreated": dry_run_db.exists(),
        }
        write_json(product_dir / "pipeline-receipt.json", output)
        return "importer_dry_run_failed", output

    output = {
        **record,
        "company": company,
        "productName": product_name,
        "status": "ready_for_import",
        "artifactPath": str(repaired_path.resolve()),
        "originalArtifactPath": str(artifact_path.resolve()),
        "repairReceipts": repair_receipts,
        "validatorResult": validator_result,
        "importerDryRun": importer_result,
        "dryRunDatabaseCreated": False,
    }
    write_json(product_dir / "pipeline-receipt.json", output)
    return "ready_for_import", output


def main(argv=None):
    args = parse_args(argv)
    args.review_queue = args.review_queue.resolve()
    args.output_dir = args.output_dir.resolve()
    args.repair_script = args.repair_script.resolve()
    args.validator = args.validator.resolve()
    args.importer = args.importer.resolve()
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise ValueError("output-dir must be absent or empty")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    repair_module = load_repair_module(args.repair_script)

    buckets = {
        "ready_for_import": [],
        "source_repair_required": [],
        "validation_failed": [],
        "importer_dry_run_failed": [],
        "unhandled_review": [],
        "pipeline_error": [],
    }
    records = read_jsonl(args.review_queue)
    for index, record in enumerate(records, start=1):
        try:
            status, output = process_record(
                record,
                index,
                args,
                repair_module,
            )
        except Exception as error:
            status = "pipeline_error"
            output = {
                **record,
                "status": status,
                "reason": f"{type(error).__name__}: {error}",
            }
        buckets[status].append(output)

    filenames = {
        "ready_for_import": "ready-for-import.jsonl",
        "source_repair_required": "source-repair-required.jsonl",
        "validation_failed": "validation-failed.jsonl",
        "importer_dry_run_failed": "importer-dry-run-failed.jsonl",
        "unhandled_review": "unhandled-review.jsonl",
        "pipeline_error": "pipeline-errors.jsonl",
    }
    for status, filename in filenames.items():
        write_jsonl(args.output_dir / filename, buckets[status])

    summary = {
        "ok": not any(
            buckets[status]
            for status in (
                "validation_failed",
                "importer_dry_run_failed",
                "pipeline_error",
            )
        ),
        "reviewQueue": str(args.review_queue),
        "total": len(records),
        "counts": {status: len(rows) for status, rows in buckets.items()},
        "writesPerformed": {
            "sqlite": 0,
            "feishu": 0,
            "publishedProducts": 0,
        },
    }
    write_json(args.output_dir / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
