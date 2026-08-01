#!/usr/bin/env python3
"""Retrieve likely responsibility pages without deciding insurance semantics."""

import argparse
import json
import re
from pathlib import Path


PAGE_MARKER = re.compile(r"(?m)^PDF_PAGE_(\d+)\s*$")
HEADING_PREFIX = re.compile(r"^(?:第[一二三四五六七八九十百\d]+[章节条款部分]|[\d一二三四五六七八九十百().（）\-—、.]+)")


def load_rules(path):
    return json.loads(path.read_text(encoding="utf-8"))


def split_pages(source_text):
    matches = list(PAGE_MARKER.finditer(source_text))
    if not matches:
        return [{"page": 1, "text": source_text}]
    pages = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(source_text)
        pages.append({"page": int(match.group(1)), "text": source_text[start:end].strip()})
    return pages


def short_heading_matches(line, keywords):
    compact = re.sub(r"\s+", "", line)
    for keyword in keywords:
        if compact == keyword:
            return True
        prefix = HEADING_PREFIX.match(compact)
        if prefix and compact[prefix.end():].startswith(keyword):
            return True
    return False


def matching_terms(value, terms):
    return [term for term in terms if term in value]


def detect_packs(product_name, source_text, rules):
    packs = []
    for name, pack in rules.get("productPacks", {}).items():
        if matching_terms(product_name, pack.get("productTerms", [])):
            packs.append(name)
    return packs


def score_page(page, rules, pack_keywords):
    value = page["text"]
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    section = [line for line in lines if short_heading_matches(line, rules["sectionHeadings"])]
    titles = [
        line for line in lines
        if len(re.sub(r"\s+", "", line)) <= 42
        and any(re.sub(r"[：:。；;\s]+$", "", line).endswith(suffix) for suffix in rules["titleSuffixes"])
    ]
    signals = {
        "section": section,
        "titles": titles,
        "actions": matching_terms(value, rules["actions"]),
        "quantitative": matching_terms(value, rules["quantitative"]),
        "triggers": matching_terms(value, rules["triggers"]),
        "optional": matching_terms(value, rules["optional"]),
        "termination": matching_terms(value, rules["termination"]),
        "productPack": matching_terms(value, pack_keywords),
        "negative": [line for line in lines if short_heading_matches(line, rules["negativeOnlyHeadings"])],
    }
    score = 0
    score += 10 if section else 0
    score += 6 if titles else 0
    score += 4 if signals["actions"] else 0
    score += 3 if signals["quantitative"] else 0
    score += 3 if signals["triggers"] else 0
    score += 3 if signals["optional"] else 0
    score += 2 if signals["termination"] else 0
    score += 2 if signals["productPack"] else 0
    if signals["negative"] and not (section or titles or signals["actions"]):
        score -= 8
    return {**page, "score": score, "signals": signals}


def responsibility_section_pages(scored_pages, rules):
    starts = [
        index for index, page in enumerate(scored_pages)
        if page["signals"]["section"]
    ]
    ranges = []
    for start in starts:
        end = len(scored_pages) - 1
        for index in range(start + 1, len(scored_pages)):
            lines = [line.strip() for line in scored_pages[index]["text"].splitlines() if line.strip()]
            if any(short_heading_matches(line, rules["sectionEndHeadings"]) for line in lines):
                end = index
                break
        ranges.append((start, end))
    return ranges


def retrieve(source_text, product_name, rules):
    pages = split_pages(source_text)
    pack_names = detect_packs(product_name, source_text, rules)
    pack_keywords = []
    for name in pack_names:
        pack_keywords.extend(rules["productPacks"][name].get("keywords", []))
    scored = [score_page(page, rules, pack_keywords) for page in pages]
    thresholds = rules["thresholds"]
    selected = set(range(min(thresholds["identityPageCount"], len(scored))))
    ranges = responsibility_section_pages(scored, rules)
    has_retrieval_signal = bool(ranges)
    for start, end in ranges:
        selected.update(range(start, end + 1))
    if not ranges:
        for index, page in enumerate(scored):
            if page["score"] >= thresholds["minimumPageScore"]:
                has_retrieval_signal = True
                radius = thresholds["contextRadius"]
                selected.update(range(max(0, index - radius), min(len(scored), index + radius + 1)))
    selected_text = "\n".join(scored[index]["text"] for index in sorted(selected))
    selected_compact = re.sub(r"\s+", "", selected_text)
    for reference in rules["tableReferences"]:
        compact_reference = re.sub(r"\s+", "", reference)
        if compact_reference not in selected_compact:
            continue
        selected.update(
            index for index, page in enumerate(scored)
            if compact_reference in re.sub(r"\s+", "", page["text"])
        )

    table_signals = rules.get("tablePageSignals", [])
    table_pages = {
        index for index, page in enumerate(scored)
        if sum(signal in page["text"] for signal in table_signals) >= 2
    }
    for index in sorted(selected & table_pages):
        for neighbor in range(max(0, index - 1), min(len(scored), index + 3)):
            if neighbor in table_pages:
                selected.add(neighbor)

    warnings = []
    if not ranges:
        warnings.append("responsibility_section_heading_not_found")
    if not any(page["signals"]["titles"] for page in scored):
        warnings.append("responsibility_title_not_found")
    if not any(page["signals"]["actions"] for page in scored):
        warnings.append("responsibility_action_not_found")
    if not has_retrieval_signal or len(selected) / max(1, len(scored)) > thresholds["maximumCandidateRatio"]:
        selected = set(range(len(scored)))
        mode = "full_text_fallback"
    else:
        mode = "candidate_pages"
    candidate_text = "\n\n".join(
        f"PDF_PAGE_{scored[index]['page']}\n{scored[index]['text']}" for index in sorted(selected)
    )
    report = {
        "mode": mode,
        "productPacks": pack_names,
        "totalPages": len(scored),
        "selectedPages": [scored[index]["page"] for index in sorted(selected)],
        "candidateRatio": round(len(selected) / max(1, len(scored)), 4),
        "sectionRanges": [
            {"startPage": scored[start]["page"], "endPage": scored[end]["page"]}
            for start, end in ranges
        ],
        "coverageWarnings": warnings,
        "tablePages": [scored[index]["page"] for index in sorted(table_pages)],
        "selectedTablePages": [scored[index]["page"] for index in sorted(selected & table_pages)],
        "pageScores": [
            {
                "page": page["page"], "score": page["score"],
                "titles": page["signals"]["titles"],
                "matchedCategories": [
                    key for key, values in page["signals"].items() if values and key != "negative"
                ],
            }
            for page in scored
        ],
    }
    return candidate_text, report


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-text", required=True, type=Path)
    parser.add_argument("--product-name", default="")
    parser.add_argument("--output-text", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--rules", type=Path, default=Path(__file__).with_name("responsibility_retrieval_rules.json"))
    args = parser.parse_args(argv)
    source_text = args.source_text.read_text(encoding="utf-8")
    candidate_text, report = retrieve(source_text, args.product_name, load_rules(args.rules))
    args.output_text.parent.mkdir(parents=True, exist_ok=True)
    args.output_text.write_text(candidate_text, encoding="utf-8")
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
