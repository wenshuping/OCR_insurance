#!/usr/bin/env python3
"""Validate unified responsibility fixtures and generated audit receipts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
TOPOLOGIES = {"standalone", "rider", "group", "bundle_component"}
OWNERS = {
    "medical_health",
    "critical_illness",
    "accident",
    "term_life",
    "annuity",
    "long_term_care",
    "endowment",
    "whole_life",
    "incremental_whole_life",
}
PAYMENTS = {
    "lump_sum",
    "medical_reimbursement",
    "daily_allowance",
    "annuity",
    "waiver",
    "account",
    "max_min_comparison",
    "fixed_benefit",
    "scheduled_maturity",
    "periodic_care",
    "disability_table",
}
STATUSES = {
    "source_pending",
    "source_blocked",
    "version_conflict",
    "parse_pending",
    "validation_review",
    "model_retry",
    "approved",
    "materializer_blocked",
    "import_pending",
    "imported",
    "manual_review",
}
ROUTES = {"deepseek-standard", "luna-complex"}
REQUIRED_FIXTURES = {
    "rider-inpatient-medical",
    "rider-accident-medical",
    "student-plan-mixed-components",
    "group-medical",
    "group-accident",
    "critical-illness-multiple-pay",
    "ordinary-term-life",
    "ordinary-annuity",
    "universal-annuity",
    "endowment-with-accident-extra",
    "long-term-care",
    "incremental-whole-life",
    "ordinary-whole-life-boundary",
}
AUDIT_JSON_FILES = {
    "immutable-manifest.json",
    "forward-test.json",
    "routing-audit.json",
    "handoff.json",
}


class ValidationError(Exception):
    pass


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"{path}: invalid JSON: {error}") from error


def fixture_files(fixtures_dir: Path) -> list[Path]:
    paths = sorted(fixtures_dir.glob("*.json"))
    if not paths:
        raise ValidationError(f"{fixtures_dir}: no JSON fixtures")
    return paths


def load_fixtures(fixtures_dir: Path) -> list[dict[str, Any]]:
    fixtures: list[dict[str, Any]] = []
    for path in fixture_files(fixtures_dir):
        value = load_json(path)
        rows = value if isinstance(value, list) else [value]
        if not all(isinstance(row, dict) for row in rows):
            raise ValidationError(f"{path}: every fixture must be an object")
        fixtures.extend(rows)
    return fixtures


def require_text(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{location}: expected non-empty text")
    return value.strip()


def validate_fixtures(fixtures_dir: Path) -> dict[str, Any]:
    fixtures = load_fixtures(fixtures_dir)
    if len(fixtures) < 12:
        raise ValidationError(f"expected at least 12 fixtures, found {len(fixtures)}")

    fixture_ids: set[str] = set()
    topologies: set[str] = set()
    owners_seen: set[str] = set()
    payments_seen: set[str] = set()
    routes: dict[str, int] = {route: 0 for route in sorted(ROUTES)}
    responsibility_keys: set[tuple[str, str, str, str]] = set()
    conflicts = 0

    for index, fixture in enumerate(fixtures):
        location = f"fixture[{index}]"
        fixture_id = require_text(fixture.get("fixtureId"), f"{location}.fixtureId")
        if fixture_id in fixture_ids:
            raise ValidationError(f"{location}: duplicate fixtureId {fixture_id}")
        fixture_ids.add(fixture_id)

        identity = fixture.get("productIdentity")
        if not isinstance(identity, dict):
            raise ValidationError(f"{location}.productIdentity: expected object")
        for field in ("company", "productName", "sourceUrl"):
            require_text(identity.get(field), f"{location}.productIdentity.{field}")
        digest = require_text(
            identity.get("sourceDigest"), f"{location}.productIdentity.sourceDigest"
        )
        if not DIGEST_RE.fullmatch(digest):
            raise ValidationError(f"{location}: invalid sourceDigest {digest}")

        topology = fixture.get("contractTopology")
        if not isinstance(topology, dict):
            raise ValidationError(f"{location}.contractTopology: expected object")
        topology_type = require_text(topology.get("type"), f"{location}.contractTopology.type")
        if topology_type not in TOPOLOGIES:
            raise ValidationError(f"{location}: unsupported topology {topology_type}")
        if topology.get("evidenceStatus") != "verified":
            raise ValidationError(f"{location}: fixture topology must have verified evidence")
        require_text(topology.get("evidenceText"), f"{location}.contractTopology.evidenceText")
        topologies.add(topology_type)

        inventory = fixture.get("inventory")
        if not isinstance(inventory, list) or not inventory:
            raise ValidationError(f"{location}.inventory: expected non-empty list")

        actual_owners: set[str] = set()
        actual_payments: set[str] = set()
        fixture_has_conflict = False
        for responsibility_index, responsibility in enumerate(inventory):
            responsibility_location = f"{location}.inventory[{responsibility_index}]"
            responsibility_id = require_text(
                responsibility.get("responsibilityId"),
                f"{responsibility_location}.responsibilityId",
            )
            title = require_text(
                responsibility.get("officialTitle"),
                f"{responsibility_location}.officialTitle",
            )
            packet = responsibility.get("evidencePacket")
            if not isinstance(packet, dict):
                raise ValidationError(f"{responsibility_location}.evidencePacket: expected object")
            packet_id = require_text(
                packet.get("packetId"), f"{responsibility_location}.evidencePacket.packetId"
            )
            exact_text = require_text(
                packet.get("exactText"), f"{responsibility_location}.evidencePacket.exactText"
            )
            trigger = require_text(
                packet.get("trigger"), f"{responsibility_location}.evidencePacket.trigger"
            )
            obligation = require_text(
                packet.get("obligation"), f"{responsibility_location}.evidencePacket.obligation"
            )
            if trigger not in exact_text or obligation not in exact_text:
                raise ValidationError(
                    f"{responsibility_location}: trigger and obligation must occur in exactText"
                )

            responsibility_key = (digest, responsibility_id, title, packet_id)
            if responsibility_key in responsibility_keys:
                raise ValidationError(
                    f"{responsibility_location}: duplicate immutable responsibility key"
                )
            responsibility_keys.add(responsibility_key)

            owner = responsibility.get("ownerProfile")
            proposals = responsibility.get("ownerProposals")
            if owner is not None and proposals is not None:
                raise ValidationError(
                    f"{responsibility_location}: ownerProfile and ownerProposals are exclusive"
                )
            if proposals is not None:
                if (
                    not isinstance(proposals, list)
                    or len(set(proposals)) < 2
                    or not set(proposals).issubset(OWNERS)
                ):
                    raise ValidationError(
                        f"{responsibility_location}: owner conflict needs 2+ valid proposals"
                    )
                fixture_has_conflict = True
            else:
                owner_text = require_text(owner, f"{responsibility_location}.ownerProfile")
                if owner_text not in OWNERS:
                    raise ValidationError(
                        f"{responsibility_location}: unsupported owner {owner_text}"
                    )
                actual_owners.add(owner_text)
                owners_seen.add(owner_text)

            payment_profiles = responsibility.get("paymentProfile")
            if (
                not isinstance(payment_profiles, list)
                or not payment_profiles
                or not set(payment_profiles).issubset(PAYMENTS)
            ):
                raise ValidationError(
                    f"{responsibility_location}: unsupported or empty paymentProfile"
                )
            actual_payments.update(payment_profiles)
            payments_seen.update(payment_profiles)

            formula = responsibility.get("formula")
            if not isinstance(formula, dict):
                raise ValidationError(f"{responsibility_location}.formula: expected object")
            for field in ("formulaText", "normalizedFormula"):
                require_text(formula.get(field), f"{responsibility_location}.formula.{field}")
            for field in ("requiredInputs", "operands", "branches"):
                if not isinstance(formula.get(field), list):
                    raise ValidationError(
                        f"{responsibility_location}.formula.{field}: expected list"
                    )

        expected = fixture.get("expected")
        if not isinstance(expected, dict):
            raise ValidationError(f"{location}.expected: expected object")
        status = expected.get("status")
        route = expected.get("route")
        if status not in STATUSES:
            raise ValidationError(f"{location}: unsupported status {status}")
        if route not in ROUTES:
            raise ValidationError(f"{location}: unsupported route {route}")
        routes[route] += 1

        if set(expected.get("ownerProfiles", [])) != actual_owners:
            raise ValidationError(f"{location}: expected ownerProfiles do not match inventory")
        if set(expected.get("paymentProfiles", [])) != actual_payments:
            raise ValidationError(f"{location}: expected paymentProfiles do not match inventory")
        if fixture_has_conflict:
            conflicts += 1
            if status != "manual_review" or expected.get("ownerConflict") is not True:
                raise ValidationError(
                    f"{location}: owner conflict must be explicit manual_review"
                )
        elif expected.get("ownerConflict"):
            raise ValidationError(f"{location}: unexpected ownerConflict flag")

        if route == "deepseek-standard":
            if not actual_owners.issubset({"term_life", "annuity"}):
                raise ValidationError(
                    f"{location}: DeepSeek fixture must be simple term life or annuity"
                )
            if any(
                responsibility["formula"]["branches"]
                or responsibility["formula"]["operands"]
                for responsibility in inventory
            ):
                raise ValidationError(
                    f"{location}: DeepSeek fixture cannot contain branches or operands"
                )

    missing_fixtures = REQUIRED_FIXTURES - fixture_ids
    if missing_fixtures:
        raise ValidationError(f"missing required fixtures: {sorted(missing_fixtures)}")
    if topologies != TOPOLOGIES:
        raise ValidationError(f"fixture topology coverage mismatch: {sorted(topologies)}")
    required_payments = {
        "lump_sum",
        "medical_reimbursement",
        "daily_allowance",
        "annuity",
        "waiver",
        "account",
        "max_min_comparison",
    }
    missing_payments = required_payments - payments_seen
    if missing_payments:
        raise ValidationError(
            f"missing required payment profiles: {sorted(missing_payments)}"
        )

    return {
        "ok": True,
        "fixtureCount": len(fixtures),
        "topologies": sorted(topologies),
        "ownerProfiles": sorted(owners_seen),
        "paymentProfiles": sorted(payments_seen),
        "routes": routes,
        "ownerConflictFixtures": conflicts,
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_audit(audit_dir: Path) -> dict[str, Any]:
    missing = sorted(name for name in AUDIT_JSON_FILES if not (audit_dir / name).is_file())
    if missing:
        raise ValidationError(f"{audit_dir}: missing audit JSON files {missing}")
    for name in sorted(AUDIT_JSON_FILES):
        load_json(audit_dir / name)

    sha_path = audit_dir / "SHA256SUMS"
    if not sha_path.is_file():
        raise ValidationError(f"{audit_dir}: missing SHA256SUMS")
    seen: set[str] = set()
    for line_number, line in enumerate(
        sha_path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        parts = line.split("  ", 1)
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            raise ValidationError(f"{sha_path}:{line_number}: invalid SHA line")
        expected, name = parts
        file_path = audit_dir / name
        if name not in AUDIT_JSON_FILES or not file_path.is_file():
            raise ValidationError(f"{sha_path}:{line_number}: unexpected file {name}")
        if sha256_file(file_path) != expected:
            raise ValidationError(f"{sha_path}:{line_number}: digest mismatch for {name}")
        seen.add(name)
    if seen != AUDIT_JSON_FILES:
        raise ValidationError(f"{sha_path}: incomplete JSON coverage")

    manifest = load_json(audit_dir / "immutable-manifest.json")
    forward = load_json(audit_dir / "forward-test.json")
    routing = load_json(audit_dir / "routing-audit.json")
    if manifest.get("readOnly") != {"sqliteMode": "ro", "queryOnly": True}:
        raise ValidationError("immutable manifest does not prove read-only SQLite")
    selected = manifest.get("selected")
    if not isinstance(selected, list) or len(selected) < 40:
        raise ValidationError("immutable manifest must contain at least 40 selected products")
    dedupe_keys = [row.get("dedupeKey") for row in selected]
    if None in dedupe_keys or len(dedupe_keys) != len(set(dedupe_keys)):
        raise ValidationError("immutable manifest selected identities are not mutually exclusive")
    if forward.get("summary", {}).get("sampleCount") != len(selected):
        raise ValidationError("forward-test sample count does not match manifest")
    route_counts = routing.get("modelRoutes", {})
    if sum(int(value) for value in route_counts.values()) != len(selected):
        raise ValidationError("routing model counts do not match manifest")
    prohibited = forward.get("execution", {}).get("prohibitedInvocations", {})
    if not prohibited or any(prohibited.values()):
        raise ValidationError("forward-test did not prove prohibited invocations were zero")

    return {
        "ok": True,
        "auditDir": str(audit_dir.resolve()),
        "sampleCount": len(selected),
        "shaFiles": sorted(seen),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--audit-dir", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        result: dict[str, Any] = {
            "fixtures": validate_fixtures(args.fixtures.resolve()),
        }
        if args.audit_dir:
            result["audit"] = validate_audit(args.audit_dir.resolve())
    except ValidationError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
