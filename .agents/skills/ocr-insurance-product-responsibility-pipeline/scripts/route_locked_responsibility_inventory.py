#!/usr/bin/env python3
"""Route only source-locked, mechanically safe inventories to model lanes."""

import argparse
import hashlib
import json
import re
from pathlib import Path


COMPLEX_PRODUCT = re.compile(r"重大疾病|疾病保险|医疗|意外|护理|特药|津贴")
SIMPLE_PRODUCT = re.compile(r"定期寿险|终身寿险|年金保险|养老年金|两全保险")
COMPLEX_EVIDENCE = re.compile(
    r"较大者|较小者|最高者|最低者|分支|可选责任|任选|表格|附表|"
    r"多次给付|累计给付|免赔额|赔付比例"
)
SUSPICIOUS_TITLE = re.compile(
    r"不承担保险责任|相应的保险金|相应的保险责任|本合同约定的保险金|"
    r"本合同保险责任|每项保险责任|任何保险金|剩余部分|^在|^金在|"
    r"^予|^其|^由|^于|^但|^部分|^和|^）|保险期间内|最高给付限额|"
    r"约定给付|医疗费用$|^给付年金$|^医疗保险责任$"
)


def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_rows(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError("manifest must be a JSON array")
    return value


def classify(product, inventory):
    responsibilities = inventory.get("responsibilities") or []
    titles = [str(item.get("officialTitle") or "").strip() for item in responsibilities]
    if inventory.get("status") != "inventory_ready" or inventory.get("blockers"):
        return "inventory_review", "inventory_not_ready"
    if not titles or any(not title or SUSPICIOUS_TITLE.search(title) for title in titles):
        return "inventory_review", "suspicious_inventory_title"
    product_name = str(product.get("productName") or "")
    if "年金" in product_name and not any(
        "年金" in title or "满期" in title or "生存" in title
        for title in titles
    ):
        return "inventory_review", "annuity_inventory_missing_annuity_benefit"
    evidence = "\n".join(
        str(item.get("evidencePacket") or "")
        for item in responsibilities
    )
    simple = (
        len(responsibilities) <= 3
        and SIMPLE_PRODUCT.search(product_name)
        and not COMPLEX_PRODUCT.search(product_name)
        and not COMPLEX_EVIDENCE.search(evidence)
    )
    return (
        ("deepseek-standard", "simple_inventory")
        if simple
        else ("luna-complex", "complex_inventory")
    )


def write_json(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_jsonl(path, values):
    path.write_text(
        "".join(json.dumps(value, ensure_ascii=False) + "\n" for value in values),
        encoding="utf-8",
    )


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    products = load_rows(args.manifest)
    queues = {
        "deepseek-standard": [],
        "luna-complex": [],
        "inventory_review": [],
    }
    audit = []
    for product in products:
        inventory_path = Path(product["inventoryPath"])
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
        route, reason = classify(product, inventory)
        routed = {
            **product,
            "providerRoute": route if route != "inventory_review" else "",
            "routingReason": reason,
            "terminalStatus": "parse_pending" if route != "inventory_review" else "inventory_review",
        }
        queues[route].append(routed)
        audit.append({
            "productKey": product.get("productKey"),
            "company": product.get("company"),
            "productName": product.get("productName"),
            "sourceDigest": product.get("sourceDigest"),
            "inventoryPath": str(inventory_path),
            "inventoryStatus": inventory.get("status"),
            "responsibilityCount": len(inventory.get("responsibilities") or []),
            "route": route,
            "reason": reason,
        })
    deepseek_path = args.output_dir / "deepseek.json"
    luna_path = args.output_dir / "luna.json"
    review_path = args.output_dir / "inventory-review.jsonl"
    audit_path = args.output_dir / "routing-audit.json"
    write_json(deepseek_path, queues["deepseek-standard"])
    write_json(luna_path, queues["luna-complex"])
    write_jsonl(review_path, queues["inventory_review"])
    write_json(audit_path, audit)
    summary = {
        "schema": "locked-responsibility-inventory-routing/v1",
        "inputManifest": str(args.manifest.resolve()),
        "selected": len(products),
        "deepseek": len(queues["deepseek-standard"]),
        "luna": len(queues["luna-complex"]),
        "inventoryReview": len(queues["inventory_review"]),
        "union": sum(len(values) for values in queues.values()),
        "intersections": 0,
        "modelCalls": 0,
        "sqliteWrites": False,
    }
    write_json(args.output_dir / "summary.json", summary)
    files = sorted(
        path for path in args.output_dir.iterdir()
        if path.is_file() and path.name != "sha256sums.txt"
    )
    (args.output_dir / "sha256sums.txt").write_text(
        "".join(f"{sha256_file(path)}  {path.name}\n" for path in files),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
