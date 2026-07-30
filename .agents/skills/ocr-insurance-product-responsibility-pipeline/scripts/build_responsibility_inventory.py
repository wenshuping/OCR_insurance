#!/usr/bin/env python3
"""Build a deterministic, source-locked responsibility inventory before model use."""

import argparse
import hashlib
import json
import re
from pathlib import Path


PAGE_MARKER = re.compile(r"(?m)^(?:===== PAGE |PDF_(?:LAYOUT_)?PAGE_)(\d+)(?: =====)?\s*$")
SECTION_HEADINGS = ("保险责任", "保障责任", "我们提供的保障")
SECTION_END_HEADINGS = ("责任免除", "保险金申请", "如何申请领取保险金", "释义")
ACTION_TERMS = ("给付", "赔付", "补偿", "报销", "返还", "豁免", "免交", "提供")
TRIGGER_TERMS = (
    "被保险人", "投保人", "受益人", "身故", "全残", "伤残", "确诊",
    "住院", "治疗", "生存至", "年满", "年金领取", "保险期间届满", "等待期",
)
TITLE_SUFFIX_PATTERN = r"(?:豁免保险费|保险责任|医疗费用|保险金|年金|津贴|补贴)"
HEADING_CANDIDATE = re.compile(
    rf"(?:^|[：:；;。])"
    rf"(?:[一二三四五六七八九十百]+[、.]|[（(][一二三四五六七八九十百\d]+[）)]|"
    rf"\d+(?:[.．]\d+)*[、.]?)?"
    rf"([\u4e00-\u9fffA-Za-z0-9（）()·\-]{{2,42}}{TITLE_SUFFIX_PATTERN})"
    rf"(?=(?:PDF_(?:LAYOUT_)?PAGE_\d+|=====PAGE\d+=====)*"
    rf"(?:被保险人|投保人|受益人|若|如|在本|自本|本公司|我们))"
)
ENUMERATED_HEADING_CANDIDATE = re.compile(
    rf"(?=(?:[一二三四五六七八九十百]+[、.]|[（(][一二三四五六七八九十百\d]+[）)]|"
    rf"\d+(?:[.．]\d+)*[、.])"
    rf"([\u4e00-\u9fffA-Za-z0-9（）()·\-]{{2,42}}{TITLE_SUFFIX_PATTERN})"
    rf"(?=(?:PDF_(?:LAYOUT_)?PAGE_\d+|=====PAGE\d+=====)*"
    rf"(?:被保险人|投保人|受益人|若|如|在本|自本|本公司|我们)))"
)
PUNCTUATED_HEADING_CANDIDATE = re.compile(
    rf"(?:^|[：:；;。])"
    rf"(?:[一二三四五六七八九十百]+[、.]|[（(][一二三四五六七八九十百\d]+[）)]|"
    rf"\d+(?:[.．]\d+)*[、.]?)?"
    rf"([\u4e00-\u9fffA-Za-z0-9（）()·\-]{{2,42}}{TITLE_SUFFIX_PATTERN})[。．]"
    rf"(?=(?:PDF_(?:LAYOUT_)?PAGE_\d+|=====PAGE\d+=====)*"
    rf"(?:被保险人|投保人|受益人|若|如|在本|自本|本公司|我们))"
)
SIMPLE_ANNUITY_HEADING_CANDIDATE = re.compile(
    r"(?:^|[：:；;。])(年金)"
    r"(?=(?:PDF_(?:LAYOUT_)?PAGE_\d+|=====PAGE\d+=====)*"
    r"(?:被保险人|投保人|受益人|若|如|在本|自本|本公司|我们))"
)
ACTION_CANDIDATE = re.compile(
    rf"(?:给付|赔付|补偿|报销|返还|豁免|免交)"
    rf"([^。；;：:]{{0,60}}?{TITLE_SUFFIX_PATTERN})"
)
LEADING_NOISE = re.compile(
    r"^(?:本公司|我们|按|按照|向|对|以|将|应|则|另按|在给付|继续投保|申请)+"
)
REJECTED_TITLE = re.compile(
    r"(?:申请|请求|领取|给付比例|现金价值|责任免除|医疗费用：|发生的医疗费用|"
    r"已经给付|应给付|累计给付|计算并给付|收到领取|保险金给付申请书|"
    r"受益人|指定|变更|不再承担|仅按给付|属于保险责任|已发生|"
    r"医疗保险和其他途径|若被保险人从|在各项责任限额|"
    r"^本合同的|^本合同对|账户价值终身月领（或年领）在养老年金|"
    r"不再给付|其金额|方式确定|其增加|自本合同|险单上所载|"
    r"^给付年金$|^其|^后次|^由身故|^在约定|^限额|^原则后|^但|^本项|"
    r"^任何保险金$|^部分以及|^中约定|^于上述|^于被保险人|^该项|"
    r"^每次按|^其中|^项残疾|^基本部分|在用药期内|年度保险金|"
    r"本合同约定的基本保险金$|国寿.+年金$|各项保险金$|相应的保险责任$|"
    r"^(?:本条|金额|比例|上述|按照|照|或赔偿|赔偿后|一次|累计)|"
    r"达到本合同约定|剩余医疗费用$)"
)
STRUCTURED_SECTION_PREFIX = re.compile(
    r"(?:第[一二三四五六七八九十百\d]{1,8}条|\d{1,2}(?:[.．]\d{1,2}){0,2})$"
)


