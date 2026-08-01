#!/usr/bin/env python3
"""Run a resumable multi-product packetized shadow canary."""

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--batch-runner", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout-ms", type=int, default=90_000)
    parser.add_argument("--max-tokens", type=int, default=768)
    return parser.parse_args()


def safe_name(company, product_name):
    value = f"{company}--{product_name}"
    compact = "".join(
        character if character.isalnum() or "\u4e00" <= character <= "\u9fff" else "-"
        for character in value
    )
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]
    return f"{compact[:80].strip('-')}-{digest}"


def main():
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(manifest, list) or not manifest:
        raise ValueError("manifest must be a non-empty JSON array")
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    packet_script = Path(__file__).with_name("run_packetized_shadow.py")
    started = time.monotonic()
    results = []
    for index, item in enumerate(manifest, start=1):
        artifact_path = Path(item["artifactPath"])
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
        company = str(artifact.get("company") or artifact.get("displayCompany") or "")
        product_name = str(artifact.get("productName") or "")
        responsibility_count = len(artifact.get("responsibilities") or [])
        product_dir = args.output_dir / "products" / safe_name(company, product_name)
        summary_path = product_dir / "summary.json"
        if summary_path.exists():
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            if summary.get("status") == "completed":
                results.append({
                    "index": index,
                    "company": company,
                    "productName": product_name,
                    "artifactPath": str(artifact_path),
                    **summary,
                    "resumed": True,
                })
                continue
        command = [
            sys.executable,
            str(packet_script),
            f"--artifact={artifact_path}",
            f"--batch-runner={args.batch_runner}",
            f"--output-dir={product_dir}",
            f"--base-url={args.base_url}",
            f"--model={args.model}",
            "--packet-size=1",
            f"--workers={max(1, args.workers)}",
            f"--timeout-ms={max(1000, args.timeout_ms)}",
            f"--max-tokens={max(64, args.max_tokens)}",
        ]
        product_started = time.monotonic()
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode == 0 and summary_path.exists():
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            result = {
                "index": index,
                "company": company,
                "productName": product_name,
                "artifactPath": str(artifact_path),
                **summary,
                "resumed": False,
            }
        else:
            valid_packet_results = len(list(product_dir.glob("packets/*/result.json")))
            error = (completed.stderr or completed.stdout).strip()
            result = {
                "index": index,
                "company": company,
                "productName": product_name,
                "artifactPath": str(artifact_path),
                "status": "failed",
                "expectedPackets": responsibility_count,
                "validJsonPackets": valid_packet_results,
                "elapsedSeconds": round(time.monotonic() - product_started, 3),
                "error": error[-4000:],
                "resumed": False,
            }
        results.append(result)
        (args.output_dir / "progress.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    expected_packets = sum(
        int(item.get("lockedResponsibilityCount") or item.get("expectedPackets") or 0)
        for item in results
    )
    valid_packets = sum(int(item.get("validJsonPackets") or 0) for item in results)
    completed_products = [item for item in results if item.get("status") == "completed"]
    failed_products = [item for item in results if item.get("status") != "completed"]
    timeout_count = sum(
        "timed out" in str(item.get("error") or "").lower()
        for item in failed_products
    )
    oom_count = sum(
        any(value in str(item.get("error") or "").lower() for value in [
            "out of memory",
            "outofmemory",
            "cuda oom",
        ])
        for item in failed_products
    )
    aligned = sum(item.get("comparisonStatus") == "aligned" for item in completed_products)
    review_required = sum(
        item.get("comparisonStatus") == "review_required"
        for item in completed_products
    )
    summary = {
        "status": "completed",
        "selectedProducts": len(manifest),
        "completedProducts": len(completed_products),
        "failedProducts": len(failed_products),
        "expectedPackets": expected_packets,
        "validJsonPackets": valid_packets,
        "validJsonRate": round(valid_packets / expected_packets, 4) if expected_packets else 0,
        "responsibilityCoverageRate": round(
            sum(int(item.get("responsibilityCount") or 0) for item in completed_products)
            / expected_packets,
            4,
        ) if expected_packets else 0,
        "alignedProducts": aligned,
        "reviewRequiredProducts": review_required,
        "timeoutCount": timeout_count,
        "oomCount": oom_count,
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "aggregateProductElapsedSeconds": round(
            sum(float(item.get("elapsedSeconds") or 0) for item in results),
            3,
        ),
        "model": args.model,
        "maxActiveGenerations": max(1, args.workers),
        "packetSize": 1,
        "maxTokens": max(64, args.max_tokens),
        "timeoutMs": max(1000, args.timeout_ms),
        "qualityGatePassed": (
            valid_packets / expected_packets >= 0.98
            and not failed_products
            and timeout_count == 0
            and oom_count == 0
        ) if expected_packets else False,
        "products": results,
    }
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    report = [
        "# DianJin Packetized Shadow Canary",
        "",
        f"- Products: {len(manifest)}",
        f"- Completed: {len(completed_products)}",
        f"- Failed: {len(failed_products)}",
        f"- Valid JSON packets: {valid_packets}/{expected_packets} ({summary['validJsonRate']:.2%})",
        f"- Responsibility coverage: {summary['responsibilityCoverageRate']:.2%}",
        f"- Aligned: {aligned}",
        f"- Review required: {review_required}",
        f"- Timeout: {timeout_count}",
        f"- OOM: {oom_count}",
        f"- Elapsed: {summary['elapsedSeconds']} s",
        f"- Aggregate product elapsed: {summary['aggregateProductElapsedSeconds']} s",
        f"- Quality gate passed: {summary['qualityGatePassed']}",
        "",
        "## Products",
        "",
        "| Product | Responsibilities | JSON packets | Comparison | Status |",
        "| --- | ---: | ---: | --- | --- |",
    ]
    for item in results:
        report.append(
            f"| {item['productName']} | "
            f"{item.get('lockedResponsibilityCount') or item.get('expectedPackets') or 0} | "
            f"{item.get('validJsonPackets') or 0} | "
            f"{item.get('comparisonStatus') or '-'} | {item.get('status')} |"
        )
    (args.output_dir / "report.md").write_text(
        "\n".join(report) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        key: value for key, value in summary.items() if key != "products"
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
