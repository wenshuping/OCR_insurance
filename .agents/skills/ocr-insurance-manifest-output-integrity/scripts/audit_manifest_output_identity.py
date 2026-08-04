#!/usr/bin/env python3
"""Deterministically audit manifest-to-output identity before validation.

The script is intentionally model-, database-, and network-free.  It accepts a
small JSON bundle for tests or discovers the immutable identity records from a
batch run directory.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any


LAYER_NAMES = ("selected", "input", "provider", "artifact", "terminal")
MISALIGN_CODES = {
    "duplicate_item",
    "missing_item",
    "unknown_item",
    "layer_set_mismatch",
    "ordinal_mismatch",
    "resume_copied_last_item",
    "artifact_container_identity_mismatch",
    "selected_lock_mismatch",
    "terminal_union_mismatch",
    "terminal_intersection",
}
BLOCK_CODES = {
    "manifest_duplicate_identity",
    "missing_source_digest",
    "identity_fields_disagree",
    "version_conflict",
    "validator_before_identity_gate",
    "approved_identity_reuse_blocked",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(path: Path) -> list[Any]:
    rows: list[Any] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSONL at {path}:{line_number}: {exc}") from exc
    return rows


def text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def normalized(value: Any) -> str:
    value = unicodedata.normalize("NFKC", text(value)).casefold()
    return re.sub(r"[\s\-‐‑‒–—―_·•:：,，。.!！?？()（）\[\]【】《》]+", "", value)


def normalized_company(value: Any) -> str:
    value = normalized(value)
    for suffix in ("人寿保险股份有限公司", "保险股份有限公司", "保险有限公司", "人寿保险公司", "保险公司", "保险"):
        if value.endswith(suffix):
            value = value[: -len(suffix)]
            break
    return value


def nested_identity(row: dict[str, Any]) -> dict[str, Any]:
    for key in ("productIdentity", "identity", "product"):
        if isinstance(row.get(key), dict):
            return row[key]
    return {}


def field(row: dict[str, Any], *names: str) -> str:
    identity = nested_identity(row)
    for name in names:
        value = row.get(name)
        if value not in (None, ""):
            return text(value)
        value = identity.get(name)
        if value not in (None, ""):
            return text(value)
    return ""


def as_record(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        return {"sourceDigest": value}
    if not isinstance(value, dict):
        return {"raw": value}
    return value


def identity_parts(row: dict[str, Any]) -> dict[str, str]:
    return {
        "digest": field(row, "sourceDigest", "source_digest"),
        "url": field(row, "sourceUrl", "source_url", "url"),
        "company": field(row, "company", "displayCompany"),
        "productName": field(row, "productName", "product_name", "name"),
    }


def keys_for(row: dict[str, Any]) -> list[str]:
    parts = identity_parts(row)
    keys: list[str] = []
    if parts["digest"]:
        keys.append("digest:" + parts["digest"])
    if parts["url"]:
        keys.append("url:" + parts["url"])
    if parts["company"] or parts["productName"]:
        keys.append("name:" + normalized_company(parts["company"]) + "|" + normalized(parts["productName"]))
    return keys


def display(row: dict[str, Any]) -> str:
    parts = identity_parts(row)
    return parts["digest"] or parts["url"] or "+".join(x for x in (parts["company"], parts["productName"]) if x) or "<missing>"


def parse_container_identity(value: Any) -> tuple[str, str]:
    name = Path(text(value)).parent.name if text(value).endswith(".json") else Path(text(value)).name
    match = re.match(r"^\d+-(.+?)-(.+)$", name)
    if not match:
        return "", ""
    return match.group(1), match.group(2)


def add_issue(issues: list[dict[str, Any]], code: str, layer: str | None = None, **details: Any) -> None:
    item: dict[str, Any] = {"code": code}
    if layer:
        item["layer"] = layer
    item.update(details)
    issues.append(item)


def bundle_from_run(manifest_path: Path, run_dir: Path) -> dict[str, Any]:
    manifest = load_json(manifest_path)
    if isinstance(manifest, dict):
        manifest = manifest.get("products") or manifest.get("manifest") or []
    summary = load_json(run_dir / "summary.json") if (run_dir / "summary.json").exists() else {}
    selection_lock = load_json(run_dir / "input-lock.json") if (run_dir / "input-lock.json").exists() else {}
    selected = summary.get("products") if isinstance(summary, dict) else None
    if not isinstance(selected, list):
        selected = []

    inputs = []
    input_root = run_dir / "inputs"
    if input_root.exists():
        for path in sorted(input_root.glob("*/input.json")):
            inputs.append({**load_json(path), "_path": str(path)})

    products = run_dir / "products"
    providers = []
    artifacts = []
    validator_receipts = []
    terminals = []
    if products.exists():
        for directory in sorted(path for path in products.iterdir() if path.is_dir()):
            provider_path = directory / "provider-receipt.json"
            if provider_path.exists():
                providers.append({**load_json(provider_path), "_path": str(provider_path)})
            for candidate in ("artifact.json", "canonical-artifact.json", "raw-artifact.json"):
                artifact_path = directory / candidate
                if artifact_path.exists():
                    artifacts.append({
                        **load_json(artifact_path),
                        "_path": str(artifact_path),
                        "_container": directory.name,
                        "_artifactPath": str(artifact_path),
                    })
                    break
            validator_path = directory / "validator-receipt.json"
            if validator_path.exists():
                validator_receipts.append({**load_json(validator_path), "_path": str(validator_path)})
            terminal_path = directory / "terminal.json"
            if terminal_path.exists():
                terminals.append({**load_json(terminal_path), "_path": str(terminal_path)})
    root_terminal = run_dir / "terminal.jsonl"
    if root_terminal.exists():
        terminals = [{**as_record(row), "_path": str(root_terminal)} for row in load_jsonl(root_terminal)]

    return {
        "manifest": manifest,
        "layers": {
            "selected": selected,
            "input": inputs,
            "provider": providers,
            "artifact": artifacts,
            "terminal": terminals,
        },
        "selectionLock": selection_lock,
        "validatorReceipts": validator_receipts,
    }


def audit(bundle: dict[str, Any]) -> dict[str, Any]:
    manifest = [as_record(row) for row in bundle.get("manifest", [])]
    layers = bundle.get("layers") or {}
    issues: list[dict[str, Any]] = []

    manifest_by_digest: dict[str, int] = {}
    manifest_by_url: dict[str, int] = {}
    manifest_by_name: dict[str, int] = {}
    manifest_keys: set[str] = set()
    for index, row in enumerate(manifest):
        parts = identity_parts(row)
        digest = parts["digest"]
        if not digest:
            add_issue(issues, "missing_source_digest", "manifest", index=index, identity=display(row))
        for key in keys_for(row):
            if key.startswith("digest:"):
                if key in manifest_keys:
                    add_issue(issues, "manifest_duplicate_identity", "manifest", identity=display(row))
                manifest_by_digest[key] = index
                manifest_keys.add(key)
            elif key.startswith("url:"):
                manifest_by_url[key] = index
            elif key.startswith("name:"):
                manifest_by_name[key] = index

    def resolve(row: dict[str, Any]) -> int | None:
        parts = identity_parts(row)
        if parts["digest"]:
            return manifest_by_digest.get("digest:" + parts["digest"])
        if parts["url"]:
            return manifest_by_url.get("url:" + parts["url"])
        if parts["company"] or parts["productName"]:
            return manifest_by_name.get("name:" + normalized_company(parts["company"]) + "|" + normalized(parts["productName"]))
        return None

    def canonical(index: int | None) -> str | None:
        return identity_parts(manifest[index])["digest"] if index is not None else None

    normalized_layers: dict[str, list[dict[str, Any]]] = {}
    resolved_layers: dict[str, list[str | None]] = {}
    for layer_name in LAYER_NAMES:
        rows = [as_record(row) for row in layers.get(layer_name, [])]
        normalized_layers[layer_name] = rows
        resolved = [canonical(resolve(row)) for row in rows]
        resolved_layers[layer_name] = resolved
        seen: dict[str, int] = defaultdict(int)
        for row, identity in zip(rows, resolved):
            parts = identity_parts(row)
            if not parts["digest"]:
                add_issue(issues, "missing_source_digest", layer_name, identity=display(row))
            if identity is None:
                add_issue(issues, "unknown_item", layer_name, identity=display(row))
            else:
                seen[identity] += 1
            if parts["digest"] and identity is not None:
                manifest_row = manifest[next(i for i, item in enumerate(manifest) if identity_parts(item)["digest"] == identity)]
                for field_name, row_value, manifest_value in (
                    ("sourceUrl", parts["url"], identity_parts(manifest_row)["url"]),
                    ("company", normalized_company(parts["company"]), normalized_company(identity_parts(manifest_row)["company"])),
                    ("productName", normalized(parts["productName"]), normalized(identity_parts(manifest_row)["productName"])),
                ):
                    if row_value and manifest_value and row_value != manifest_value:
                        add_issue(issues, "identity_fields_disagree", layer_name, field=field_name, identity=display(row), expected=manifest_value, actual=row_value)
        for identity, count in seen.items():
            if count > 1:
                add_issue(issues, "duplicate_item", layer_name, identity=identity, count=count)

    selected_rows = normalized_layers["selected"]
    selected_set = {identity for identity in resolved_layers["selected"] if identity is not None}
    selected_by_order: dict[int, str] = {}
    for row, identity in zip(selected_rows, resolved_layers["selected"]):
        order = field(row, "selectedOrder", "selected_order")
        if order and identity is not None:
            selected_by_order[int(order)] = identity

    selection_lock = bundle.get("selectionLock") or {}
    locked_digests = {text(value) for value in selection_lock.get("selectedDigests", []) if text(value)}
    if locked_digests and locked_digests != selected_set:
        add_issue(issues, "selected_lock_mismatch", "selected", locked=sorted(locked_digests), selected=sorted(selected_set))

    for layer_name in LAYER_NAMES[1:]:
        layer_set = {identity for identity in resolved_layers[layer_name] if identity is not None}
        if layer_set != selected_set:
            for identity in sorted(selected_set - layer_set):
                add_issue(issues, "missing_item", layer_name, identity=identity)
            for identity in sorted(layer_set - selected_set):
                add_issue(issues, "unknown_item", layer_name, identity=identity)
            add_issue(issues, "layer_set_mismatch", layer_name, missing=sorted(selected_set - layer_set), extra=sorted(layer_set - selected_set))
        for row, identity in zip(normalized_layers[layer_name], resolved_layers[layer_name]):
            order = field(row, "selectedOrder", "selected_order")
            if order and int(order) in selected_by_order and identity != selected_by_order[int(order)]:
                add_issue(issues, "ordinal_mismatch", layer_name, selectedOrder=int(order), expected=selected_by_order[int(order)], actual=identity)
        if layer_name == "input":
            last_order = max(selected_by_order, default=0)
            last_identity = selected_by_order.get(last_order)
            for row, identity in zip(normalized_layers[layer_name], resolved_layers[layer_name]):
                order = field(row, "selectedOrder", "selected_order")
                if order and int(order) == last_order and identity == last_identity:
                    earlier = [value for other_row, value in zip(normalized_layers[layer_name], resolved_layers[layer_name]) if field(other_row, "selectedOrder", "selected_order") and int(field(other_row, "selectedOrder", "selected_order")) == last_order - 1]
                    if earlier and earlier[0] == last_identity:
                        add_issue(issues, "resume_copied_last_item", layer_name, selectedOrder=last_order, identity=last_identity)

    for row in normalized_layers["artifact"]:
        container = row.get("_container") or row.get("pathLabel") or row.get("artifactPath")
        container_company, container_product = parse_container_identity(container)
        parts = identity_parts(row)
        if container_product and normalized(container_product) != normalized(parts["productName"]):
            add_issue(issues, "artifact_container_identity_mismatch", "artifact", container=container, internalProduct=parts["productName"])
        if container_company and normalized_company(container_company) != normalized_company(parts["company"]):
            add_issue(issues, "artifact_container_identity_mismatch", "artifact", container=container, internalCompany=parts["company"])

    all_records = [row for name in LAYER_NAMES for row in normalized_layers[name]]
    version_groups: dict[str, set[str]] = defaultdict(set)
    for row in all_records:
        parts = identity_parts(row)
        version_identity = "url:" + parts["url"] if parts["url"] else "name:" + normalized(parts["company"]) + "|" + normalized(parts["productName"])
        if version_identity != "name:|" and parts["digest"]:
            version_groups[version_identity].add(parts["digest"])
    for version_identity, digests in version_groups.items():
        if len(digests) > 1:
            add_issue(issues, "version_conflict", identity=version_identity, digests=sorted(digests))

    terminal_union = {identity for identity in resolved_layers["terminal"] if identity is not None}
    manifest_union = {identity_parts(row)["digest"] for row in manifest if identity_parts(row)["digest"]}
    if terminal_union != manifest_union:
        add_issue(issues, "terminal_union_mismatch", "terminal", missing=sorted(manifest_union - terminal_union), extra=sorted(terminal_union - manifest_union))

    queues = bundle.get("terminalQueues")
    if isinstance(queues, dict):
        queue_sets: dict[str, set[str]] = {}
        for queue_name, values in queues.items():
            queue_sets[queue_name] = {canonical(resolve(as_record(value))) for value in values if canonical(resolve(as_record(value))) is not None}
        queue_names = sorted(queue_sets)
        for left_index, left in enumerate(queue_names):
            for right in queue_names[left_index + 1 :]:
                overlap = queue_sets[left] & queue_sets[right]
                if overlap:
                    add_issue(issues, "terminal_intersection", "terminal", queues=[left, right], identities=sorted(overlap))
        queue_union = set().union(*queue_sets.values()) if queue_sets else set()
        if queue_union != manifest_union:
            add_issue(issues, "terminal_union_mismatch", "terminal", source="terminalQueues", missing=sorted(manifest_union - queue_union), extra=sorted(queue_union - manifest_union))

    validator_receipts = bundle.get("validatorReceipts") or []
    has_identity_failure = bool(issues)
    if validator_receipts and has_identity_failure:
        add_issue(issues, "validator_before_identity_gate", "validator", receiptCount=len(validator_receipts))
        if any(text(as_record(row).get("status")) in {"approved", "passed"} for row in normalized_layers["artifact"] + [as_record(row) for row in validator_receipts]):
            add_issue(issues, "approved_identity_reuse_blocked", "validator", reason="approved output exists but identity gate failed")

    codes = {item["code"] for item in issues}
    failure_statuses: list[str] = []
    if codes & BLOCK_CODES:
        failure_statuses.append("identity_blocked")
    if codes & MISALIGN_CODES:
        failure_statuses.append("manifest_output_identity_misaligned")
    status = failure_statuses[0] if failure_statuses else "pass"
    return {
        "status": status,
        "failureStatuses": failure_statuses,
        "manifestCount": len(manifest),
        "layerCounts": {name: len(normalized_layers[name]) for name in LAYER_NAMES},
        "terminalUnionEqualsManifest": "terminal_union_mismatch" not in codes,
        "terminalIntersectionsZero": "terminal_intersection" not in codes,
        "identityGatePassed": not bool(issues),
        "issues": issues,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--bundle", type=Path, help="JSON fixture bundle")
    source.add_argument("--run-dir", type=Path, help="immutable batch output directory")
    parser.add_argument("--manifest", type=Path, help="manifest JSON; required with --run-dir")
    args = parser.parse_args()
    if args.run_dir and not args.manifest:
        parser.error("--manifest is required with --run-dir")
    try:
        bundle = load_json(args.bundle) if args.bundle else bundle_from_run(args.manifest, args.run_dir)
        report = audit(bundle)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "identity_blocked", "error": str(exc)}, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
