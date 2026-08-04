#!/usr/bin/env python3
"""Adapt locked wave-007 inventories to immutable parser manifests."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
ARTIFACT_ROOT = ROOT / "artifacts/responsibility-full-backfill-20260731-v2"
SOURCES = (
    ARTIFACT_ROOT / "inventory-source-wave007-canary20-20260801-v6",
    ARTIFACT_ROOT / "inventory-source-wave007-remaining280-20260801-v3",
)
OUTPUT = ARTIFACT_ROOT / "parse-source-wave007-20260801-v2"


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def product_identity(item: dict) -> tuple[str, str, str]:
    return (
        str(item.get("sourceDigest") or ""),
        str(item.get("sourceUrl") or ""),
        f"{item.get('company', '')}\x1f{item.get('productName', '')}",
    )


def page_for_offset(source_text: str, offset: int) -> int:
    page = 1
    for match in re.finditer(r"(?m)^===== PAGE (\d+) =====\s*$", source_text[:offset]):
        page = int(match.group(1))
    return page


def adapt_inventory(item: dict, inventory_path: Path) -> dict:
    source_text = Path(item["sourceTextFile"]).read_text(encoding="utf-8")
    responsibilities = []
    for responsibility in item["responsibilities"]:
        packet_path = Path(responsibility["evidencePacket"])
        if sha256(packet_path) != responsibility["evidencePacketSha256"]:
            raise ValueError(f"packet SHA mismatch: {packet_path}")
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
        section = packet["section"]
        title = packet["titleEvidence"]
        clause_start = section["startOffset"]
        clause_end = section["endOffset"]
        evidence = source_text[clause_start:clause_end].strip()
        if evidence != section["exactText"].strip():
            raise ValueError(f"section offset mismatch: {packet_path}")
        responsibilities.append(
            {
                "responsibilityId": responsibility["responsibilityId"],
                "officialTitle": responsibility["officialTitle"],
                "sourcePage": packet.get("sourcePage") or page_for_offset(source_text, clause_start),
                "titleStartOffset": title["startOffset"],
                "titleEndOffset": title["endOffset"],
                "clauseStartOffset": clause_start,
                "clauseEndOffset": clause_end,
                "offsetStatus": "exact",
                "packetGate": "pass",
                "detectedBy": packet["inventoryMethod"],
                "evidencePacket": evidence,
                "evidencePacketChars": len(evidence),
                "evidencePacketLimit": 12000,
                "sourceEvidencePacketPath": str(packet_path),
                "sourceEvidencePacketSha256": responsibility["evidencePacketSha256"],
            }
        )
    inventory = {
        "schema": "locked-responsibility-inventory/v1",
        "status": "inventory_ready",
        "inventoryBuiltBeforeModel": True,
        "company": item["company"],
        "productName": item["productName"],
        "sourceUrl": item["sourceUrl"],
        "sourceDigest": item["sourceDigest"],
        "sourceContract": item["sourceContract"],
        "responsibilities": responsibilities,
        "blockers": [],
    }
    write_json(inventory_path, inventory)
    return inventory


def parser_item(item: dict, inventory_path: Path) -> dict:
    return {
        "company": item["company"],
        "productName": item["productName"],
        "sourceUrl": item["sourceUrl"],
        "officialDomain": item["sourceUrl"].split("/", 3)[2],
        "sourceDigest": item["sourceDigest"],
        "sourceDocumentPath": item["sourceFile"],
        "sourceTextPath": item["sourceTextFile"],
        "sourceContract": item["sourceContract"],
        "requireLockedInventory": True,
        "inventoryPath": str(inventory_path),
        "inventorySha256": sha256(inventory_path),
        "route": item["route"],
        "routeReasons": item["routeReasons"],
        "upstreamManifestId": item["manifestId"],
        "upstreamManifestOrder": item["manifestOrder"],
    }


def main() -> int:
    if OUTPUT.exists():
        raise FileExistsError(f"refusing existing output: {OUTPUT}")
    OUTPUT.mkdir(parents=True)
    pools = {"deepseek": [], "luna": []}
    input_files = []
    seen = set()
    for source in SOURCES:
        for route in pools:
            route_path = source / "routing" / f"{route}-{'simple' if route == 'deepseek' else 'complex'}.jsonl"
            input_files.append({"path": str(route_path), "sha256": sha256(route_path)})
            for item in read_jsonl(route_path):
                identity = product_identity(item)
                if identity in seen:
                    raise ValueError(f"duplicate executable identity: {identity}")
                seen.add(identity)
                order = len(pools[route]) + 1
                inventory_path = OUTPUT / "locked-inventories" / route / f"{order:03d}.json"
                adapt_inventory(item, inventory_path)
                pools[route].append(parser_item(item, inventory_path))

    manifests = {
        "deepseek-canary-020": pools["deepseek"][:20],
        "deepseek-remainder-002": pools["deepseek"][20:],
        "luna-canary-020": pools["luna"][:20],
        "luna-remainder-061": pools["luna"][20:],
    }
    manifest_files = []
    for name, rows in manifests.items():
        path = OUTPUT / "manifests" / f"{name}.json"
        write_json(path, rows)
        manifest_files.append({"name": name, "path": str(path), "selected": len(rows), "sha256": sha256(path)})

    audit = {
        "schema": "source-wave007-parse-routing/v1",
        "inputs": input_files,
        "deepseek": len(pools["deepseek"]),
        "luna": len(pools["luna"]),
        "union": len(seen),
        "intersection": 0,
        "manifests": manifest_files,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    }
    write_json(OUTPUT / "routing-audit.json", audit)
    files = sorted(path for path in OUTPUT.rglob("*") if path.is_file())
    write_json(
        OUTPUT / "sha256.json",
        {"files": [{"path": str(path), "sha256": sha256(path)} for path in files]},
    )
    print(json.dumps(audit, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
