#!/usr/bin/env python3
"""Run bounded local shadow inference against an approved responsibility inventory."""

import argparse
import concurrent.futures
import importlib.util
import json
import re
import sys
import time
from pathlib import Path


ALLOWED_RISK_SIGNALS = {
    "age_branch",
    "policy_year_branch",
    "waiting_period",
    "accident_exception",
    "max_formula",
    "min_formula",
    "table_reference",
    "mutual_exclusion",
    "cross_page_continuation",
    "optional_package",
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--batch-runner", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--api-key", default="")
    parser.add_argument("--packet-size", type=int, default=2)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout-ms", type=int, default=90_000)
    parser.add_argument("--max-tokens", type=int, default=768)
    return parser.parse_args()


def load_batch(path):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("responsibility_batch", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def strict_json_object(content):
    value = json.loads(str(content or "").strip())
    if not isinstance(value, dict):
        raise ValueError("shadow output must be one JSON object")
    return value


def response_format(responsibility_ids):
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "insurance_responsibility_shadow_packet",
            "schema": {
                "type": "object",
                "properties": {
                    "responsibilities": {
                        "type": "array",
                        "minItems": len(responsibility_ids),
                        "maxItems": len(responsibility_ids),
                        "items": {
                            "type": "object",
                            "properties": {
                                "responsibilityId": {
                                    "type": "string",
                                    "enum": responsibility_ids,
                                },
                                "formulaBranches": {
                                    "type": "array",
                                    "maxItems": 8,
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "condition": {"type": "string"},
                                            "formula": {"type": "string"},
                                            "numericTokens": {
                                                "type": "array",
                                                "maxItems": 20,
                                                "items": {"type": "string"},
                                            },
                                        },
                                        "required": [
                                            "condition",
                                            "formula",
                                            "numericTokens",
                                        ],
                                        "additionalProperties": False,
                                    },
                                },
                                "limits": {
                                    "type": "array",
                                    "maxItems": 8,
                                    "items": {"type": "string"},
                                },
                            },
                            "required": [
                                "responsibilityId",
                                "formulaBranches",
                                "limits",
                            ],
                            "additionalProperties": False,
                        },
                    },
                    "riskSignals": {
                        "type": "array",
                        "maxItems": len(ALLOWED_RISK_SIGNALS),
                        "items": {
                            "type": "string",
                            "enum": sorted(ALLOWED_RISK_SIGNALS),
                        },
                    },
                },
                "required": ["responsibilities", "riskSignals"],
                "additionalProperties": False,
            },
        },
    }


def responsibility_evidence(item):
    excerpts = [str(item.get("sourceExcerpt") or "").strip()]
    excerpts.extend(
        str(segment.get("text") or segment.get("sourceExcerpt") or "").strip()
        for segment in item.get("evidenceSegments") or []
        if isinstance(segment, dict)
    )
    return "\n".join(value for value in excerpts if value)


def refine_branch_count_comparison(comparison, shadow):
    candidates = {
        str(item.get("title") or ""): item
        for item in shadow.get("responsibilities") or []
    }
    retained = []
    for conflict in comparison.get("materialConflicts") or []:
        if conflict.get("type") != "formula_branch_count_mismatch":
            retained.append(conflict)
            continue
        comparison_item = next(
            (
                item
                for item in comparison.get("comparisons") or []
                if item.get("responsibilityId") == conflict.get("responsibilityId")
            ),
            None,
        )
        candidate = candidates.get(str((comparison_item or {}).get("shadowTitle") or ""))
        unique_formulas = {
            re.sub(r"\s+", "", str(branch.get("formula") or ""))
            for branch in (candidate or {}).get("formulaBranches") or []
            if str(branch.get("formula") or "").strip()
        }
        if len(unique_formulas) == conflict.get("artifactBranchCount"):
            if comparison_item and not comparison_item.get("missingNumericTokens"):
                comparison_item["status"] = "aligned"
                comparison_item["rawShadowBranchCount"] = conflict.get("shadowBranchCount")
                comparison_item["shadowBranchCount"] = len(unique_formulas)
                comparison_item["branchNormalization"] = "unique_formula_outputs"
            continue
        retained.append(conflict)
    comparison["materialConflicts"] = retained
    comparison["status"] = "review_required" if retained else "aligned"
    return comparison