def text(value):
    return "" if value is None else str(value).strip()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def compact_with_offsets(source_text):
    compact_chars = []
    raw_offsets = []
    for index, char in enumerate(source_text):
        if char.isspace():
            continue
        compact_chars.append(char)
        raw_offsets.append(index)
    return "".join(compact_chars), raw_offsets


def raw_span(raw_offsets, compact_start, compact_end, source_length):
    if compact_start >= len(raw_offsets):
        return source_length, source_length
    start = raw_offsets[max(0, compact_start)]
    if compact_end <= compact_start:
        return start, start
    end_index = min(len(raw_offsets) - 1, compact_end - 1)
    return start, raw_offsets[end_index] + 1


def page_for_offset(source_text, raw_offset):
    page = 1
    for match in PAGE_MARKER.finditer(source_text):
        if match.start() > raw_offset:
            break
        page = int(match.group(1))
    return page


def raw_line(source_text, raw_start):
    line_start = source_text.rfind("\n", 0, raw_start) + 1
    line_end = source_text.find("\n", raw_start)
    if line_end < 0:
        line_end = len(source_text)
    return re.sub(r"\s+", "", source_text[line_start:line_end])


def next_content_line(source_text, raw_start):
    for line in source_text[raw_start:].splitlines():
        value = re.sub(r"\s+", "", line)
        if not value or PAGE_MARKER.fullmatch(value):
            continue
        return value
    return ""


def is_unnumbered_section_heading(source_text, raw_start, heading):
    line = raw_line(source_text, raw_start)
    if line == heading or line.startswith(f"{heading}：") or line.startswith(f"{heading}:"):
        return True
    if line in {f"{heading}。", f"{heading}．", f"{heading}."}:
        line_end = source_text.find("\n", raw_start)
        following = next_content_line(source_text, len(source_text) if line_end < 0 else line_end + 1)
        return bool(re.match(
            rf"(?:[一二三四五六七八九十百]+[、.]|"
            rf"[（(][一二三四五六七八九十百\d]+[）)]|"
            rf"\d+(?:[.．]\d+)*[、.]?)?"
            rf"[\u4e00-\u9fffA-Za-z0-9（）()·\-]{{2,42}}{TITLE_SUFFIX_PATTERN}[。．]?$",
            following,
        ))
    return bool(
        heading == "保险责任"
        and re.fullmatch(r"保险责任在保险单上载明[。．.]?", line)
    )


def is_section_end_heading(source_text, raw_start, heading):
    line = raw_line(source_text, raw_start)
    return bool(re.fullmatch(
        rf"(?:(?:第[一二三四五六七八九十百\d]{{1,8}}条|"
        rf"\d{{1,2}}(?:[.．]\d{{1,2}}){{0,2}})[、.]?)?"
        rf"{re.escape(heading)}(?:[：:。．.]*)",
        line,
    ))


