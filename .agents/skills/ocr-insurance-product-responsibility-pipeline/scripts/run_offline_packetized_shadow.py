#!/usr/bin/env python3
"""Run packetized local shadow work after approved artifacts are immutable."""

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--packet-runner", type=Path, required=True)
    parser.add_argument("--batch-runner", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--api-key", default="")
    parser.add_argument("--max-active-generations", type=int, default=4)
    parser.add_argument("--timeout-ms", type=int, default=90000)
    parser.add_argument("--max-tokens", type=int, default=768)
    return parser.parse_args(argv)


def safe_name(company, product_name):
    value = f"{company}--{product_name}"
    compact = "".join(
        character if character.isalnum() or "\u4e00" <= character <= "\u9fff" else "-"
        for character in value
    )
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]
    return f"{compact[:80].strip('-')}-{digest}"


def completed_without_failures(summary_path):
    if not summary_path.exists():
        return False
    try:
        return json.loads(summary_path.read_text(encoding="utf-8")).get("status") == "completed"
    except (OSError, json.JSONDecodeError):
        return False


def run_product(args, item):
    artifact_path = Path(item["artifactPath"])
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    company = str(artifact.get("company") or artifact.get("displayCompany") or "")
    product_name = str(artifact.get("productName") or "")
    product_dir = args.output_dir / "products" / safe_name(company, product_name)
    summary_path = product_dir / "summary.json"
    if completed_without_failures(summary_path):
        return json.loads(summary_path.read_text(encoding="utf-8"))
    command = [
        sys.executable,
        str(args.packet_runner),
        f"--artifact={artifact_path}",
        f"--batch-runner={args.batch_runner}",
        f"--output-dir={product_dir}",
        f"--base-url={args.base_url}",
        f"--model={args.model}",
        f"--api-key={args.api_key}",
        "--packet-size=1",
        f"--workers={max(1, args.max_active_generations)}",
        f"--timeout-ms={max(1000, args.timeout_ms)}",
        f"--max-tokens={max(64, args.max_tokens)}",
    ]
    started = time.monotonic()
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode == 0 and summary_path.exists():
        return json.loads(summary_path.read_text(encoding="utf-8"))
    return {
        "status": "failed",
        "model": args.model,
        "artifactPath": str(artifact_path),
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "error": (completed.stderr or completed.stdout)[-4000:],
    }


def main(argv=None):
    args = parse_args(argv)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(manifest, list):
        raise ValueError("manifest must be a JSON array")
    started = time.monotonic()
    results = []
    review_items = []
    for item in manifest:
        result = run_product(args, item)
        record = {**item, **result}
        results.append(record)
        if result.get("comparisonStatus") == "review_required":
            review_items.append(record)
        (args.output_dir / "progress.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    review_path = args.output_dir / "review-required.jsonl"
    review_path.write_text(
        "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in review_items),
        encoding="utf-8",
    )
    failed = [item for item in results if item.get("status") != "completed"]
    summary = {
        "status": "completed",
        "selectedProducts": len(manifest),
        "completedProducts": len(results) - len(failed),
        "failedProducts": len(failed),
        "model": args.model,
        "provider": "openai-compatible",
        "packetSize": 1,
        "maxActiveGenerations": max(1, args.max_active_generations),
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "reviewRequiredProducts": len(review_items),
        "reviewQueuePath": str(review_path),
        "products": results,
    }
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({k: v for k, v in summary.items() if k != "products"}, ensure_ascii=False))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