def build_packets(responsibilities, packet_size):
    packets = []
    for start in range(0, len(responsibilities), packet_size):
        items = responsibilities[start:start + packet_size]
        packets.append({
            "index": len(packets) + 1,
            "items": items,
            "ids": [str(item.get("responsibilityId") or "") for item in items],
        })
    return packets


def validate_packet(parsed, packet):
    if set(parsed) != {"responsibilities", "riskSignals"}:
        raise ValueError("packet root fields do not match schema")
    expected_ids = packet["ids"]
    returned = parsed.get("responsibilities")
    if not isinstance(returned, list):
        raise ValueError("packet responsibilities must be an array")
    returned_ids = [str(item.get("responsibilityId") or "") for item in returned]
    if len(returned_ids) != len(set(returned_ids)):
        raise ValueError("packet returned duplicate responsibilityId")
    if set(returned_ids) != set(expected_ids):
        raise ValueError(
            f"packet responsibilityId mismatch: expected={expected_ids}, returned={returned_ids}"
        )
    source_scope = re.sub(
        r"\s+",
        "",
        "\n".join(responsibility_evidence(item) for item in packet["items"]),
    )
    rejected_tokens = []
    rejected_claims = []

    def unsupported_operator(value):
        compact = re.sub(r"\s+", "", str(value or "")).lower()
        if ("max(" in compact or "较大者" in compact) and not (
            "max(" in source_scope.lower() or "较大者" in source_scope
        ):
            return "max"
        if ("min(" in compact or "较小者" in compact) and not (
            "min(" in source_scope.lower() or "较小者" in source_scope
        ):
            return "min"
        return ""

    for item in returned:
        accepted_branches = []
        for branch in item.get("formulaBranches") or []:
            operator = unsupported_operator(
                f"{branch.get('condition') or ''}\n{branch.get('formula') or ''}"
            )
            if operator:
                rejected_claims.append({
                    "field": "formulaBranches",
                    "operator": operator,
                    "value": branch,
                })
                continue
            accepted = []
            for token in branch.get("numericTokens") or []:
                compact = re.sub(r"\s+", "", str(token))
                if re.search(r"\d|[%％]", compact) and compact in source_scope:
                    accepted.append(token)
                else:
                    rejected_tokens.append(token)
            branch["numericTokens"] = list(dict.fromkeys(accepted))
            accepted_branches.append(branch)
        item["formulaBranches"] = accepted_branches
        accepted_limits = []
        for limit in item.get("limits") or []:
            operator = unsupported_operator(limit)
            if operator:
                rejected_claims.append({
                    "field": "limits",
                    "operator": operator,
                    "value": limit,
                })
            else:
                accepted_limits.append(limit)
        item["limits"] = list(dict.fromkeys(accepted_limits))
    signals = parsed.get("riskSignals")
    if not isinstance(signals, list):
        raise ValueError("packet riskSignals must be an array")
    compact_lower = source_scope.lower()
    signal_supported = {
        "age_branch": "周岁" in source_scope,
        "policy_year_branch": "保单年度" in source_scope,
        "waiting_period": "等待期" in source_scope,
        "accident_exception": "意外伤害" in source_scope,
        "max_formula": "max(" in compact_lower or "较大者" in source_scope,
        "min_formula": "min(" in compact_lower or "较小者" in source_scope,
        "table_reference": any(value in source_scope for value in ["附表", "附录", "表"]),
        "mutual_exclusion": any(
            value in source_scope
            for value in ["仅给付其中一项", "不重复给付", "给付其一"]
        ),
        "cross_page_continuation": False,
        "optional_package": any(
            value in source_scope for value in ["可选保险责任", "可选责任", "保险计划"]
        ),
    }
    parsed["riskSignals"] = list(dict.fromkeys(
        signal
        for signal in signals
        if signal in ALLOWED_RISK_SIGNALS and signal_supported.get(signal, False)
    ))
    return {
        "rejectedNumericTokens": rejected_tokens,
        "rejectedClaims": rejected_claims,
    }