def section_ranges(source_text, compact_text, raw_offsets):
    ranges = []
    for heading in SECTION_HEADINGS:
        start = 0
        while True:
            marker = compact_text.find(heading, start)
            if marker < 0:
                break
            prefix = compact_text[max(0, marker - 16):marker]
            raw_marker = raw_offsets[marker]
            has_valid_prefix = STRUCTURED_SECTION_PREFIX.search(prefix)
            if (
                heading != "我们提供的保障"
                and not has_valid_prefix
                and not is_unnumbered_section_heading(source_text, raw_marker, heading)
            ):
                start = marker + len(heading)
                continue
            content_start = marker + len(heading)
            while (
                content_start < len(compact_text)
                and compact_text[content_start] in "：:。．."
            ):
                content_start += 1
            endings = []
            for end_heading in SECTION_END_HEADINGS:
                end_start = content_start
                while True:
                    position = compact_text.find(end_heading, end_start)
                    if position < 0:
                        break
                    end_prefix = compact_text[max(0, position - 18):position]
                    if (
                        STRUCTURED_SECTION_PREFIX.search(end_prefix)
                        or is_section_end_heading(
                            source_text,
                            raw_offsets[position],
                            end_heading,
                        )
                    ):
                        endings.append(position)
                        break
                    end_start = position + len(end_heading)
            content_end = min(endings) if endings else len(compact_text)
            if content_end > content_start:
                ranges.append((content_start, content_end, heading))
            start = content_start
    return ranges


def clean_title(candidate):
    value = text(candidate).strip("：:，,。；;、")
    if re.search(r"PDF_(?:LAYOUT_)?PAGE_|=====PAGE", value):
        return ""
    for separator in ("：", ":", "；", ";", "。", "，", ",", "、"):
        if separator in value:
            value = value.rsplit(separator, 1)[-1]
    for separator in ("作为", "之外", "余额", "下列"):
        if separator in value:
            value = value.rsplit(separator, 1)[-1]
    value = LEADING_NOISE.sub("", value).lstrip("的").strip("：:，,。；;、")
    value = re.sub(r"^[（(]\d+[）)]", "", value)
    value = re.sub(r"^\d+(?:[.．]\d+)*[、.]?", "", value)
    value = re.sub(r"^该被保险人(?:的)?", "", value)
    if value.count("保险责任") > 1:
        numbered_tail = re.search(r"[（(]\d+[）)]([^（）()]+保险责任)$", value)
        if numbered_tail:
            value = numbered_tail.group(1)
    suffix = re.search(rf"{TITLE_SUFFIX_PATTERN}$", value)
    if not suffix:
        return ""
    if len(value) > 28:
        tail = re.search(rf"([\u4e00-\u9fffA-Za-z0-9（）()·\-]{{2,28}}{TITLE_SUFFIX_PATTERN})$", value)
        value = tail.group(1) if tail else value
    if (len(value) < 3 and value != "年金") or len(value) > 32:
        return ""
    if REJECTED_TITLE.search(value):
        return ""
    if value in {"保险责任", "保险金", "医疗保险金", "住院津贴", "医疗费用"}:
        return ""
    if re.fullmatch(r"(?:上述)?各项保险金|当给付的保险金|本合同约定的该被保险人的意外伤害保险金", value):
        return ""
    if re.search(r"[（(][一二三四五六七八九十\d]+[）)]", value):
        return ""
    return value


def title_stem(title):
    return re.sub(r"(?:保险责任|保险金)$", "", title)


def candidate_titles(region_text):
    found = []
    for source, pattern in (
        ("heading", HEADING_CANDIDATE),
        ("heading", ENUMERATED_HEADING_CANDIDATE),
        ("heading", PUNCTUATED_HEADING_CANDIDATE),
        ("heading", SIMPLE_ANNUITY_HEADING_CANDIDATE),
        ("obligation", ACTION_CANDIDATE),
    ):
        for match in pattern.finditer(region_text):
            raw_candidate = match.group(1)
            if source == "obligation":
                nested_action = re.search(
                    rf"(?:比例|金额|日数|余额|倍数|现金价值|保险费|[%％]).*"
                    rf"(?:给付|赔付|补偿|报销)(.+{TITLE_SUFFIX_PATTERN})$",
                    raw_candidate,
                )
                if nested_action:
                    raw_candidate = nested_action.group(1)
            title = clean_title(raw_candidate)
            if not title:
                continue
            local_start = match.start(1) + match.group(1).rfind(title)
            if title.endswith("津贴") and region_text[local_start + len(title):].startswith("保险金"):
                title += "保险金"
            local_clause_start = local_start
            if source == "obligation":
                preceding_boundaries = [
                    region_text.rfind(boundary, 0, local_start)
                    for boundary in ("。", "；", ";")
                ]
                local_clause_start = max(preceding_boundaries) + 1
            found.append({
                "title": title,
                "localStart": local_start,
                "localEnd": local_start + len(title),
                "localClauseStart": local_clause_start,
                "detectedBy": source,
            })
    found.sort(key=lambda item: (item["localStart"], item["localEnd"], item["title"]))
    heading_items = [item for item in found if item["detectedBy"] == "heading"]
    specific_headings = []
    for item in heading_items:
        stem = title_stem(item["title"])
        is_generic_group = (
            item["title"].endswith("保险责任")
            and (
                stem.endswith("意外伤害")
                or stem in {"医疗", "保险", "保障"}
            )
        )
        if is_generic_group and any(
            other is not item and (
                stem in title_stem(other["title"])
                or other["detectedBy"] == "obligation"
            )
            for other in found
        ):
            continue
        specific_headings.append(item)
    found = (
        specific_headings
        if specific_headings
        else [item for item in found if item["detectedBy"] == "obligation"]
    )
    deduplicated = []
    seen = set()
    for item in found:
        key = re.sub(r"\s+", "", title_stem(item["title"]))
        if key in seen:
            continue
        seen.add(key)
        deduplicated.append(item)
    return deduplicated


