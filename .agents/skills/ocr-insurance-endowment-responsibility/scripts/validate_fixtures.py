#!/usr/bin/env python3
"""Validate focused endowment-responsibility fixtures without external services."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
TOPOLOGIES = {"standalone", "rider", "group", "bundle_component"}
ROLES = {
    "death_or_total_disability",
    "maturity_survival",
    "periodic_annuity",
    "additional_accident",
}
COMPARISON_RE = re.compile(r"较大者|较小者|最大值|最小值|\bmax\s*\(|\bmin\s*\(", re.I)
RECURRING_RE = re.compile(r"每年|每月|每个保单周年日|逐年|年金")


def issue(issues: list[str], fixture_id: str, field: str, code: str) -> None:
    issues.append(f"{fixture_id}:{field}:{code}")


def exact_text(
    issues: list[str],
    fixture_id: str,
    field: str,
    value: Any,
    source_text: str,
    *,
    required: bool = True,
) -> None:
    if value in (None, "") and not required:
        return
    if not isinstance(value, str) or not value.strip():
        issue(issues, fixture_id, field, "missing_nonempty_text")
    elif value not in source_text:
        issue(issues, fixture_id, field, "not_exact_source_substring")


def validate_indicator(
    issues: list[str],
    fixture_id: str,
    prefix: str,
    indicator: Any,
    source_text: str,
) -> None:
    if not isinstance(indicator, dict):
        issue(issues, fixture_id, prefix, "must_be_object")
        return
    formula_text = indicator.get("formulaText")
    exact_text(
        issues,
        fixture_id,
        f"{prefix}.formulaText",
        formula_text,
        source_text,
    )
    required_inputs = indicator.get("requiredInputs")
    if not isinstance(required_inputs, list) or not required_inputs:
        issue(issues, fixture_id, f"{prefix}.requiredInputs", "missing_nonempty_array")

    branches = indicator.get("branches", [])
    operands = indicator.get("operands", [])
    if not isinstance(branches, list):
        issue(issues, fixture_id, f"{prefix}.branches", "must_be_array")
        branches = []
    if not isinstance(operands, list):
        issue(issues, fixture_id, f"{prefix}.operands", "must_be_array")
        operands = []

    if isinstance(formula_text, str) and COMPARISON_RE.search(formula_text) and not operands:
        issue(issues, fixture_id, f"{prefix}.operands", "comparison_requires_operands")

    for branch_index, branch in enumerate(branches):
        branch_prefix = f"{prefix}.branches[{branch_index}]"
        if not isinstance(branch, dict):
            issue(issues, fixture_id, branch_prefix, "must_be_object")
            continue
        for key in ("branchId", "basisKey", "calculationStatus"):
            if not isinstance(branch.get(key), str) or not branch[key]:
                issue(issues, fixture_id, f"{branch_prefix}.{key}", "missing")
        exact_text(
            issues,
            fixture_id,
            f"{branch_prefix}.conditionText",
            branch.get("conditionText"),
            source_text,
        )
        exact_text(
            issues,
            fixture_id,
            f"{branch_prefix}.formulaText",
            branch.get("formulaText"),
            source_text,
        )
        if not isinstance(branch.get("requiredInputs"), list) or not branch["requiredInputs"]:
            issue(
                issues,
                fixture_id,
                f"{branch_prefix}.requiredInputs",
                "missing_nonempty_array",
            )
        branch_operands = branch.get("operands", [])
        if not isinstance(branch_operands, list):
            issue(issues, fixture_id, f"{branch_prefix}.operands", "must_be_array")
        elif COMPARISON_RE.search(str(branch.get("formulaText") or "")) and not branch_operands:
            issue(
                issues,
                fixture_id,
                f"{branch_prefix}.operands",
                "comparison_requires_operands",
            )

    for operand_index, operand in enumerate(operands):
        operand_prefix = f"{prefix}.operands[{operand_index}]"
        if not isinstance(operand, dict):
            issue(issues, fixture_id, operand_prefix, "must_be_object")
            continue
        for key in ("operandId", "basisKey"):
            if not isinstance(operand.get(key), str) or not operand[key]:
                issue(issues, fixture_id, f"{operand_prefix}.{key}", "missing")
        exact_text(
            issues,
            fixture_id,
            f"{operand_prefix}.formulaText",
            operand.get("formulaText"),
            source_text,
        )
        if not isinstance(operand.get("requiredInputs"), list) or not operand["requiredInputs"]:
            issue(
                issues,
                fixture_id,
                f"{operand_prefix}.requiredInputs",
                "missing_nonempty_array",
            )


def validate_fixture(path: Path) -> dict[str, Any]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    fixture_id = str(fixture.get("fixtureId") or path.stem)
    source_text = fixture.get("sourceText")
    artifact = fixture.get("artifact")
    expected = fixture.get("expected")
    issues: list[str] = []

    if not isinstance(source_text, str) or not source_text.strip():
        issue(issues, fixture_id, "sourceText", "missing_nonempty_text")
        source_text = ""
    if not isinstance(artifact, dict):
        issue(issues, fixture_id, "artifact", "must_be_object")
        artifact = {}
    if not isinstance(expected, dict):
        issue(issues, fixture_id, "expected", "must_be_object")
        expected = {}

    digest = artifact.get("sourceDigest")
    if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
        issue(issues, fixture_id, "artifact.sourceDigest", "invalid_sha256")

    topology = artifact.get("contractTopology")
    if not isinstance(topology, dict):
        issue(issues, fixture_id, "artifact.contractTopology", "must_be_object")
        topology = {}
    topology_type = topology.get("type")
    if topology_type not in TOPOLOGIES:
        issue(issues, fixture_id, "artifact.contractTopology.type", "invalid_value")
    for index, segment in enumerate(topology.get("evidenceSegments") or []):
        if not isinstance(segment, dict):
            issue(
                issues,
                fixture_id,
                f"artifact.contractTopology.evidenceSegments[{index}]",
                "must_be_object",
            )
            continue
        exact_text(
            issues,
            fixture_id,
            f"artifact.contractTopology.evidenceSegments[{index}].sourceExcerpt",
            segment.get("sourceExcerpt"),
            source_text,
        )

    if topology_type == "rider":
        parent = topology.get("parentContract")
        if not isinstance(parent, dict):
            issue(issues, fixture_id, "artifact.contractTopology.parentContract", "required")
        else:
            exact_text(
                issues,
                fixture_id,
                "artifact.contractTopology.parentContract.dependencyText",
                parent.get("dependencyText"),
                source_text,
            )
            exact_text(
                issues,
                fixture_id,
                "artifact.contractTopology.parentContract.terminationLinkText",
                parent.get("terminationLinkText"),
                source_text,
            )
    elif topology_type == "group":
        group = topology.get("groupContract")
        if not isinstance(group, dict):
            issue(issues, fixture_id, "artifact.contractTopology.groupContract", "required")
        else:
            exact_text(
                issues,
                fixture_id,
                "artifact.contractTopology.groupContract.memberEligibilityText",
                group.get("memberEligibilityText"),
                source_text,
            )
    elif topology_type == "bundle_component":
        bundle = topology.get("bundle")
        if not isinstance(bundle, dict):
            issue(issues, fixture_id, "artifact.contractTopology.bundle", "required")
        else:
            if bundle.get("marketingEvidenceRole") != "discovery_only":
                issue(
                    issues,
                    fixture_id,
                    "artifact.contractTopology.bundle.marketingEvidenceRole",
                    "must_be_discovery_only",
                )
            if not DIGEST_RE.fullmatch(str(bundle.get("componentSourceDigest") or "")):
                issue(
                    issues,
                    fixture_id,
                    "artifact.contractTopology.bundle.componentSourceDigest",
                    "invalid_sha256",
                )

    responsibilities = artifact.get("responsibilities")
    if not isinstance(responsibilities, list):
        issue(issues, fixture_id, "artifact.responsibilities", "must_be_array")
        responsibilities = []

    roles: dict[str, list[str]] = {}
    ids: set[str] = set()
    for index, responsibility in enumerate(responsibilities):
        prefix = f"artifact.responsibilities[{index}]"
        if not isinstance(responsibility, dict):
            issue(issues, fixture_id, prefix, "must_be_object")
            continue
        responsibility_id = responsibility.get("responsibilityId")
        if not isinstance(responsibility_id, str) or not responsibility_id:
            issue(issues, fixture_id, f"{prefix}.responsibilityId", "missing")
            responsibility_id = f"missing-{index}"
        if responsibility_id in ids:
            issue(issues, fixture_id, f"{prefix}.responsibilityId", "duplicate")
        ids.add(responsibility_id)
        role = responsibility.get("responsibilityRole")
        if role not in ROLES:
            issue(issues, fixture_id, f"{prefix}.responsibilityRole", "invalid_value")
        else:
            roles.setdefault(role, []).append(responsibility_id)
        for field in ("triggerCondition", "insurerObligation", "sourceExcerpt"):
            exact_text(
                issues,
                fixture_id,
                f"{prefix}.{field}",
                responsibility.get(field),
                source_text,
            )
        exact_text(
            issues,
            fixture_id,
            f"{prefix}.terminationEffect",
            responsibility.get("terminationEffect"),
            source_text,
            required=False,
        )
        if role == "maturity_survival":
            if responsibility.get("cashflowTreatment") != "scheduled_cashflow":
                issue(
                    issues,
                    fixture_id,
                    f"{prefix}.cashflowTreatment",
                    "must_be_scheduled_cashflow",
                )
            if responsibility.get("cashflowCadence") != "once_at_maturity":
                issue(
                    issues,
                    fixture_id,
                    f"{prefix}.cashflowCadence",
                    "must_be_once_at_maturity",
                )
            combined = " ".join(
                str(responsibility.get(key) or "")
                for key in ("triggerCondition", "insurerObligation", "sourceExcerpt")
            )
            if RECURRING_RE.search(combined):
                issue(
                    issues,
                    fixture_id,
                    prefix,
                    "maturity_must_not_be_periodic_annuity",
                )
        for indicator_index, indicator in enumerate(responsibility.get("indicators") or []):
            validate_indicator(
                issues,
                fixture_id,
                f"{prefix}.indicators[{indicator_index}]",
                indicator,
                source_text,
            )

    product_functions = artifact.get("productFunctions", [])
    if not isinstance(product_functions, list):
        issue(issues, fixture_id, "artifact.productFunctions", "must_be_array")
        product_functions = []
    for index, function in enumerate(product_functions):
        prefix = f"artifact.productFunctions[{index}]"
        if not isinstance(function, dict):
            issue(issues, fixture_id, prefix, "must_be_object")
            continue
        exact_text(
            issues,
            fixture_id,
            f"{prefix}.sourceExcerpt",
            function.get("sourceExcerpt"),
            source_text,
        )
        if function.get("functionKind") == "participating_dividend":
            if function.get("guaranteeStatus") != "non_guaranteed":
                issue(
                    issues,
                    fixture_id,
                    f"{prefix}.guaranteeStatus",
                    "dividend_must_be_non_guaranteed",
                )

    for index, relationship in enumerate(artifact.get("benefitRelationships") or []):
        prefix = f"artifact.benefitRelationships[{index}]"
        if not isinstance(relationship, dict):
            issue(issues, fixture_id, prefix, "must_be_object")
            continue
        if relationship.get("semantics") not in {
            "additive",
            "substitutive",
            "exclusive",
            "capped_additive",
            "max_of",
        }:
            issue(issues, fixture_id, f"{prefix}.semantics", "invalid_value")
        if relationship.get("additionalResponsibilityId") not in ids:
            issue(
                issues,
                fixture_id,
                f"{prefix}.additionalResponsibilityId",
                "unknown_id",
            )
        if not set(relationship.get("baseResponsibilityIds") or []) <= ids:
            issue(
                issues,
                fixture_id,
                f"{prefix}.baseResponsibilityIds",
                "unknown_id",
            )
        exact_text(
            issues,
            fixture_id,
            f"{prefix}.sourceExcerpt",
            relationship.get("sourceExcerpt"),
            source_text,
        )

    expected_classification = expected.get("classification")
    actual_classification = "review"
    death_ids = set(roles.get("death_or_total_disability", []))
    maturity_ids = set(roles.get("maturity_survival", []))
    if death_ids and maturity_ids and death_ids.isdisjoint(maturity_ids):
        actual_classification = "endowment"
    elif death_ids and not maturity_ids:
        actual_classification = "not_endowment"

    if expected_classification and actual_classification != expected_classification:
        issue(
            issues,
            fixture_id,
            "expected.classification",
            f"expected_{expected_classification}_got_{actual_classification}",
        )

    expected_status = expected.get("status")
    if expected_status == "approved" and actual_classification != "endowment":
        issue(issues, fixture_id, "expected.status", "approved_requires_endowment_pair")

    return {
        "fixtureId": fixture_id,
        "path": str(path),
        "expectedStatus": expected_status,
        "expectedClassification": expected_classification,
        "actualClassification": actual_classification,
        "roleCounts": {key: len(value) for key, value in sorted(roles.items())},
        "issueCount": len(issues),
        "issues": issues,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixtures_dir", type=Path)
    args = parser.parse_args()
    paths = sorted(args.fixtures_dir.glob("*.json"))
    if not paths:
        print(json.dumps({"ok": False, "issues": ["no_fixtures"]}, ensure_ascii=False))
        return 1
    results = [validate_fixture(path) for path in paths]
    issues = [item for result in results for item in result["issues"]]
    output = {
        "ok": not issues,
        "fixtureCount": len(results),
        "issueCount": len(issues),
        "results": results,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0 if not issues else 1


if __name__ == "__main__":
    sys.exit(main())
