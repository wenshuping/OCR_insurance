#!/usr/bin/env python3
"""Validate focused annuity-responsibility fixtures without external services."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
TOPOLOGIES = {"standalone", "rider", "group", "bundle_component"}
FREQUENCIES = {"annual", "monthly", "installment", "lump_sum", "multiple", "other"}
PERIOD_TYPES = {"lifetime", "fixed_term", "until_age", "until_maturity", "single_payment", "other"}
GUARANTEE_TYPES = {"none", "fixed_period", "guaranteed_total", "refund_balance", "other"}
GROWTH_TYPES = {
    "level",
    "arithmetic_increase",
    "geometric_increase",
    "decrease",
    "table",
    "other",
}
NON_RESPONSIBILITY_ROLES = {
    "group_heading",
    "shared_rule",
    "definition",
    "exclusion",
    "claim_procedure",
    "product_function",
    "product_service",
    "unresolved",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixtures_dir", nargs="?", default="fixtures")
    return parser.parse_args()


def require_exact(
    issues: list[str],
    fixture_id: str,
    field: str,
    value: object,
    source_text: str,
) -> None:
    if not isinstance(value, str) or not value.strip():
        issues.append(f"{fixture_id}:{field}:missing_nonempty_text")
    elif value not in source_text:
        issues.append(f"{fixture_id}:{field}:not_exact_source_substring")


def validate_indicator(
    issues: list[str],
    fixture_id: str,
    field: str,
    indicator: object,
    source_text: str,
) -> None:
    if not isinstance(indicator, dict):
        issues.append(f"{fixture_id}:{field}:must_be_object")
        return
    if not indicator.get("formulaText"):
        issues.append(f"{fixture_id}:{field}.formulaText:missing")
    if not indicator.get("basisKey"):
        issues.append(f"{fixture_id}:{field}.basisKey:missing")
    if not isinstance(indicator.get("requiredInputs"), list):
        issues.append(f"{fixture_id}:{field}.requiredInputs:must_be_array")
    for token_index, token in enumerate(indicator.get("evidenceTokens") or []):
        require_exact(
            issues,
            fixture_id,
            f"{field}.evidenceTokens[{token_index}]",
            token,
            source_text,
        )
    branches = indicator.get("branches") or []
    operands = indicator.get("operands") or []
    if not isinstance(branches, list) or not isinstance(operands, list):
        issues.append(f"{fixture_id}:{field}:branches_and_operands_must_be_arrays")
        return
    for index, branch in enumerate(branches):
        prefix = f"{field}.branches[{index}]"
        if not isinstance(branch, dict):
            issues.append(f"{fixture_id}:{prefix}:must_be_object")
            continue
        for key in ("branchId", "conditionText", "formulaText", "basisKey"):
            if not branch.get(key):
                issues.append(f"{fixture_id}:{prefix}.{key}:missing")
        require_exact(
            issues,
            fixture_id,
            f"{prefix}.conditionText",
            branch.get("conditionText"),
            source_text,
        )
        if not isinstance(branch.get("requiredInputs"), list):
            issues.append(f"{fixture_id}:{prefix}.requiredInputs:must_be_array")
    for index, operand in enumerate(operands):
        prefix = f"{field}.operands[{index}]"
        if not isinstance(operand, dict):
            issues.append(f"{fixture_id}:{prefix}:must_be_object")
            continue
        for key in ("operandId", "formulaText", "basisKey"):
            if not operand.get(key):
                issues.append(f"{fixture_id}:{prefix}.{key}:missing")
        if not isinstance(operand.get("requiredInputs"), list):
            issues.append(f"{fixture_id}:{prefix}.requiredInputs:must_be_array")


def validate_fixture(path: Path) -> dict[str, object]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    fixture_id = str(fixture.get("fixtureId") or path.stem)
    issues: list[str] = []
    identity = fixture.get("identity")
    source_text = fixture.get("sourceText")
    topology = fixture.get("contractTopology")
    responsibilities = fixture.get("responsibilities")
    non_responsibilities = fixture.get("nonResponsibilities") or []

    if not isinstance(source_text, str) or not source_text.strip():
        issues.append(f"{fixture_id}:sourceText:missing_nonempty_text")
        source_text = ""
    if not isinstance(identity, dict):
        issues.append(f"{fixture_id}:identity:must_be_object")
        identity = {}
    for key in ("company", "productName"):
        if not identity.get(key):
            issues.append(f"{fixture_id}:identity.{key}:missing")
    if not DIGEST_RE.fullmatch(str(identity.get("sourceDigest") or "")):
        issues.append(f"{fixture_id}:identity.sourceDigest:invalid_sha256")

    if not isinstance(topology, dict):
        issues.append(f"{fixture_id}:contractTopology:must_be_object")
        topology = {}
    topology_type = topology.get("type")
    if topology_type not in TOPOLOGIES:
        issues.append(f"{fixture_id}:contractTopology.type:invalid")
    for index, segment in enumerate(topology.get("evidenceSegments") or []):
        require_exact(
            issues,
            fixture_id,
            f"contractTopology.evidenceSegments[{index}].sourceExcerpt",
            segment.get("sourceExcerpt") if isinstance(segment, dict) else None,
            source_text,
        )

    if not isinstance(responsibilities, list) or not responsibilities:
        issues.append(f"{fixture_id}:responsibilities:missing_nonempty_array")
        responsibilities = []
    seen_ids: set[str] = set()
    for index, responsibility in enumerate(responsibilities):
        prefix = f"responsibilities[{index}]"
        if not isinstance(responsibility, dict):
            issues.append(f"{fixture_id}:{prefix}:must_be_object")
            continue
        responsibility_id = responsibility.get("responsibilityId")
        if not responsibility_id or responsibility_id in seen_ids:
            issues.append(f"{fixture_id}:{prefix}.responsibilityId:missing_or_duplicate")
        else:
            seen_ids.add(str(responsibility_id))
        if responsibility.get("role") not in {
            "annuity_responsibility",
            "death_responsibility",
            "maturity_responsibility",
            "waiver_responsibility",
            "other_insurance_responsibility",
        }:
            issues.append(f"{fixture_id}:{prefix}.role:invalid")
        for key in ("triggerCondition", "insurerObligation", "sourceExcerpt"):
            require_exact(
                issues,
                fixture_id,
                f"{prefix}.{key}",
                responsibility.get(key),
                source_text,
            )
        profile = responsibility.get("annuityProfile")
        if responsibility.get("role") == "annuity_responsibility":
            if not isinstance(profile, dict):
                issues.append(f"{fixture_id}:{prefix}.annuityProfile:required")
                continue
            for key in ("startConditionText", "survivalConditionText"):
                require_exact(
                    issues,
                    fixture_id,
                    f"{prefix}.annuityProfile.{key}",
                    profile.get(key),
                    source_text,
                )
            frequency = profile.get("frequency") or {}
            payment_period = profile.get("paymentPeriod") or {}
            guarantee = profile.get("guarantee") or {}
            growth_rule = profile.get("growthRule") or {}
            if frequency.get("type") not in FREQUENCIES:
                issues.append(f"{fixture_id}:{prefix}.annuityProfile.frequency.type:invalid")
            if payment_period.get("type") not in PERIOD_TYPES:
                issues.append(f"{fixture_id}:{prefix}.annuityProfile.paymentPeriod.type:invalid")
            if guarantee.get("type") not in GUARANTEE_TYPES:
                issues.append(f"{fixture_id}:{prefix}.annuityProfile.guarantee.type:invalid")
            if growth_rule.get("type") not in GROWTH_TYPES:
                issues.append(f"{fixture_id}:{prefix}.annuityProfile.growthRule.type:invalid")
            if not isinstance(profile.get("terminationConditions"), list):
                issues.append(
                    f"{fixture_id}:{prefix}.annuityProfile.terminationConditions:must_be_array"
                )
        indicators = responsibility.get("indicators")
        if not isinstance(indicators, list) or not indicators:
            issues.append(f"{fixture_id}:{prefix}.indicators:missing_nonempty_array")
        else:
            for indicator_index, indicator in enumerate(indicators):
                validate_indicator(
                    issues,
                    fixture_id,
                    f"{prefix}.indicators[{indicator_index}]",
                    indicator,
                    source_text,
                )

    for index, item in enumerate(non_responsibilities):
        prefix = f"nonResponsibilities[{index}]"
        if not isinstance(item, dict):
            issues.append(f"{fixture_id}:{prefix}:must_be_object")
            continue
        if item.get("role") not in NON_RESPONSIBILITY_ROLES:
            issues.append(f"{fixture_id}:{prefix}.role:invalid")
        require_exact(
            issues,
            fixture_id,
            f"{prefix}.sourceExcerpt",
            item.get("sourceExcerpt"),
            source_text,
        )

    return {"path": str(path), "fixtureId": fixture_id, "ok": not issues, "issues": issues}


def main() -> int:
    fixtures_dir = Path(parse_args().fixtures_dir).resolve()
    paths = sorted(fixtures_dir.glob("*.json"))
    results = [validate_fixture(path) for path in paths]
    fixture_ids = [result["fixtureId"] for result in results]
    issues = [issue for result in results for issue in result["issues"]]
    if len(paths) < 8:
        issues.append(f"fixtures:expected_at_least_8:found_{len(paths)}")
    if len(fixture_ids) != len(set(fixture_ids)):
        issues.append("fixtures:duplicate_fixture_id")
    output = {
        "ok": not issues,
        "fixtureCount": len(paths),
        "passedCount": sum(1 for result in results if result["ok"]),
        "issues": issues,
        "results": results,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