def run_packet(batch, args, artifact, packet):
    packet_dir = args.output_dir / "packets" / f"packet-{packet['index']:03d}"
    packet_dir.mkdir(parents=True, exist_ok=True)
    result_path = packet_dir / "result.json"
    if result_path.exists():
        cached = json.loads(result_path.read_text(encoding="utf-8"))
        if cached.get("responsibilityIds") == packet["ids"] and isinstance(
            (cached.get("output") or {}).get("responsibilities"),
            list,
        ):
            return cached
    evidence = []
    title_by_id = {}
    for item in packet["items"]:
        responsibility_id = str(item.get("responsibilityId") or "")
        liability = str(item.get("liability") or "")
        title_by_id[responsibility_id] = liability
        evidence.append(
            f"RESPONSIBILITY_ID: {responsibility_id}\n"
            f"LOCKED_TITLE: {liability}\n"
            f"OFFICIAL_EVIDENCE:\n{responsibility_evidence(item)}"
        )
    messages = [
        {
            "role": "system",
            "content": (
                "你是保险条款公式与风险信号候选助手。官方证据和锁定责任ID是唯一依据。"
                "必须为每个给定责任ID返回且仅返回一项，不得新增、合并或省略责任。"
            ),
        },
        {
            "role": "user",
            "content": (
                f"公司：{artifact.get('company') or artifact.get('displayCompany') or ''}\n"
                f"产品：{artifact.get('productName') or ''}\n"
                "仅提取完整公式分支、年龄或保单年度边界、百分比、max/min关系、"
                "互斥和风险信号。数组不得重复；没有的风险信号不要输出。"
                "numericTokens必须逐字来自对应官方证据。\n\n"
                + "\n\n".join(evidence)
            ),
        },
    ]
    started = time.monotonic()
    content = batch.call_model(
        args.api_key,
        args.model,
        messages,
        provider="openai-compatible",
        base_url=args.base_url,
        max_tokens=max(64, args.max_tokens),
        response_format=response_format(packet["ids"]),
        timeout=max(1, args.timeout_ms / 1000),
    )
    (packet_dir / "raw.txt").write_text(content, encoding="utf-8")
    parsed = strict_json_object(content)
    validation = validate_packet(parsed, packet)
    for item in parsed["responsibilities"]:
        item["title"] = title_by_id[item.pop("responsibilityId")]
    result = {
        "packetIndex": packet["index"],
        "responsibilityIds": packet["ids"],
        "latencyMs": round((time.monotonic() - started) * 1000),
        **validation,
        "output": parsed,
    }
    result_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return result


def main():
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    responsibilities = artifact.get("responsibilities") or []
    if not responsibilities:
        raise ValueError("artifact has no locked responsibilities")
    responsibility_ids = [
        str(item.get("responsibilityId") or "") for item in responsibilities
    ]
    if not all(responsibility_ids) or len(responsibility_ids) != len(set(responsibility_ids)):
        raise ValueError("artifact responsibility IDs must be present and unique")
    batch = load_batch(args.batch_runner)
    packets = build_packets(responsibilities, max(1, args.packet_size))
    started = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(max(1, args.workers), len(packets))
    ) as executor:
        results = list(executor.map(
            lambda packet: run_packet(batch, args, artifact, packet),
            packets,
        ))
    merged_responsibilities = []
    risk_signals = []
    rejected_tokens = []
    rejected_claims = []
    for result in sorted(results, key=lambda item: item["packetIndex"]):
        merged_responsibilities.extend(result["output"]["responsibilities"])
        risk_signals.extend(result["output"]["riskSignals"])
        rejected_tokens.extend(result["rejectedNumericTokens"])
        rejected_claims.extend(result["rejectedClaims"])
    if len(merged_responsibilities) != len(responsibilities):
        raise ValueError("merged responsibility count does not match locked inventory")
    merged = {
        "responsibilities": merged_responsibilities,
        "riskSignals": list(dict.fromkeys(risk_signals)),
    }
    shadow_path = args.output_dir / "shadow.json"
    shadow_path.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    comparison = batch.compare_shadow_to_artifact(merged, artifact)
    comparison = refine_branch_count_comparison(comparison, merged)
    comparison_path = args.output_dir / "shadow-comparison.json"
    comparison_path.write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    summary = {
        "status": "completed",
        "model": args.model,
        "packetSize": max(1, args.packet_size),
        "packetCount": len(packets),
        "workers": min(max(1, args.workers), len(packets)),
        "responsibilityCount": len(merged_responsibilities),
        "lockedResponsibilityCount": len(responsibilities),
        "validJsonPackets": len(results),
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "packetLatenciesMs": [item["latencyMs"] for item in results],
        "rejectedNumericTokens": rejected_tokens,
        "rejectedClaims": rejected_claims,
        "comparisonStatus": comparison["status"],
        "materialConflictCount": len(comparison["materialConflicts"]),
        "shadowPath": str(shadow_path),
        "comparisonPath": str(comparison_path),
    }
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
