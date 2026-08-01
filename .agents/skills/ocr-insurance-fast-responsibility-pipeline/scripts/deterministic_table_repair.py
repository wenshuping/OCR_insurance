#!/usr/bin/env python3
"""Repair a provable disability-grade table inside one approved artifact."""

import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path


HEADER_PATTERN = re.compile(r"伤残等级(?P<cells>(?:\s*\d+\s*级){2,})")
VALUE_PATTERN = re.compile(r"给付比例(?P<cells>(?:\s*\d+(?:\.\d+)?\s*[%％]){2,})")
TABLE_PREAMBLE = "伤残评定结果所对应的保险金给付比例如下表"


def compact(value):
    return re.sub(r"\s+", "", str(value or ""))


def sha256_json(value):
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def evidence_segments(responsibility):
    segments = [
        segment
        for segment in responsibility.get("evidenceSegments") or []
        if isinstance(segment, dict)
        and str(segment.get("sourceExcerpt") or "").strip()
    ]
    if segments:
        return segments
    excerpt = str(responsibility.get("sourceExcerpt") or "").strip()
    if excerpt:
        return [{
            "sourcePage": responsibility.get("sourcePage"),
            "sourceExcerpt": excerpt,
        }]
    return []


def unique_matches(pattern, segments):
    matches = []
    for index, segment in enumerate(segments):
        text = str(segment.get("sourceExcerpt") or "")
        for match in pattern.finditer(text):
            matches.append((index, match, text))
    return matches


def parse_grade_cells(value):
    return [f"{int(number)}级" for number in re.findall(r"(\d+)\s*级", value)]


def parse_percentage_cells(value):
    return [
        f"{number}%"
        for number in re.findall(r"(\d+(?:\.\d+)?)\s*[%％]", value)
    ]


def source_repair(reason, responsibility_id):
    return {
        "status": "source_repair_required",
        "responsibilityId": responsibility_id,
        "reason": reason,
    }


