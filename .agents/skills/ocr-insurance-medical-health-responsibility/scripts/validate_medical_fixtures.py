#!/usr/bin/env python3
"""Validate focused medical-responsibility fixtures without external services."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


TOPOLOGY_TYPES = {"standalone", "rider", "group", "bundle_component"}
PAYMENT_MODES = {"reimbursement", "fixed_benefit", "mixed"}
NON_RESPONSIBILITY_CLASSES = {
    "definition",
    "expense_definition",
    "exclusion",
    "shared_rule",
    "product_service",
    "product_function",
    "group_heading",
    "care_process",
    "claims_process",
}
CARE_SETTINGS = {
    "inpatient",
    "ordinary_outpatient",
    "emergency",
    "special_outpatient",
    "outpatient_surgery",
    "pre_post_inpatient_outpatient",
    "special_drug",
    "proton_heavy_ion",
    "rehabilitation",
    "dental",
    "maternity",
    "overseas",
    "emergency_assistance",
}
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def add_issue(issues: list[str], fixture_id: str, field: str, message: str) -> None:
    issues.append(f"{fixture_id}:{field}:{message}")


def require_exact(
    issues: list[str],
    fixture_id: str,
    field: str,
    value: object,
    source_text: str,
) -> None:
    if not isinstance(value, str) or not value.strip():
        add_issue(issues, fixture_id, field, "missing_nonempty_text")
    elif value not in source_text:
        add_issue(issues, fixture_id, field, "not_exact_source_substring")


def validate_quantitative_entries(
    issues: list[str],
    fixture_id: str,
    field: str,
    entries: object,
    source_text: str,
) -> None:
    if not isinstance(entries, list):
        add_issue(issues, fixture_id, field, "must_be_array")
        return
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            add_issue(issues, fixture_id, f"{field}[{index}]", "must_be_object")
            continue
        require_exact(
            issues,
            fixture_id,
            f"{field}[{index}].valueText",
            entry.get("valueText"),
            source_text,
        )
        require_exact(
            issues,
            fixture_id,
            f"{field}[{index}].sourceExcerpt",
            entry.get("sourceExcerpt"),
            source_text,
        )
        scope_text = entry.get("scopeText")
        if scope_text:
            require_exact(
                issues,
                fixture_id,
                f"{field}[{index}].scopeText",
                scope_text,
                source_text,
            )


def validate_fixture(path: Path) -> dict[str, object]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    fixture_id = str(fixture.get("fixtureId") or path.stem)
    issues: list[str] = []
    source_text = fixture.get("sourceText")
    artifact = fixture.get("artifact")
    expected = fixture.get("expected")

    if not isinstance(source_text, str) or not source_text.strip():
        add_issue(issues, fixture_id, "sourceText", "missing_nonempty_text")
        source_text = ""
    if not isinstance(artifact, dict):
        add_issue(issues, fixture_id, "artifact", "must_be_object")
        artifact = {}
    if not isinstance(expected, dict):
        add_issue(issues, fixture_id, "expected", "must_be_object")
        expected = {}

    digest = artifact.get("sourceDigest")
    if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
        add_issue(issues, fixture_id, "artifact.sourceDigest", "invalid_sha256")

    topology = artifact.get("contractTopology")
    if not isinstance(topology, dict):
        add_issue(issues, fixture_id, "contractTopology", "must_be_object")
        topology = {}
    topology_type = topology.get("type")
    if topology_type not in TOPOLOGY_TYPES:
        add_issue(issues, fixture_id, "contractTopology.type", "invalid_value")
    for index, segment in enumerate(topology.get("evidenceSegments") or []):
        if not isinstance(segment, dict):
            add_issue(
                issues,
                fixture_id,
                f"contractTopology.evidenceSegments[{index}]",
                "must_be_object",
            )
            continue
        require_exact(
            issues,
            fixture_id,
            f"contractTopology.evidenceSegments[{index}].sourceExcerpt",
            segment.get("sourceExcerpt"),
            source_text,
        )

    if topology_type == "rider":
        parent = topology.get("parentContract")
        if not isinstance(parent, dict):
            add_issue(issues, fixture_id, "contractTopology.parentContract", "required")
        else:
            require_exact(
                issues,
                fixture_id,
                "contractTopology.parentContract.dependencyText",
                parent.get("dependencyText"),
                source_text,
            )
            for key in (
                "terminationLinkText",
                "insuredAmountReferenceText",
                "premiumReferenceText",
            ):
                if parent.get(key):
                    require_exact(
                        issues,
                        fixture_id,
                        f"contractTopology.parentContract.{key}",
                        parent[key],
                        source_text,
                    )
    elif topology_type == "group":
        group = topology.get("groupContract")
        if not isinstance(group, dict):
            add_issue(issues, fixture_id, "contractTopology.groupContract", "required")
        else:
            require_exact(
                issues,
                fixture_id,
                "contractTopology.groupContract.memberEligibilityText",
                group.get("memberEligibilityText"),
                source_text,
            )
            if group.get("limitAllocation") not in {
                "member_specific",
                "shared",
                "itemized",
                "mixed",
                "unknown",
            }:
                add_issue(
                    issues,
                    fixture_id,
                    "contractTopology.groupContract.limitAllocation",
                    "invalid_value",
                )
            for key in ("policyholderGroupText", "effectiveEntryText", "exitText"):
                if group.get(key):
                    require_exact(
                        issues,
                        fixture_id,
                        f"contractTopology.groupContract.{key}",
                        group[key],
                        source_text,
                    )
    elif topology_type == "bundle_component":
        bundle = topology.get("bundle")
        if not isinstance(bundle, dict):
            add_issue(issues, fixture_id, "contractTopology.bundle", "required")
        else:
            if bundle.get("marketingEvidenceRole") != "discovery_only":
                add_issue(
                    issues,
                    fixture_id,
                    "contractTopology.bundle.marketingEvidenceRole",
                    "must_be_discovery_only",
                )
            if not DIGEST_RE.fullmatch(str(bundle.get("componentSourceDigest") or "")):
                add_issue(
                    issues,
                    fixture_id,
                    "contractTopology.bundle.componentSourceDigest",
                    "invalid_sha256",
                )
            if not bundle.get("componentCompany") or not bundle.get("componentProductName"):
                add_issue(
                    issues,
                    fixture_id,
                    "contractTopology.bundle.componentIdentity",
                    "missing",
                )
            for index, segment in enumerate(bundle.get("mappingEvidenceSegments") or []):
                if not isinstance(segment, dict):
                    add_issue(
                        issues,
                        fixture_id,
                        f"contractTopology.bundle.mappingEvidenceSegments[{index}]",
                        "must_be_object",
                    )
                    continue
                require_exact(
                    issues,
                    fixture_id,
                    f"contractTopology.bundle.mappingEvidenceSegments[{index}].sourceExcerpt",
                    segment.get("sourceExcerpt"),
                    source_text,
                )

    responsibilities = artifact.get("responsibilities")
    if not isinstance(responsibilities, list) or not responsibilities:
        add_issue(issues, fixture_id, "responsibilities", "missing_nonempty_array")
        responsibilities = []
    responsibility_ids: set[str] = set()
    actual_titles: list[str] = []
    for index, responsibility in enumerate(responsibilities):
        prefix = f"responsibilities[{index}]"
        if not isinstance(responsibility, dict):
            add_issue(issues, fixture_id, prefix, "must_be_object")
            continue
        responsibility_id = responsibility.get("responsibilityId")
        if not isinstance(responsibility_id, str) or not responsibility_id:
            add_issue(issues, fixture_id, f"{prefix}.responsibilityId", "missing")
        elif responsibility_id in responsibility_ids:
            add_issue(issues, fixture_id, f"{prefix}.responsibilityId", "duplicate")
        else:
            responsibility_ids.add(responsibility_id)
        title = responsibility.get("liability")
        if isinstance(title, str):
            actual_titles.append(title)
        if responsibility.get("classification") != "insurance_responsibility":
            add_issue(issues, fixture_id, f"{prefix}.classification", "invalid_value")
        require_exact(
            issues,
            fixture_id,
            f"{prefix}.sourceExcerpt",
            responsibility.get("sourceExcerpt"),
            source_text,
        )
        require_exact(
            issues,
            fixture_id,
            f"{prefix}.triggerCondition",
            responsibility.get("triggerCondition"),
            source_text,
        )
        require_exact(
            issues,
            fixture_id,
            f"{prefix}.insurerObligation",
            responsibility.get("insurerObligation"),
            source_text,
        )
        profile = responsibility.get("medicalProfile")
        if not isinstance(profile, dict):
            add_issue(issues, fixture_id, f"{prefix}.medicalProfile", "must_be_object")
            continue
        if profile.get("paymentMode") not in PAYMENT_MODES:
            add_issue(issues, fixture_id, f"{prefix}.paymentMode", "invalid_value")
        for expense_index, expense in enumerate(profile.get("coveredExpenseItems") or []):
            require_exact(
                issues,
                fixture_id,
                f"{prefix}.coveredExpenseItems[{expense_index}]",
                expense,
                source_text,
            )
        invalid_settings = set(profile.get("careSettings") or []) - CARE_SETTINGS
        if invalid_settings:
            add_issue(
                issues,
                fixture_id,
                f"{prefix}.careSettings",
                f"invalid:{','.join(sorted(invalid_settings))}",
            )
        for key in ("deductibles", "reimbursementRates", "waitingPeriod", "paymentCounts"):
            validate_quantitative_entries(
                issues,
                fixture_id,
                f"{prefix}.medicalProfile.{key}",
                profile.get(key, []),
                source_text,
            )
        limits = profile.get("limits")
        if not isinstance(limits, dict):
            add_issue(issues, fixture_id, f"{prefix}.medicalProfile.limits", "must_be_object")
        else:
            for key in ("annual", "lifetime", "perEvent", "shared", "subLimits"):
                validate_quantitative_entries(
                    issues,
                    fixture_id,
                    f"{prefix}.medicalProfile.limits.{key}",
                    limits.get(key, []),
                    source_text,
                )

    non_responsibilities = artifact.get("nonResponsibilities") or []
    actual_non_titles: list[str] = []
    for index, item in enumerate(non_responsibilities):
        prefix = f"nonResponsibilities[{index}]"
        if not isinstance(item, dict):
            add_issue(issues, fixture_id, prefix, "must_be_object")
            continue
        if isinstance(item.get("title"), str):
            actual_non_titles.append(item["title"])
        if item.get("classification") not in NON_RESPONSIBILITY_CLASSES:
            add_issue(issues, fixture_id, f"{prefix}.classification", "invalid_value")
        require_exact(
            issues,
            fixture_id,
            f"{prefix}.sourceExcerpt",
            item.get("sourceExcerpt"),
            source_text,
        )

    expected_titles = expected.get("responsibilityTitles")
    if isinstance(expected_titles, list) and actual_titles != expected_titles:
        add_issue(issues, fixture_id, "expected.responsibilityTitles", "mismatch")
    expected_non_titles = expected.get("nonResponsibilityTitles")
    if isinstance(expected_non_titles, list) and actual_non_titles != expected_non_titles:
        add_issue(issues, fixture_id, "expected.nonResponsibilityTitles", "mismatch")
    if expected.get("topologyType") and expected["topologyType"] != topology_type:
        add_issue(issues, fixture_id, "expected.topologyType", "mismatch")

    return {
        "fixtureId": fixture_id,
        "path": str(path.resolve()),
        "ok": not issues,
        "responsibilityCount": len(responsibilities),
        "nonResponsibilityCount": len(non_responsibilities),
        "issues": issues,
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: validate_medical_fixtures.py <fixture-directory>", file=sys.stderr)
        return 2
    fixture_dir = Path(sys.argv[1]).resolve()
    paths = sorted(fixture_dir.glob("*.json"))
    if not paths:
        print(json.dumps({"ok": False, "error": "no_fixture_files"}, ensure_ascii=False))
        return 1
    results = [validate_fixture(path) for path in paths]
    payload = {
        "ok": all(result["ok"] for result in results),
        "fixtureCount": len(results),
        "passed": sum(bool(result["ok"]) for result in results),
        "failed": sum(not bool(result["ok"]) for result in results),
        "results": results,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