def choose_section(source_text, compact_text, raw_offsets):
    choices = []
    for start, end, heading in section_ranges(source_text, compact_text, raw_offsets):
        region = compact_text[start:end]
        candidates = candidate_titles(region)
        action_count = sum(region.count(term) for term in ACTION_TERMS)
        trigger_count = sum(region.count(term) for term in TRIGGER_TERMS)
        score = len(candidates) * 20 + min(action_count, 20) * 2 + min(trigger_count, 20)
        choices.append({
            "start": start,
            "end": end,
            "heading": heading,
            "candidates": candidates,
            "score": score,
        })
    return max(choices, key=lambda item: (item["score"], item["start"]), default=None)


def infer_cross_section_title(compact_text, section):
    """Infer a generic in-section benefit only when the official title is exact elsewhere."""
    region = compact_text[section["start"]:section["end"]]
    if "身故" not in region or "给付保险金" not in region:
        return []
    title = "身故保险金"
    title_start = compact_text.find(title)
    if title_start < 0:
        return []
    return [{
        "title": title,
        "localStart": 0,
        "localEnd": 0,
        "localClauseStart": 0,
        "absoluteTitleStart": title_start,
        "absoluteTitleEnd": title_start + len(title),
        "detectedBy": "cross_section_official_title",
    }]


def stable_id(title, index):
    slug = hashlib.sha256(f"{index}:{title}".encode("utf-8")).hexdigest()[:12]
    return f"resp-{index + 1:03d}-{slug}"


def build_inventory(product, source_text, *, packet_limit=12000):
    compact_text, raw_offsets = compact_with_offsets(source_text)
    section = choose_section(source_text, compact_text, raw_offsets)
    blockers = []
    responsibilities = []
    if not section:
        blockers.append("responsibility_section_not_found")
    else:
        candidates = section["candidates"] or infer_cross_section_title(compact_text, section)
        if not candidates:
            blockers.append("responsibility_title_inventory_empty")
        for index, candidate in enumerate(candidates):
            title_start = candidate.get(
                "absoluteTitleStart",
                section["start"] + candidate["localStart"],
            )
            title_end = candidate.get(
                "absoluteTitleEnd",
                section["start"] + candidate["localEnd"],
            )
            next_start = (
                section["start"] + candidates[index + 1]["localClauseStart"]
                if index + 1 < len(candidates)
                else section["end"]
            )
            clause_start = section["start"] + candidate["localClauseStart"]
            raw_start, _ = raw_span(raw_offsets, clause_start, clause_start + 1, len(source_text))
            raw_title_start, raw_title_end = raw_span(raw_offsets, title_start, title_end, len(source_text))
            _, raw_end = raw_span(raw_offsets, next_start, next_start + 1, len(source_text))
            raw_end = max(raw_title_end, raw_end)
            packet = source_text[raw_start:raw_end].strip()
            compact_packet = re.sub(r"\s+", "", packet)
            has_trigger = any(term in compact_packet for term in TRIGGER_TERMS)
            has_obligation = any(term in compact_packet for term in ACTION_TERMS)
            gate = "pass" if has_trigger and has_obligation and len(packet) <= packet_limit else "blocked"
            if gate != "pass":
                blockers.append(f"responsibility_packet_gate_failed:{index}:{candidate['title']}")
            responsibilities.append({
                "responsibilityId": stable_id(candidate["title"], index),
                "officialTitle": candidate["title"],
                "responsibilityKind": "waiver" if "豁免" in candidate["title"] else "benefit",
                "coverageAggregation": "include",
                "titleStartOffset": raw_title_start,
                "titleEndOffset": raw_title_end,
                "clauseStartOffset": raw_start,
                "clauseEndOffset": raw_end,
                "sourcePage": page_for_offset(source_text, raw_start),
                "evidencePacket": packet,
                "evidencePacketChars": len(packet),
                "evidencePacketLimit": packet_limit,
                "packetGate": gate,
                "detectedBy": candidate["detectedBy"],
                "offsetStatus": "exact",
            })
    return {
        "schema": "deterministic-responsibility-inventory/v2",
        "company": text(product.get("company")),
        "productName": text(product.get("productName")),
        "sourceUrl": text(product.get("sourceUrl")),
        "sourceDigest": text(product.get("sourceDigest")),
        "sourceDocumentPath": text(product.get("sourceDocumentPath")),
        "sourceTextPath": text(product.get("sourceTextPath")),
        "inventoryBuiltBeforeModel": True,
        "section": None if not section else {
            "heading": section["heading"],
            "startOffset": raw_span(raw_offsets, section["start"], section["start"] + 1, len(source_text))[0],
            "endOffset": raw_span(raw_offsets, section["end"], section["end"] + 1, len(source_text))[0],
            "score": section["score"],
        },
        "responsibilities": responsibilities,
        "blockers": sorted(set(blockers)),
        "status": "inventory_ready" if responsibilities and not blockers else "inventory_blocked",
    }


