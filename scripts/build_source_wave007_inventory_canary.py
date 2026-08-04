#!/usr/bin/env python3
"""Build a deterministic 20-product inventory canary from SOURCE wave 007."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
BACKFILL = ROOT / "artifacts/responsibility-full-backfill-20260731-v2"
SOURCE_ROOT = BACKFILL / "source-wave-20260801-007"
HANDOFF = SOURCE_ROOT / "handoff/source-ready.jsonl"
CANARY_OUTPUT = BACKFILL / "inventory-source-wave007-canary20-20260801-v6"
REMAINING_OUTPUT = BACKFILL / "inventory-source-wave007-remaining280-20260801-v3"
SUPERSEDED_CANARY = BACKFILL / "inventory-source-wave007-canary20-20260801-v5"
SUPERSEDED_REMAINING = BACKFILL / "inventory-source-wave007-remaining280-20260801-v2"
CANARY_SIZE = 20
PACKET_LIMIT = 12_000

INCREMENTAL_WHOLE_LIFE = re.compile(r"增额.*终身寿险|终身寿险.*增额")
BENEFIT_SUFFIX = r"保险金|年金|养老金|津贴|补偿金|赔偿金|抚恤金|教育金|发展基金|护理金"
TITLE_TOKEN = re.compile(rf"[\u4e00-\u9fffA-Za-z0-9（）()·、或]{{2,30}}(?:{BENEFIT_SUFFIX})")
QUOTED_TITLE = re.compile(rf"[“\"](?P<title>[^”\"\n]{{2,40}}(?:{BENEFIT_SUFFIX}))[”\"]")
OBLIGATION_TITLE = re.compile(
    rf"(?:给付|支付|赔付|补偿)(?:[^，。；;\n]{{0,48}}?)(?P<title>{TITLE_TOKEN.pattern})"
)
DIRECT_OBLIGATION_TITLE = re.compile(
    r"(?:给付|支付|赔付|补偿)\s*(?P<title>[^，。；;：:]{2,60}?(?:保\s*险\s*金|年\s*金|养老金|津贴|补偿金|赔偿金|抚恤金|教育金|发展基金|护理金))"
)
REFUND_OBLIGATION = re.compile(r"(?:本公司|我们).{0,40}(?:返还|退还).{0,30}(?:保险费|现金价值)", re.S)
NUMBERED_SECTION = re.compile(r"^\s*(?P<number>\d+(?:\s*[.．]\s*\d+){2,})\s*(?P<tail>.*)$")
ENUMERATED_HEADING = re.compile(
    rf"^\s*[（(]\s*(?P<number>\d+)\s*[）)]\s*(?P<title>[^：:\n]{{2,40}}(?:{BENEFIT_SUFFIX}))\s*[：:]"
)
CHINESE_ITEM = re.compile(r"^\s*(?:[（(]?[一二三四五六七八九十]+[）)、.．])")
EXCLUSION_HEADING = re.compile(
    r"^\s*(?:(?:\d+(?:\s*[.．]\s*\d+){1,3})|第[一二三四五六七八九十百]+条|[（(]?[一二三四五六七八九十]+[）)、.．])?\s*责任免除"
)
INSURER_OBLIGATION = re.compile(r"(?:本公司|我们).{0,100}(?:承担|给付|赔付|补偿|支付|返还)", re.S)
STRUCTURAL = {
    "medical_or_critical": re.compile(r"医疗|住院|重大疾病|重疾|疾病|护理|药品|肿瘤"),
    "table": re.compile(r"附表|给付比例表|费率表|保险金额表"),
    "comparison": re.compile(r"较大者|较小者|最大|最小|max|min"),
    "multi_branch": re.compile(r"下列(?:两|三|四|五|六|七|八|九|十)项|第[二三四五六七八九十]次|可选"),
    "schedule": re.compile(r"保单年度|领取年龄|每年|每月|现金价值|账户价值"),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return "sha256:" + digest.hexdigest()


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def line_spans(text: str) -> list[tuple[int, int, str]]:
    spans = []
    offset = 0
    for raw in text.splitlines(keepends=True):
        spans.append((offset, offset + len(raw), raw.rstrip("\r\n")))
        offset += len(raw)
    return spans


def compact(value: str) -> str:
    return re.sub(r"\s+", "", value)


def looks_like_chapter_heading(line: str) -> bool:
    value = compact(line)
    if "责任免除" in value or "申请" in value or "保险责任开始" in value:
        return False
    return value == "保险责任" or bool(re.match(r"^\d+(?:[.．]\d+){1,3}保险责任", value))


def find_chapter(text: str) -> tuple[int, int, str | None]:
    spans = line_spans(text)
    candidates = []
    for index, (start, _, line) in enumerate(spans):
        if not looks_like_chapter_heading(line):
            continue
        dot_leader = "……" in line or re.search(r"第\s*\d+(?:\.\d+)?\s*条", line)
        if not dot_leader:
            candidates.append((index, start))
    # A table of contents commonly repeats the heading before the body. Search
    # backwards and accept only a chapter containing an insurer obligation.
    for line_index, chapter_start in reversed(candidates):
        chapter_end = len(text)
        for exclusion_start, _, line in spans[line_index + 1 :]:
            if EXCLUSION_HEADING.match(compact(line)):
                chapter_end = exclusion_start
                break
        if chapter_end > chapter_start and INSURER_OBLIGATION.search(text[chapter_start:chapter_end]):
            return chapter_start, chapter_end, None
    return 0, 0, "responsibility_body_chapter_not_found"


def clean_title(value: str) -> str | None:
    title = compact(value).strip("“”\"'：:、，,。；;")
    title = re.sub(r"^(?:\d+(?:\.\d+)?)?元的?", "", title)
    title = re.sub(r"^的", "", title)
    matches = list(TITLE_TOKEN.finditer(title))
    if matches:
        title = matches[-1].group(0)
    if not (2 <= len(title) <= 30):
        return None
    if not re.search(rf"(?:{BENEFIT_SUFFIX})$", title):
        return None
    if re.search(r"申请|责任免除|保险金额|给付的|本公司|被保险人|受益人|所交|已交|按下列", title):
        return None
    return title


def clean_heading_title(value: str) -> str | None:
    heading = compact(value).strip("“”\"'：:、，,。；;")
    heading = re.sub(r"^(?:基本保障|可选保障\d+)", "", heading)
    match = TITLE_TOKEN.search(heading)
    return clean_title(match.group(0)) if match else None


def compact_title_span(text: str, start: int, end: int, title: str) -> tuple[int, int] | None:
    positions = [offset for offset in range(start, end) if not text[offset].isspace()]
    normalized = "".join(text[offset] for offset in positions)
    relative = normalized.find(title)
    if relative < 0:
        return None
    title_positions = positions[relative : relative + len(title)]
    return title_positions[0], title_positions[-1] + 1


def explicit_heading_titles(text: str, start: int, end: int) -> list[dict]:
    spans = [span for span in line_spans(text) if start <= span[0] < end]
    results = []
    for index, (line_start, line_end, line) in enumerate(spans):
        match = NUMBERED_SECTION.match(line)
        enumerated = ENUMERATED_HEADING.match(line)
        if match:
            number = compact(match.group("number"))
            tail = match.group("tail").strip()
            pieces = [tail] if tail else []
            heading_end = line_end
            if not re.search(rf"(?:{BENEFIT_SUFFIX})", compact("".join(pieces))):
                for _, next_end, next_line in spans[index + 1 : index + 4]:
                    if NUMBERED_SECTION.match(next_line) or ENUMERATED_HEADING.match(next_line) or len(compact(next_line)) > 24:
                        break
                    pieces.append(next_line.strip())
                    heading_end = next_end
                    if re.search(rf"(?:{BENEFIT_SUFFIX})", compact("".join(pieces))):
                        break
            title = clean_heading_title("".join(pieces))
            method = "numbered_subheading"
        elif enumerated:
            number = f"item-{enumerated.group('number')}"
            heading_end = line_end
            title = clean_heading_title(enumerated.group("title"))
            method = "enumerated_subheading"
        else:
            continue
        if title and title not in {"保险责任", "保障责任"}:
            title_span = compact_title_span(text, line_start, heading_end, title)
            if not title_span:
                continue
            results.append(
                {
                    "title": title,
                    "offset": title_span[0],
                    "titleEnd": title_span[1],
                    "headingStart": line_start,
                    "headingEnd": heading_end,
                    "sectionNumber": number,
                    "method": method,
                }
            )
    return results


def inline_titles(text: str, start: int, end: int) -> list[dict]:
    chapter = text[start:end]
    results = []
    for pattern, method in (
        (QUOTED_TITLE, "quoted_title"),
        (DIRECT_OBLIGATION_TITLE, "direct_obligation_title"),
        (OBLIGATION_TITLE, "obligation_phrase"),
    ):
        for match in pattern.finditer(chapter):
            title = clean_title(match.group("title"))
            if not title:
                continue
            title_span = compact_title_span(text, start + match.start(), start + match.end(), title)
            if not title_span:
                continue
            results.append(
                {
                    "title": title,
                    "offset": title_span[0],
                    "titleEnd": title_span[1],
                    "headingStart": start + match.start(),
                    "headingEnd": start + match.end(),
                    "sectionNumber": None,
                    "method": method,
                }
            )
    return results


def deduplicate_titles(candidates: list[dict]) -> list[dict]:
    explicit_methods = {"numbered_subheading", "enumerated_subheading"}
    method_rank = {
        "numbered_subheading": 0,
        "enumerated_subheading": 0,
        "quoted_title": 1,
        "direct_obligation_title": 2,
        "obligation_phrase": 3,
    }
    explicit_titles = {row["title"] for row in candidates if row["method"] in explicit_methods}
    by_key = {}
    for candidate in sorted(candidates, key=lambda row: (method_rank[row["method"]], row["offset"])):
        if candidate["method"] not in explicit_methods and candidate["title"] in explicit_titles:
            continue
        key = (
            candidate["title"],
            candidate["sectionNumber"] if candidate["method"] in explicit_methods else None,
        )
        by_key.setdefault(key, candidate)
    rows = sorted(by_key.values(), key=lambda row: row["offset"])
    return [
        row
        for row in rows
        if not any(
            row["title"] != other["title"]
            and row["title"] in other["title"]
            and row["offset"] < other["titleEnd"]
            and other["offset"] < row["titleEnd"]
            for other in rows
        )
    ]


def implicit_item_ranges(text: str, start: int, end: int) -> list[tuple[int, int]]:
    starts = [line_start for line_start, _, line in line_spans(text) if start <= line_start < end and CHINESE_ITEM.match(line)]
    return [(item_start, starts[index + 1] if index + 1 < len(starts) else end) for index, item_start in enumerate(starts)]


def structural_heading_starts(text: str, start: int, end: int) -> list[int]:
    return [
        line_start
        for line_start, _, line in line_spans(text)
        if start <= line_start < end and (NUMBERED_SECTION.match(line) or ENUMERATED_HEADING.match(line))
    ]


def range_for_title(candidate: dict, structural_starts: list[int], implicit: list[tuple[int, int]], chapter_end: int) -> tuple[int, int]:
    if candidate["method"] in {"numbered_subheading", "enumerated_subheading"}:
        ordered = sorted(structural_starts)
        position = ordered.index(candidate["headingStart"])
        return candidate["headingStart"], ordered[position + 1] if position + 1 < len(ordered) else chapter_end
    containing = [heading for heading in structural_starts if heading <= candidate["offset"]]
    if containing:
        section_start = containing[-1]
        later = [heading for heading in structural_starts if heading > section_start]
        return section_start, later[0] if later else chapter_end
    for item_start, item_end in implicit:
        if item_start <= candidate["offset"] < item_end:
            return item_start, item_end
    return candidate["headingStart"], chapter_end


def inventory_quality_blockers(candidates: list[dict]) -> list[str]:
    blockers = []
    titles = [row["title"] for row in candidates]
    if len(titles) != len(set(titles)):
        blockers.append("duplicate_official_title_requires_parent_branch_review")
    section_numbers = [row["sectionNumber"] for row in candidates if row["sectionNumber"]]
    if len(section_numbers) != len(set(section_numbers)):
        blockers.append("duplicate_section_number_requires_review")
    malformed_heading = re.compile(r"^(?:项|则达到|其中|达到|保险费|比例|一次)|养老金.*本合同养老金")
    if any(malformed_heading.search(title) for title in titles):
        blockers.append("malformed_official_heading_title")
    explicit = any(row["method"] in {"numbered_subheading", "enumerated_subheading"} for row in candidates)
    if explicit:
        return blockers
    if len(candidates) > 2:
        blockers.append("unbounded_inline_inventory_requires_review")
    unsafe = re.compile(
        r"(?:给付|达到|后的余额|其中|任何一项|所列|保险费|较大者|较小者|本合同|约定的|对应的|比例计算|比例乘以|=====PAGE)|^(?:项|某项|一项|了|为|按)"
    )
    if any(title == "保险金" or unsafe.search(title) for title in titles):
        blockers.append("inline_title_contains_formula_or_body_fragment")
    return blockers


def uncovered_refund_requires_review(text: str, start: int, end: int, candidates: list[dict], structural_starts: list[int]) -> bool:
    for match in REFUND_OBLIGATION.finditer(text[start:end]):
        refund_word = re.search(r"返还|退还", match.group(0))
        offset = start + match.start() + refund_word.start()
        if any(row["sectionStart"] <= offset < row["sectionEnd"] for row in candidates):
            continue
        section_start = max((heading for heading in structural_starts if heading <= offset), default=None)
        if section_start is not None:
            later = [heading for heading in structural_starts if heading > section_start]
            section_end = later[0] if later else end
            section_text = text[section_start:section_end]
            if re.search(r"不承担.{0,20}保险责任", section_text, re.S):
                continue
        return True
    return False


def build_inventory(text: str) -> tuple[int, int, list[dict], list[str]]:
    chapter_start, chapter_end, chapter_error = find_chapter(text)
    if chapter_error:
        return chapter_start, chapter_end, [], [chapter_error]
    explicit = explicit_heading_titles(text, chapter_start, chapter_end)
    # When explicit subheadings exist, inline benefit mentions are formula
    # references rather than additional inventory items.
    candidates = deduplicate_titles(explicit if explicit else inline_titles(text, chapter_start, chapter_end))
    blockers = []
    if not candidates:
        blockers.append("no_exact_named_responsibility_title")
        return chapter_start, chapter_end, [], blockers

    implicit = implicit_item_ranges(text, chapter_start, chapter_end)
    structural_starts = structural_heading_starts(text, chapter_start, chapter_end)
    for candidate in candidates:
        section_start, section_end = range_for_title(candidate, structural_starts, implicit, chapter_end)
        candidate["sectionStart"] = section_start
        candidate["sectionEnd"] = section_end
    range_titles = Counter((row["sectionStart"], row["sectionEnd"]) for row in candidates)
    if any(count > 1 for count in range_titles.values()):
        blockers.append("multiple_named_responsibilities_share_unbounded_implicit_section")
    blockers.extend(inventory_quality_blockers(candidates))
    if uncovered_refund_requires_review(text, chapter_start, chapter_end, candidates, structural_starts):
        blockers.append("unnamed_refund_obligation_requires_review")
    if any(row["sectionEnd"] - row["sectionStart"] > PACKET_LIMIT for row in candidates):
        blockers.append("evidence_packet_exceeds_limit")
    return chapter_start, chapter_end, candidates, sorted(set(blockers))


def route(row: dict, chapter: str, responsibility_count: int) -> tuple[str, list[str]]:
    evidence = row["productName"] + "\n" + chapter
    reasons = [name for name, pattern in STRUCTURAL.items() if pattern.search(evidence)]
    if responsibility_count > 3:
        reasons.append("multiple_named_responsibilities")
    reasons = sorted(set(reasons))
    if "medical_or_critical" in reasons or len(reasons) >= 2 or responsibility_count > 3:
        return "luna", reasons
    return "deepseek", reasons or ["ordinary_bounded_structure"]


def self_test() -> None:
    sample = """目录\n2.4 保险责任\n2.5 责任免除\n2.4 保险责任 在本合同期间内，本公司承担下列保险责任：\n2.4.1 意外伤害身故保险金\n被保险人因意外伤害身故，本公司给付意外伤害身故保险金。\n2.5 责任免除\n"""
    start, end, inventory, blockers = build_inventory(sample)
    assert sample[start:].startswith("2.4 保险责任 在本合同期间内")
    assert sample[end:].startswith("2.5 责任免除")
    assert [row["title"] for row in inventory] == ["意外伤害身故保险金"]
    assert not blockers
    malformed = "保险责任……第2.4条\n2.5 责任免除\n"
    assert build_inventory(malformed)[3] == ["responsibility_body_chapter_not_found"]
    wrapped = """保险责任\n在本合同期间内，本公司承担下列保险责任：\n1、被保险人身故或全残，本公司向受益人给付身故\n或全残保险金。\n责任免除\n"""
    assert [row["title"] for row in build_inventory(wrapped)[2]] == ["身故或全残保险金"]
    overlapping = """保险责任\n在本合同期间内，本公司承担下列保险责任：\n本公司给付身故保险金或全残保险金。\n责任免除\n"""
    assert [row["title"] for row in build_inventory(overlapping)[2]] == ["身故保险金或全残保险金"]
    named_refund = """保险责任\n在本合同期间内，本公司承担下列保险责任：\n一、被保险人身故，本公司给付身故保险金并返还所交保险费。\n责任免除\n"""
    assert not build_inventory(named_refund)[3]
    standalone_refund = """保险责任\n在本合同期间内，本公司承担下列保险责任：\n一、被保险人身故，本公司给付身故保险金。\n二、被保险人生存至届满，本公司返还所交保险费。\n责任免除\n"""
    assert build_inventory(standalone_refund)[3] == ["unnamed_refund_obligation_requires_review"]
    shared_consequence = """2.4 保险责任\n在本合同期间内，本公司承担下列保险责任：\n2.4.1 意外伤害身故保险金\n本公司给付意外伤害身故保险金。\n2.4.2 职业给付系数\n本公司不承担保险责任，并退还所交保险费。\n2.5 责任免除\n"""
    _, _, inventory, blockers = build_inventory(shared_consequence)
    assert not blockers
    assert shared_consequence[inventory[0]["sectionEnd"] :].startswith("2.4.2 职业给付系数")
    heading_with_body = """2.4 保险责任\n在本合同期间内，本公司承担下列保险责任：\n2.4.1 护理保险金 被保险人达到本合同护理保险金条件，我们给付护理保险金。\n2.5 责任免除\n"""
    assert [row["title"] for row in build_inventory(heading_with_body)[2]] == ["护理保险金"]
    body_fragment = """保险责任\n在本合同期间内，本公司承担下列保险责任：\n本公司给付保险费与现金价值较大者给付身故保险金。\n责任免除\n"""
    assert "inline_title_contains_formula_or_body_fragment" in build_inventory(body_fragment)[3]
    unbounded_three = """保险责任\n在本合同期间内，本公司承担下列保险责任：\n本公司给付身故保险金。\n本公司给付全残保险金。\n本公司给付满期保险金。\n责任免除\n"""
    assert "unbounded_inline_inventory_requires_review" in build_inventory(unbounded_three)[3]


def main() -> None:
    self_test()
    parser = argparse.ArgumentParser()
    parser.add_argument("--remaining", action="store_true", help="process rows after the accepted 20-product canary")
    args = parser.parse_args()
    output = REMAINING_OUTPUT if args.remaining else CANARY_OUTPUT
    if output.exists():
        raise RuntimeError(f"immutable output already exists: {output}")
    all_rows = read_jsonl(HANDOFF)
    eligible = [row for row in all_rows if not INCREMENTAL_WHOLE_LIFE.search(row.get("productName", ""))]
    selected = eligible[CANARY_SIZE:] if args.remaining else eligible[:CANARY_SIZE]
    expected = len(eligible) - CANARY_SIZE if args.remaining else CANARY_SIZE
    if len(all_rows) != 300 or len(selected) != expected:
        raise RuntimeError("unexpected SOURCE wave 007 handoff size")
    if len({row["sourceDigest"] for row in selected}) != expected:
        raise RuntimeError("selected source digests are not unique")

    output.mkdir(parents=True)
    write_jsonl(output / "immutable-manifest.jsonl", selected)
    input_lock = {
        "schema": "source-wave007-inventory-input-lock/v3" if args.remaining else "source-wave007-inventory-canary-input-lock/v6",
        "sourceHandoff": str(HANDOFF),
        "sourceHandoffSha256": sha256(HANDOFF),
        "selected": len(selected),
        "selectionRule": (
            "remaining source_ready products after accepted first-20 canary, excluding explicit incremental whole-life products"
            if args.remaining
            else "first 20 source_ready products excluding explicit incremental whole-life products"
        ),
        "sourceDigestsUnique": True,
        "incrementalWholeLifeExcluded": len(all_rows) - len(eligible),
        "acceptedCanary": str(CANARY_OUTPUT) if args.remaining else None,
        "acceptedCanarySha256": sha256(CANARY_OUTPUT / "sha256.json") if args.remaining else None,
        "supersedesUnsafeBatch": str(SUPERSEDED_REMAINING) if args.remaining else None,
        "supersedesFailedCanary": None if args.remaining else str(SUPERSEDED_CANARY),
        "supersedeReason": (
            "v2 batch exposed same-line heading/body title drift and duplicate section numbers"
            if args.remaining
            else "v5 passed; v6 extracts the first responsibility title from same-line heading/body text"
        ),
        "modelProviderCalled": False,
        "networkUsed": False,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    }
    write_json(output / "input-lock.json", input_lock)

    inventories = []
    terminals = []
    packet_index = []
    routes = {"deepseek": [], "luna": []}
    status_counts = Counter()
    blocker_counts = Counter()
    largest_packet = 0
    for order, row in enumerate(selected, 1):
        source_file = Path(row["sourceFile"])
        text_file = Path(row["responsibilityTextFile"])
        contract_file = Path(row["sourceContract"])
        contract = json.loads(contract_file.read_text(encoding="utf-8"))
        if contract.get("sourceStatus") != "source_ready" or sha256(source_file) != row["sourceDigest"]:
            raise RuntimeError(f"source gate failed for manifest order {order}")
        text = text_file.read_text(encoding="utf-8")
        chapter_start, chapter_end, candidates, blockers = build_inventory(text)
        status = "inventory_ready" if candidates and not blockers else "inventory_review"
        route_name, route_reasons = route(row, text[chapter_start:chapter_end], len(candidates))
        responsibilities = []
        for item_index, candidate in enumerate(candidates, 1):
            section_start = candidate["sectionStart"]
            section_end = candidate["sectionEnd"]
            exact_section = text[section_start:section_end]
            largest_packet = max(largest_packet, len(exact_section))
            responsibility_id = f"resp:{row['sourceDigest'][7:23]}:{section_start}:{item_index}"
            packet_path = output / "evidence-packets" / f"{order:03d}" / f"{item_index:03d}.json"
            packet = {
                "schema": "official-responsibility-evidence-packet/v2",
                "responsibilityId": responsibility_id,
                "company": row["company"],
                "productName": row["productName"],
                "sourceDigest": row["sourceDigest"],
                "sourceUrl": row["sourceUrl"],
                "sourceTextFile": str(text_file),
                "chapter": {"startOffset": chapter_start, "endOffset": chapter_end},
                "section": {"startOffset": section_start, "endOffset": section_end, "exactText": exact_section},
                "titleEvidence": {
                    "startOffset": candidate["offset"],
                    "endOffset": candidate["titleEnd"],
                    "exactText": text[candidate["offset"] : candidate["titleEnd"]],
                    "normalizedTitle": candidate["title"],
                },
                "inventoryMethod": candidate["method"],
                "modelCallsAllowed": False,
            }
            write_json(packet_path, packet)
            packet_sha = sha256(packet_path)
            responsibility = {
                "responsibilityId": responsibility_id,
                "officialTitle": candidate["title"],
                "sectionNumber": candidate["sectionNumber"],
                "headingStart": candidate["headingStart"],
                "clauseStart": section_start,
                "clauseEnd": section_end,
                "continuationRanges": [],
                "evidencePacket": str(packet_path),
                "evidencePacketSha256": packet_sha,
            }
            responsibilities.append(responsibility)
            packet_index.append({"manifestOrder": order, **responsibility})
        record = {
            "schema": "official-responsibility-inventory/v2",
            "manifestId": "source-wave-20260801-007-inventory-remaining280-v3" if args.remaining else "source-wave-20260801-007-inventory-canary20-v6",
            "manifestOrder": order,
            **{key: row[key] for key in ("productKey", "company", "productName", "sourceUrl", "sourceDigest", "sourceFile", "sourceContract")},
            "sourceTextFile": str(text_file),
            "terminalStatus": status,
            "chapter": {"startOffset": chapter_start, "endOffset": chapter_end, "proven": chapter_end > chapter_start},
            "responsibilityCount": len(responsibilities),
            "responsibilities": responsibilities,
            "route": route_name,
            "routeReasons": route_reasons,
            "blockers": blockers,
        }
        inventories.append(record)
        terminal = {
            "manifestId": record["manifestId"],
            "manifestOrder": order,
            "company": row["company"],
            "productName": row["productName"],
            "sourceDigest": row["sourceDigest"],
            "terminalStatus": status,
            "responsibilityCount": len(responsibilities),
            "route": route_name,
            "blockers": blockers,
        }
        terminals.append(terminal)
        status_counts[status] += 1
        blocker_counts.update(blockers)
        if status == "inventory_ready":
            routes[route_name].append(record)

    write_jsonl(output / "inventory.jsonl", inventories)
    write_jsonl(output / "terminal.jsonl", terminals)
    write_jsonl(output / "evidence-packets/index.jsonl", packet_index)
    write_jsonl(output / "routing/deepseek-simple.jsonl", routes["deepseek"])
    write_jsonl(output / "routing/luna-complex.jsonl", routes["luna"])
    summary = {
        "schema": "source-wave007-inventory-batch-summary/v3" if args.remaining else "source-wave007-inventory-canary-summary/v6",
        "selected": len(selected),
        "processed": len(terminals),
        "inventory_ready": status_counts["inventory_ready"],
        "inventory_review": status_counts["inventory_review"],
        "responsibilityCount": sum(row["responsibilityCount"] for row in terminals),
        "largestEvidencePacketChars": largest_packet,
        "packetLimit": PACKET_LIMIT,
        "deepseek_simple": len(routes["deepseek"]),
        "luna_complex": len(routes["luna"]),
        "routeUnion": len(routes["deepseek"]) + len(routes["luna"]),
        "routeIntersection": 0,
        "blockerCounts": dict(sorted(blocker_counts.items())),
        "expansionAllowed": None if args.remaining else status_counts["inventory_ready"] >= 16,
        "acceptedCanary": str(CANARY_OUTPUT) if args.remaining else None,
        "supersedesUnsafeBatch": str(SUPERSEDED_REMAINING) if args.remaining else None,
        "supersedesFailedCanary": None if args.remaining else str(SUPERSEDED_CANARY),
        "modelProviderCalled": False,
        "networkUsed": False,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    }
    write_json(output / "summary.json", summary)
    files = [path for path in output.rglob("*") if path.is_file() and path.name != "sha256.json"]
    write_json(
        output / "sha256.json",
        {
            "schema": "source-wave007-inventory-batch-sha256/v3" if args.remaining else "source-wave007-inventory-canary-sha256/v6",
            "files": [
                {"path": str(path.relative_to(output)), "bytes": path.stat().st_size, "sha256": sha256(path)}
                for path in sorted(files)
            ],
        },
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