def repair_artifact(artifact, responsibility_id):
    responsibilities = artifact.get("responsibilities")
    if not isinstance(responsibilities, list):
        return None, source_repair("artifact responsibilities are missing", responsibility_id)
    targets = [
        item
        for item in responsibilities
        if isinstance(item, dict)
        and str(item.get("responsibilityId") or "") == responsibility_id
    ]
    if len(targets) != 1:
        return None, source_repair(
            "responsibilityId must identify exactly one responsibility",
            responsibility_id,
        )
    responsibility = targets[0]
    segments = evidence_segments(responsibility)
    if not segments:
        return None, source_repair(
            "target responsibility has no bound source evidence",
            responsibility_id,
        )

    header_matches = unique_matches(HEADER_PATTERN, segments)
    value_matches = unique_matches(VALUE_PATTERN, segments)
    if len(header_matches) != 1 or len(value_matches) != 1:
        return None, source_repair(
            "expected exactly one disability-grade header and one payout-ratio row",
            responsibility_id,
        )
    header_index, header_match, header_text = header_matches[0]
    value_index, value_match, _ = value_matches[0]
    if value_index not in {header_index, header_index + 1}:
        return None, source_repair(
            "payout-ratio row is not in the header segment or its immediate continuation",
            responsibility_id,
        )
    if value_index == header_index and value_match.start() <= header_match.end():
        return None, source_repair(
            "payout-ratio row does not follow the disability-grade header",
            responsibility_id,
        )
    if compact(TABLE_PREAMBLE) not in compact(header_text[:header_match.start()]):
        return None, source_repair(
            "explicit payout-table preamble is missing before the header",
            responsibility_id,
        )

    grades = parse_grade_cells(header_match.group("cells"))
    percentages = parse_percentage_cells(value_match.group("cells"))
    grade_numbers = [int(re.match(r"\d+", grade).group()) for grade in grades]
    if len(grades) != len(percentages):
        return None, source_repair(
            "header and payout row have different column counts",
            responsibility_id,
        )
    if len(set(grades)) != len(grades) or grade_numbers != sorted(grade_numbers):
        return None, source_repair(
            "disability grades are duplicated or not strictly increasing",
            responsibility_id,
        )

    indicators = responsibility.get("indicators")
    if not isinstance(indicators, list) or len(indicators) != 1:
        return None, source_repair(
            "target responsibility must contain exactly one indicator",
            responsibility_id,
        )
    indicator = indicators[0]
    if not isinstance(indicator, dict):
        return None, source_repair("target indicator is not an object", responsibility_id)
    formula_text = str(indicator.get("formulaText") or "")
    formula_parts = re.split(r"[×*]", formula_text, maxsplit=1)
    basis_text = formula_parts[0].strip() if len(formula_parts) == 2 else ""
    evidence_text = compact("\n".join(
        str(segment.get("sourceExcerpt") or "") for segment in segments
    ))
    if not basis_text or compact(basis_text) not in evidence_text:
        return None, source_repair(
            "indicator basis cannot be proven from the bound responsibility evidence",
            responsibility_id,
        )
    required_inputs = indicator.get("requiredInputs")
    if not isinstance(required_inputs, list) or not required_inputs:
        return None, source_repair(
            "target indicator has no existing requiredInputs to preserve",
            responsibility_id,
        )
    branch_basis = str(indicator.get("basisKey") or "")
    if not branch_basis or branch_basis == "piecewise":
        return None, source_repair(
            "target indicator has no exact branch basis to preserve",
            responsibility_id,
        )

    repaired = copy.deepcopy(artifact)
    repaired_responsibility = next(
        item
        for item in repaired["responsibilities"]
        if item.get("responsibilityId") == responsibility_id
    )
    repaired_indicator = repaired_responsibility["indicators"][0]
    repaired_indicator["normalizedFormula"] = "piecewise(disability_level)"
    repaired_indicator["basisKey"] = "piecewise"
    repaired_indicator["calculationKey"] = "branch_based"
    repaired_indicator["calculationStatus"] = "needs_claim_facts"
    repaired_indicator["calculationEligible"] = False
    repaired_indicator["calculationReason"] = (
        "伤残等级给付比例表已结构化；实际给付仍需伤残等级和意外身故伤残基本保险金额"
    )
    repaired_indicator["evidenceTokens"] = list(dict.fromkeys([
        *[str(token) for token in indicator.get("evidenceTokens") or []],
        *grades,
        *percentages,
    ]))
    repaired_indicator["branches"] = [
        {
            "branchId": f"disability_grade_{grade_number}",
            "conditionText": grade,
            "formulaText": f"{basis_text} × {percentage}",
            "basisKey": branch_basis,
            "calculationStatus": "needs_claim_facts",
            "requiredInputs": copy.deepcopy(required_inputs),
            "evidenceTokens": [grade, percentage, basis_text],
            "operands": [],
        }
        for grade_number, grade, percentage in zip(
            grade_numbers,
            grades,
            percentages,
            strict=True,
        )
    ]
    repaired_indicator["operands"] = []

    receipt = {
        "status": "auto_merge",
        "responsibilityId": responsibility_id,
        "headerSourcePage": segments[header_index].get("sourcePage"),
        "valueSourcePage": segments[value_index].get("sourcePage"),
        "rowCount": len(grades),
        "grades": grades,
        "percentages": percentages,
        "inputArtifactSha256": sha256_json(artifact),
        "outputArtifactSha256": sha256_json(repaired),
    }
    return repaired, receipt


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--responsibility-id", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    repaired, receipt = repair_artifact(artifact, args.responsibility_id)
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise ValueError("output-dir must be absent or empty")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    receipt["inputArtifactPath"] = str(args.artifact.resolve())
    if repaired is not None:
        output_path = args.output_dir / "artifact.json"
        output_path.write_text(
            json.dumps(repaired, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        receipt["outputArtifactPath"] = str(output_path.resolve())
    receipt_path = args.output_dir / "repair-receipt.json"
    receipt_path.write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(receipt, ensure_ascii=False))
    return 0 if repaired is not None else 2


if __name__ == "__main__":
    sys.exit(main())