def load_manifest(path):
    if path.suffix == ".jsonl":
        value = [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    else:
        value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError("manifest must be a JSON array")
    return value


def normalize_input_product(product):
    return {
        **product,
        "sourceDocumentPath": text(
            product.get("sourceDocumentPath")
            or product.get("sourceFile")
        ),
        "sourceTextPath": text(
            product.get("sourceTextPath")
            or product.get("sourceTextFile")
            or product.get("responsibilityTextFile")
        ),
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--packet-limit", type=int, default=12000)
    args = parser.parse_args(argv)
    products = load_manifest(args.manifest)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    inventories_dir = args.output_dir / "inventories"
    inventories_dir.mkdir(parents=True, exist_ok=True)
    updated_manifest = []
    for index, raw_product in enumerate(products):
        product = normalize_input_product(raw_product)
        source_document = Path(product["sourceDocumentPath"])
        source_text_path = Path(product["sourceTextPath"])
        actual_digest = sha256_file(source_document)
        locked_digest = text(product.get("sourceDigest"))
        inventory = build_inventory(
            {**product, "sourceDigest": actual_digest},
            source_text_path.read_text(encoding="utf-8"),
            packet_limit=max(1000, args.packet_limit),
        )
        if locked_digest and locked_digest != actual_digest:
            inventory["blockers"].append("source_digest_mismatch")
            inventory["status"] = "inventory_blocked"
        inventory_path = inventories_dir / f"{index + 1:04d}-{actual_digest.removeprefix('sha256:')[:12]}.json"
        inventory_path.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        inventory_sha = sha256_file(inventory_path)
        updated_manifest.append({
            **product,
            "sourceDigest": actual_digest,
            "inventoryPath": str(inventory_path),
            "inventorySha256": inventory_sha,
            "inventoryStatus": inventory["status"],
            "requireLockedInventory": True,
        })
    manifest_path = args.output_dir / "manifest-with-inventory.json"
    manifest_path.write_text(json.dumps(updated_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {
        "schema": "deterministic-responsibility-inventory-batch/v1",
        "inputManifest": str(args.manifest.resolve()),
        "outputManifest": str(manifest_path),
        "selected": len(updated_manifest),
        "inventoryReady": sum(item["inventoryStatus"] == "inventory_ready" for item in updated_manifest),
        "inventoryBlocked": sum(item["inventoryStatus"] != "inventory_ready" for item in updated_manifest),
        "responsibilityCandidates": sum(
            len(json.loads(Path(item["inventoryPath"]).read_text(encoding="utf-8"))["responsibilities"])
            for item in updated_manifest
        ),
        "providerCalls": 0,
        "sqliteWrites": False,
    }
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    sha_targets = sorted(
        path for path in args.output_dir.rglob("*")
        if path.is_file() and path.name != "sha256sums.txt"
    )
    (args.output_dir / "sha256sums.txt").write_text(
        "".join(
            f"{sha256_file(path).removeprefix('sha256:')}  {path.relative_to(args.output_dir)}\n"
            for path in sha_targets
        ),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
