#!/usr/bin/env python3
"""Validate focused long-term-care responsibility fixtures."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


TOPOLOGIES = {"standalone", "rider", "group", "bundle_component"}
PAYMENT_MODES = {"lump_sum", "periodic", "reimbursement", "waiver", "mixed"}
SUPPORTING_CLASSES = {
    "care_state_definition",
    "disease_definition",
    "medical_explanation",
    "exclusion",
    "shared_rule",
    "assessment_process",
    "claims_process",
    "group_heading",
}
FALSE_TITLE = re.compile(r"^(保险责任|基本责任|护理状态|日常生活活动|释义|责任免除|理赔申请)$")


def require(condition: bool, fixture_id: str, message: str, issues: list[str]) -> None:
    if not condition:
        issues.append(f"{fixture_id}: {message}")


def validate_fixture(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    fixture_id = str(data.get("id") or path.stem)
    issues: list[str] = []
    topology = data.get("topology")
    responsibilities = data.get("responsibilities")
    supporting = data.get("supportingFragments")

    require(topology in TOPOLOGIES, fixture_id, "invalid topology", issues)
    require(isinstance(responsibilities, list) and responsibilities, fixture_id,
            "responsibilities must be a non-empty array", issues)
    require(isinstance(supporting, list), fixture_id,
            "supportingFragments must be an array", issues)
    if not isinstance(responsibilities, list):
        return issues

    responsibility_ids: set[str] = set()
    for item in responsibilities:
        responsibility_id = str(item.get("responsibilityId") or "")
        title = str(item.get("liability") or "")
        trigger = str(item.get("triggerCondition") or "")
        obligation = str(item.get("insurerObligation") or "")
        source_excerpt = str(item.get("sourceExcerpt") or "")
        benefit = item.get("benefit") or {}
        formula = item.get("formula") or {}

        require(bool(responsibility_id), fixture_id, "missing responsibilityId", issues)
        require(responsibility_id not in responsibility_ids, fixture_id,
                f"duplicate responsibilityId {responsibility_id}", issues)
        responsibility_ids.add(responsibility_id)
        require(bool(title) and not FALSE_TITLE.search(title), fixture_id,
                f"false or empty responsibility title {title!r}", issues)
        require(bool(trigger), fixture_id, f"{responsibility_id} missing trigger", issues)
        require(bool(obligation), fixture_id, f"{responsibility_id} missing obligation", issues)
        require(bool(source_excerpt), fixture_id,
                f"{responsibility_id} missing exact sourceExcerpt", issues)
        require(benefit.get("paymentMode") in PAYMENT_MODES, fixture_id,
                f"{responsibility_id} invalid paymentMode", issues)

        if benefit.get("paymentMode") in {"lump_sum", "periodic", "reimbursement"}:
            require(bool(formula.get("formulaText")), fixture_id,
                    f"{responsibility_id} missing formulaText", issues)
            require(isinstance(formula.get("requiredInputs"), list), fixture_id,
                    f"{responsibility_id} missing requiredInputs", issues)
            require(isinstance(formula.get("branches", []), list), fixture_id,
                    f"{responsibility_id} branches must be an array", issues)
            require(isinstance(formula.get("operands", []), list), fixture_id,
                    f"{responsibility_id} operands must be an array", issues)

        if benefit.get("paymentMode") == "periodic":
            require(benefit.get("cadence") in {"daily", "monthly", "annual", "other"},
                    fixture_id, f"{responsibility_id} missing periodic cadence", issues)
            require(bool(benefit.get("benefitPeriodText")
                         or benefit.get("paymentCountText")
                         or benefit.get("aggregateLimitText")),
                    fixture_id,
                    f"{responsibility_id} missing period/count/aggregate limit", issues)
            require(bool(benefit.get("terminationText")), fixture_id,
                    f"{responsibility_id} missing periodic termination rule", issues)

        if benefit.get("paymentMode") == "reimbursement":
            require("实际" in source_excerpt and ("报销" in source_excerpt or "补偿" in source_excerpt),
                    fixture_id,
                    f"{responsibility_id} reimbursement lacks actual-expense obligation",
                    issues)

        if "护理" in title and benefit.get("paymentMode") != "reimbursement":
            require(not ("医疗费用" in obligation and "报销" in obligation), fixture_id,
                    f"{responsibility_id} care cash benefit mislabeled as reimbursement",
                    issues)

    if isinstance(supporting, list):
        for fragment in supporting:
            fragment_id = str(fragment.get("fragmentId") or "")
            classification = fragment.get("classification")
            require(bool(fragment_id), fixture_id, "supporting fragment missing id", issues)
            require(classification in SUPPORTING_CLASSES, fixture_id,
                    f"{fragment_id} invalid supporting classification", issues)
            require(fragment_id not in responsibility_ids, fixture_id,
                    f"{fragment_id} promoted to responsibility", issues)

    expected = data.get("expected") or {}
    require(expected.get("acceptedCount") == len(responsibilities), fixture_id,
            "expected acceptedCount mismatch", issues)
    expected_rejected = set(expected.get("rejectedClassifications") or [])
    actual_rejected = {
        item.get("classification")
        for item in supporting or []
        if isinstance(item, dict)
    }
    require(expected_rejected.issubset(actual_rejected), fixture_id,
            "expected rejected classifications missing", issues)
    return issues


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixtures_dir", type=Path)
    args = parser.parse_args()
    paths = sorted(args.fixtures_dir.glob("*.json"))
    if len(paths) < 8:
        print(json.dumps({"ok": False, "issue": "at least 8 fixtures required",
                          "fixtureCount": len(paths)}, ensure_ascii=False))
        return 1

    issues: list[str] = []
    for path in paths:
        try:
            issues.extend(validate_fixture(path))
        except (OSError, ValueError, json.JSONDecodeError) as error:
            issues.append(f"{path.name}: {error}")

    result = {
        "ok": not issues,
        "fixtureCount": len(paths),
        "issueCount": len(issues),
        "issues": issues,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not issues else 1


if __name__ == "__main__":
    sys.exit(main())
