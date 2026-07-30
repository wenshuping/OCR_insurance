#!/usr/bin/env python3
"""Validate the accident-responsibility focused fixtures."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


TOPOLOGIES = {"standalone", "rider", "group", "bundle_component"}
SUPPORTING_ROLES = {
    "definition",
    "attachment_rule",
    "exclusion",
    "occupation_rule",
    "claims_process",
    "generic_heading",
}
RELATIONSHIP_SEMANTICS = {
    "additive",
    "substitutive",
    "exclusive",
    "max_of",
    "capped_additive",
}
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
EXTRA_MARKERS = ("额外给付", "再按", "同时，再按", "同时再按", "在给付", "除给付")


def nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def topology_issues(fixture: dict) -> list[str]:
    topology = fixture.get("contractTopology")
    evidence = fixture.get("topologyEvidence") or {}
    issues: list[str] = []
    if topology not in TOPOLOGIES:
        return ["invalid_contract_topology"]

    if topology == "standalone":
        if not nonempty(evidence.get("sourceTypeEvidence")) or not nonempty(
            evidence.get("ownContractRule")
        ):
            issues.append("standalone_topology_evidence_missing")
    elif topology == "rider":
        dependency = evidence.get("mainContractDependency") or {}
        linkage = evidence.get("effectiveTerminationLinkage") or {}
        amount = evidence.get("insuredAmountReference") or {}
        if not nonempty(dependency.get("sourceExcerpt")):
            issues.append("rider_main_contract_dependency_missing")
        if not (
            nonempty(linkage.get("effectiveRule"))
            and nonempty(linkage.get("terminationRule"))
            and nonempty(linkage.get("sourceExcerpt"))
        ):
            issues.append("rider_effective_termination_linkage_missing")
        if not (
            amount.get("source")
            in {"main_contract", "rider_schedule", "separately_agreed"}
            and nonempty(amount.get("formulaText"))
            and nonempty(amount.get("sourceExcerpt"))
        ):
            issues.append("rider_insured_amount_reference_missing")
    elif topology == "group":
        membership = evidence.get("memberEligibility") or {}
        plan = evidence.get("planTier") or {}
        if not (
            nonempty(membership.get("entryRule"))
            and nonempty(membership.get("exitRule"))
            and nonempty(membership.get("sourceExcerpt"))
        ):
            issues.append("group_member_eligibility_missing")
        if not (
            nonempty(plan.get("tierId"))
            and nonempty(plan.get("insuredAmountOrLimitSource"))
            and nonempty(plan.get("sourceExcerpt"))
        ):
            issues.append("group_plan_tier_missing")
    else:
        bundle = evidence.get("bundleEvidence") or {}
        identity = evidence.get("filedComponentIdentity") or {}
        if not nonempty(bundle.get("sourceExcerpt")):
            issues.append("bundle_component_evidence_missing")
        if not (
            nonempty(identity.get("company"))
            and nonempty(identity.get("productName"))
            and DIGEST_RE.fullmatch(str(identity.get("sourceDigest", "")))
        ):
            issues.append("bundle_component_identity_missing")
        if evidence.get("componentContractTopology") not in {
            "standalone",
            "rider",
            "group",
        }:
            issues.append("bundle_component_underlying_topology_missing")
    return issues


def validate_fixture(fixture: dict) -> list[str]:
    issues: list[str] = []
    identity = fixture.get("identity") or {}
    if not nonempty(fixture.get("fixtureId")):
        issues.append("fixture_id_missing")
    if not (
        nonempty(identity.get("company"))
        and nonempty(identity.get("productName"))
        and DIGEST_RE.fullmatch(str(identity.get("sourceDigest", "")))
    ):
        issues.append("invalid_exact_identity")

    issues.extend(topology_issues(fixture))
    sections = fixture.get("sections")
    if not isinstance(sections, list) or not sections:
        return issues + ["sections_missing"]

    responsibility_ids: set[str] = set()
    supporting_ids: set[str] = set()
    section_ids: set[str] = set()
    attachments: list[tuple[str, str]] = []
    for section in sections:
        section_id = section.get("sectionId")
        role = section.get("role")
        if not nonempty(section_id) or section_id in section_ids:
            issues.append("invalid_or_duplicate_section_id")
            continue
        section_ids.add(section_id)
        if not nonempty(section.get("sourceExcerpt")):
            issues.append(f"source_excerpt_missing:{section_id}")

        if role == "responsibility":
            responsibility_ids.add(section_id)
            if not nonempty(section.get("triggerCondition")):
                issues.append(f"trigger_missing:{section_id}")
            if not nonempty(section.get("insurerObligation")):
                issues.append(f"obligation_missing:{section_id}")
            combined = " ".join(
                str(section.get(key, ""))
                for key in ("insurerObligation", "sourceExcerpt")
            )
            if any(marker in combined for marker in EXTRA_MARKERS):
                relationship = section.get("benefitRelationship") or {}
                if not relationship.get("baseResponsibilityIds"):
                    issues.append(f"extra_benefit_base_missing:{section_id}")
                if relationship.get("semantics") not in RELATIONSHIP_SEMANTICS:
                    issues.append(f"extra_benefit_semantics_missing:{section_id}")
        elif role in SUPPORTING_ROLES:
            supporting_ids.add(section_id)
            if role == "attachment_rule":
                target = section.get("attachmentToResponsibilityId")
                if nonempty(target):
                    attachments.append((section_id, target))
                else:
                    issues.append(f"attachment_target_missing:{section_id}")
        else:
            issues.append(f"invalid_section_role:{section_id}")

    for section_id, target in attachments:
        if target not in responsibility_ids:
            issues.append(f"attachment_target_not_responsibility:{section_id}")

    expected = fixture.get("expected") or {}
    if set(expected.get("responsibilityIds") or []) != responsibility_ids:
        issues.append("expected_responsibility_set_mismatch")
    if set(expected.get("supportingSectionIds") or []) != supporting_ids:
        issues.append("expected_supporting_set_mismatch")
    return sorted(set(issues))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "fixtures",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    results = []
    failed = False
    paths = sorted(args.fixtures.glob("*.json"))
    if len(paths) < 7:
        print(json.dumps({"ok": False, "error": "at_least_7_fixtures_required"}))
        return 1

    for path in paths:
        try:
            fixture = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            results.append({"path": str(path), "ok": False, "error": str(exc)})
            failed = True
            continue
        issues = validate_fixture(fixture)
        status = "review" if issues else "approved"
        expected = fixture.get("expected") or {}
        expected_issues = set(expected.get("issueCodes") or [])
        expected_status = expected.get("status")
        ok = status == expected_status and expected_issues == set(issues)
        if not ok:
            failed = True
        results.append(
            {
                "fixtureId": fixture.get("fixtureId"),
                "path": str(path),
                "realSample": bool(fixture.get("realSample")),
                "contractTopology": fixture.get("contractTopology"),
                "status": status,
                "issues": issues,
                "expectedStatus": expected_status,
                "expectedIssues": sorted(expected_issues),
                "ok": ok,
            }
        )

    output = {
        "ok": not failed,
        "fixtureCount": len(results),
        "realFixtureCount": sum(1 for item in results if item.get("realSample")),
        "topologies": sorted(
            {item["contractTopology"] for item in results if item.get("contractTopology")}
        ),
        "results": results,
    }
    rendered = json.dumps(output, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
