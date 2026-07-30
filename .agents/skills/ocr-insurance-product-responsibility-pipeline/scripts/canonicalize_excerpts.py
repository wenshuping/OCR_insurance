#!/usr/bin/env python3
"""Replace shortened evidence with exact contiguous passages from official text."""

import argparse
import json
import re
import sys
import unicodedata
from copy import deepcopy
from pathlib import Path


PAGE_MARKER_PATTERN = re.compile(
    r"^(?:=+\s*)?PDF(?:_(?:LAYOUT_)?PAGE|\s+PAGE)[^\n=]*(?:\s*=+)?\s*$",
    flags=re.IGNORECASE | re.MULTILINE,
)
SHARED_PARENT_CHILD_HEADING_PATTERN = re.compile(r"^(.+?)(\(\d+\).+)$")


def compact_with_positions(value):
    compacted = []
    positions = []
    for index, character in enumerate(str(value or "")):
        for normalized in unicodedata.normalize("NFKC", character):
            if normalized.isspace():
                continue
            compacted.append(normalized)
            positions.append(index)
    return "".join(compacted), positions


def is_subsequence(needle, haystack):
    iterator = iter(haystack)
    return all(any(character == candidate for candidate in iterator) for character in needle)


def occurrences(text, fragment):
    start = 0
    while True:
        index = text.find(fragment, start)
        if index < 0:
            return
        yield index
        start = index + 1


def shortest_subsequence_window(needle, haystack):
    """Find the smallest source window that restores PDF footnotes or inserted text."""
    candidates = []
    for anchor_size in (16, 12, 10, 8, 6, 4):
        if len(needle) < anchor_size:
            continue
        prefix = needle[:anchor_size]
        for start in occurrences(haystack, prefix):
            cursor = start + anchor_size
            for character in needle[anchor_size:]:
                cursor = haystack.find(character, cursor)
                if cursor < 0:
                    break
                cursor += 1
            else:
                length = cursor - start
                if length <= max(len(needle) * 5, len(needle) + 24):
                    candidates.append((length, start, cursor))
        if candidates:
            return min(candidates)
    return None


def ordered_anchor_window(anchors, source_text, source_compact, source_positions):
    """Return the smallest exact source window containing ordered group/child headings."""
    compact_anchors = [compact_with_positions(anchor)[0] for anchor in anchors]
    compact_anchors = [anchor for anchor in compact_anchors if anchor]
    if len(compact_anchors) < 2:
        return None
    candidates = []
    for start in occurrences(source_compact, compact_anchors[0]):
        cursor = start + len(compact_anchors[0])
        for anchor in compact_anchors[1:]:
            cursor = source_compact.find(anchor, cursor)
            if cursor < 0:
                break
            cursor += len(anchor)
        else:
            if cursor - start <= 100000:
                candidates.append((cursor - start, start, cursor))
    if not candidates:
        return None
    _, start, end = min(candidates)
    original_start = source_positions[start]
    original_end = source_positions[end - 1] + 1
    return source_text[original_start:original_end]


def unordered_anchor_window(anchors, source_text, source_compact, source_positions):
    """Recover a group window when PDF column extraction reorders its child headings."""
    compact_anchors = [compact_with_positions(anchor)[0] for anchor in anchors]
    compact_anchors = [anchor for anchor in compact_anchors if anchor]
    if len(compact_anchors) < 2:
        return None
    label = compact_anchors[0]
    candidates = []
    for label_start in occurrences(source_compact, label):
        starts = [label_start]
        for anchor in compact_anchors[1:]:
            anchor_occurrences = list(occurrences(source_compact, anchor))
            if not anchor_occurrences:
                break
            starts.append(min(anchor_occurrences, key=lambda value: abs(value - label_start)))
        else:
            start = min(starts)
            end = max(
                position + len(anchor)
                for position, anchor in zip(starts, compact_anchors, strict=True)
            )
            if end - start <= 100000:
                candidates.append((end - start, start, end))
    if not candidates:
        return None
    _, start, end = min(candidates)
    original_start = source_positions[start]
    original_end = source_positions[end - 1] + 1
    return source_text[original_start:original_end]


def shared_parent_child_anchors(headings):
    parsed = []
    for heading in headings:
        match = SHARED_PARENT_CHILD_HEADING_PATTERN.fullmatch(compact_with_positions(heading)[0])
        if not match:
            return None
        parsed.append(match.groups())
    parents = {parent for parent, _ in parsed}
    if len(parents) != 1:
        return None
    return [parsed[0][0], *(child for _, child in parsed)]


def canonical_excerpt(excerpt, source_text, source_compact, source_positions, exact_source=False):
    excerpt_compact, _ = compact_with_positions(excerpt)
    if not excerpt_compact:
        return None
    exact_index = source_compact.find(excerpt_compact)
    if exact_index >= 0:
        if exact_source:
            original_start = source_positions[exact_index]
            original_end = source_positions[exact_index + len(excerpt_compact) - 1] + 1
            return source_text[original_start:original_end]
        return excerpt

    shortest = shortest_subsequence_window(excerpt_compact, source_compact)
    if shortest:
        _, start, end = shortest
        original_start = source_positions[start]
        original_end = source_positions[end - 1] + 1
        return source_text[original_start:original_end]

    candidates = []
    maximum_window = max(500, min(6000, len(excerpt_compact) * 5))
    for anchor_size in (32, 24, 18, 14, 10, 8):
        if len(excerpt_compact) < anchor_size * 2:
            continue
        prefix = excerpt_compact[:anchor_size]
        suffix = excerpt_compact[-anchor_size:]
        for start in occurrences(source_compact, prefix):
            search_end = min(len(source_compact), start + maximum_window)
            end = source_compact.find(suffix, start + anchor_size, search_end)
            while end >= 0:
                end += anchor_size
                candidate = source_compact[start:end]
                if len(candidate) <= len(excerpt_compact) * 5 and is_subsequence(excerpt_compact, candidate):
                    candidates.append((len(candidate), start, end))
                next_end = source_compact.find(suffix, end - anchor_size + 1, search_end)
                if next_end < 0:
                    break
                end = next_end
        if candidates:
            break
    if not candidates:
        return None
    candidates.sort()
    _, start, end = candidates[0]
    original_start = source_positions[start]
    original_end = source_positions[end - 1] + 1
    return source_text[original_start:original_end]


def canonical_evidence_segments(excerpt, source_text, source_compact, source_positions, source_page=""):
    """Recover exact ordered passages when one model excerpt skips footnotes, columns, or page breaks."""
    excerpt_compact, _ = compact_with_positions(excerpt)
    if len(excerpt_compact) < 16:
        return []
    windows = []
    for anchor_size in (32, 24, 18, 14, 10, 8):
        if len(excerpt_compact) < anchor_size * 2:
            continue
        prefix = excerpt_compact[:anchor_size]
        suffix = excerpt_compact[-anchor_size:]
        for start in occurrences(source_compact, prefix):
            end = source_compact.find(suffix, start + anchor_size)
            while end >= 0:
                end += anchor_size
                candidate = source_compact[start:end]
                if is_subsequence(excerpt_compact, candidate):
                    windows.append((len(candidate), start, end))
                    break
                end = source_compact.find(suffix, end - anchor_size + 1)
        if windows:
            break
    if not windows:
        return []
    _, start, end = min(windows)
    matched_positions = []
    cursor = start
    for character in excerpt_compact:
        cursor = source_compact.find(character, cursor, end)
        if cursor < 0:
            return []
        matched_positions.append(cursor)
        cursor += 1
    runs = []
    run_start = matched_positions[0]
    run_end = run_start + 1
    for position in matched_positions[1:]:
        if position == run_end:
            run_end += 1
            continue
        runs.append((run_start, run_end))
        run_start, run_end = position, position + 1
    runs.append((run_start, run_end))
    meaningful = [(run_start, run_end) for run_start, run_end in runs if run_end - run_start >= 4]
    if not meaningful or len(meaningful) > 12:
        return []
    covered = sum(run_end - run_start for run_start, run_end in meaningful)
    if covered < len(excerpt_compact) * 0.8:
        return []
    result = []
    for run_start, run_end in meaningful:
        original_start = source_positions[run_start]
        original_end = source_positions[run_end - 1] + 1
        result.append({
            "sourcePage": str(source_page or "官方条款原文"),
            "sourceExcerpt": source_text[original_start:original_end],
        })
    return result


def page_marker_segments(excerpt, source_page=""):
    """Split an exact extracted passage at synthetic PDF page markers."""
    matches = list(PAGE_MARKER_PATTERN.finditer(str(excerpt or "")))
    if not matches:
        return []
    segments = []
    cursor = 0
    current_page = str(source_page or "官方条款原文")
    for match in matches:
        passage = excerpt[cursor:match.start()].strip()
        if passage:
            segments.append({"sourcePage": current_page, "sourceExcerpt": passage})
        page_match = re.search(r"PDF(?:_PAGE|\s+PAGE)\s*[_-]?\s*(\d+)", match.group(), re.IGNORECASE)
        if page_match:
            current_page = f"PDF第{page_match.group(1)}页"
        cursor = match.end()
    passage = excerpt[cursor:].strip()
    if passage:
        segments.append({"sourcePage": current_page, "sourceExcerpt": passage})
    return segments


def canonicalize(value, source_text, source_compact, source_positions, path="artifact"):
    changed = []
    unresolved = []
    if isinstance(value, dict):
        existing_segments = value.get("evidenceSegments")
        if isinstance(existing_segments, list):
            flattened_segments = []
            flattened = False
            for segment in existing_segments:
                if not isinstance(segment, dict):
                    flattened_segments.append(segment)
                    continue
                split_segments = page_marker_segments(
                    segment.get("sourceExcerpt"),
                    segment.get("sourcePage"),
                )
                if split_segments:
                    flattened_segments.extend(split_segments)
                    flattened = True
                else:
                    flattened_segments.append(segment)
            if flattened:
                value["evidenceSegments"] = flattened_segments
                changed.append(f"{path}.evidenceSegments")
        child = value.get("sourceExcerpt")
        if isinstance(child, str) and child.strip():
            child_path = f"{path}.sourceExcerpt"
            marker_segments = page_marker_segments(child, value.get("sourcePage"))
            if marker_segments:
                value["evidenceSegments"] = marker_segments
                value.pop("sourceExcerpt", None)
                changed.append(child_path)
            else:
                canonical = canonical_excerpt(child, source_text, source_compact, source_positions)
                if canonical is None:
                    segments = canonical_evidence_segments(
                        child,
                        source_text,
                        source_compact,
                        source_positions,
                        source_page=value.get("sourcePage"),
                    )
                    if segments:
                        value["evidenceSegments"] = segments
                        value.pop("sourceExcerpt", None)
                        changed.append(child_path)
                    else:
                        unresolved.append(child_path)
                elif canonical != child:
                    value["sourceExcerpt"] = canonical
                    changed.append(child_path)
        for key, child in list(value.items()):
            child_path = f"{path}.{key}"
            if key == "sourceExcerpt":
                continue
            child_changed, child_unresolved = canonicalize(
                child,
                source_text,
                source_compact,
                source_positions,
                child_path,
            )
            changed.extend(child_changed)
            unresolved.extend(child_unresolved)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_changed, child_unresolved = canonicalize(
                child,
                source_text,
                source_compact,
                source_positions,
                f"{path}[{index}]",
            )
            changed.extend(child_changed)
            unresolved.extend(child_unresolved)
    if path == "artifact":
        changed.extend(normalize_optional_group_evidence(value, source_text, source_compact, source_positions))
        changed.extend(normalize_calculation_structure(value))
        changed.extend(canonicalize_supported_fields(value, source_text))
    return changed, unresolved


def evidence_text(value):
    if not isinstance(value, dict):
        return ""
    segments = value.get("evidenceSegments")
    if isinstance(segments, list) and segments:
        return "\n".join(
            str(segment.get("sourceExcerpt") or "")
            for segment in segments
            if isinstance(segment, dict)
        )
    return str(value.get("sourceExcerpt") or "")


def append_evidence(owner, source_excerpt):
    segments = owner.get("evidenceSegments")
    if not isinstance(segments, list):
        segments = []
        existing = owner.pop("sourceExcerpt", "")
        if existing:
            segments.append({
                "sourcePage": str(owner.get("sourcePage") or "官方条款原文"),
                "sourceExcerpt": existing,
            })
        owner["evidenceSegments"] = segments
    existing_compact = "".join(
        compact_with_positions(segment.get("sourceExcerpt"))[0]
        for segment in segments
        if isinstance(segment, dict)
    )
    additions = page_marker_segments(source_excerpt, owner.get("sourcePage")) or [{
        "sourcePage": str(owner.get("sourcePage") or "官方条款原文"),
        "sourceExcerpt": source_excerpt,
    }]
    for addition in additions:
        passage_compact, _ = compact_with_positions(addition.get("sourceExcerpt"))
        if passage_compact and passage_compact not in existing_compact:
            segments.append(addition)
            existing_compact += passage_compact


def exact_context_excerpt(fragment, source_text, source_compact, source_positions):
    """Return an exact nearby clause for a token found elsewhere in the source."""
    fragment_compact, _ = compact_with_positions(fragment)
    if not fragment_compact:
        return None
    start = source_compact.find(fragment_compact)
    if start < 0:
        return None
    original_start = source_positions[start]
    original_end = source_positions[start + len(fragment_compact) - 1] + 1
    left_bound = max(0, original_start - 240)
    right_bound = min(len(source_text), original_end + 240)
    left = max(
        source_text.rfind("。", left_bound, original_start),
        source_text.rfind("；", left_bound, original_start),
        source_text.rfind("\n\n", left_bound, original_start),
    )
    if left >= 0:
        left += 1 if source_text[left] != "\n" else 2
    else:
        left = left_bound
    ends = [
        position + 1
        for separator in ("。", "；", "\n\n")
        if (position := source_text.find(separator, original_end, right_bound)) >= 0
    ]
    right = min(ends) if ends else right_bound
    passage = source_text[left:right].strip()
    return passage if fragment_compact in compact_with_positions(passage)[0] else None


def set_exact_evidence(item, excerpt):
    segments = page_marker_segments(excerpt, item.get("sourcePage"))
    if segments:
        item["evidenceSegments"] = segments
        item.pop("sourceExcerpt", None)
        return
    item["sourceExcerpt"] = excerpt
    item.pop("evidenceSegments", None)


def normalize_optional_group_evidence(artifact, source_text, source_compact, source_positions):
    changed = []
    checklist = {
        str(item.get("responsibilityId") or ""): str(item.get("officialHeading") or "")
        for item in artifact.get("officialChecklist", [])
        if isinstance(item, dict)
    }
    official_groups = {
        str(group.get("groupId") or ""): group
        for group in artifact.get("officialOptionalGroupChecklist", [])
        if isinstance(group, dict)
    }
    generated_groups = {
        str(group.get("groupId") or ""): group
        for group in artifact.get("optionalGroups", [])
        if isinstance(group, dict)
    }
    for group_id, official_group in official_groups.items():
        label = official_group.get("officialLabel") or official_group.get("label")
        child_headings = [
            checklist.get(str(responsibility_id), "")
            for responsibility_id in official_group.get("childResponsibilityIds", [])
        ]
        if not label or not child_headings or any(not heading for heading in child_headings):
            continue
        excerpt = ordered_anchor_window(
            [label, *child_headings],
            source_text,
            source_compact,
            source_positions,
        )
        if not excerpt:
            excerpt = unordered_anchor_window(
                [label, *child_headings],
                source_text,
                source_compact,
                source_positions,
            )
        if not excerpt:
            shared_anchors = shared_parent_child_anchors(child_headings)
            if shared_anchors:
                excerpt = ordered_anchor_window(
                    [label, *shared_anchors],
                    source_text,
                    source_compact,
                    source_positions,
                )
                if not excerpt:
                    excerpt = unordered_anchor_window(
                        [label, *shared_anchors],
                        source_text,
                        source_compact,
                        source_positions,
                    )
        if not excerpt:
            continue
        set_exact_evidence(official_group, excerpt)
        changed.append(f"artifact.officialOptionalGroupChecklist[{group_id}].evidence")
        generated_group = generated_groups.get(group_id)
        if generated_group is None:
            continue
        if "evidenceSegments" in official_group:
            generated_group["evidenceSegments"] = deepcopy(official_group["evidenceSegments"])
            generated_group.pop("sourceExcerpt", None)
        else:
            generated_group["sourceExcerpt"] = official_group["sourceExcerpt"]
            generated_group.pop("evidenceSegments", None)
        generated_group["sourcePage"] = official_group.get("sourcePage", generated_group.get("sourcePage"))
        changed.append(f"artifact.optionalGroups[{group_id}].evidence")
    return changed


def comparison_kind(item):
    formula = compact_with_positions(item.get("formulaText"))[0].lower()
    normalized = compact_with_positions(item.get("normalizedFormula"))[0].lower()
    calculation_key = str(item.get("calculationKey") or "").lower()
    maximum = "max(" in formula or "max(" in normalized or "较大者" in formula or calculation_key == "maximum_of_bases"
    minimum = "min(" in formula or "min(" in normalized or "较小者" in formula or calculation_key == "minimum_of_bases"
    return maximum, minimum


def normalize_calculation_structure(value, path="artifact"):
    changed = []
    if isinstance(value, dict):
        liability_text = compact_with_positions(value.get("liability"))[0]
        responsibility_evidence = compact_with_positions(
            f"{value.get('liability') or ''}{evidence_text(value)}"
        )[0]
        if (
            "等待期" in responsibility_evidence
            and any(token in liability_text for token in ("退还", "返还"))
        ):
            if value.get("responsibilityKind") != "waiting_period_refund":
                value["responsibilityKind"] = "waiting_period_refund"
                changed.append(f"{path}.responsibilityKind")
            if value.get("coverageAggregation") != "exclude":
                value["coverageAggregation"] = "exclude"
                changed.append(f"{path}.coverageAggregation")

        if "formulaText" in value and "basisKey" in value:
            maximum, minimum = comparison_kind(value)
            operands = value.get("operands") if isinstance(value.get("operands"), list) else []
            if (maximum or minimum) and len(operands) >= 2:
                prefix = "max_of_" if maximum else "min_of_"
                bases = [str(operand.get("basisKey") or "") for operand in operands if isinstance(operand, dict)]
                if len(bases) == len(operands) and all(bases):
                    expected = prefix + "_".join(bases)
                    if value.get("basisKey") != expected:
                        value["basisKey"] = expected
                        changed.append(f"{path}.basisKey")
                    calculation_key = "maximum_of_bases" if maximum else "minimum_of_bases"
                    if value.get("calculationKey") != calculation_key:
                        value["calculationKey"] = calculation_key
                        changed.append(f"{path}.calculationKey")
            elif operands and not (maximum or minimum):
                value.pop("operands", None)
                changed.append(f"{path}.operands")

        basis_key = str(value.get("basisKey") or "")
        if "requiredInputs" in value and not value.get("requiredInputs"):
            if basis_key and basis_key != "piecewise" and not basis_key.startswith(("max_of_", "min_of_")):
                value["requiredInputs"] = [basis_key]
                changed.append(f"{path}.requiredInputs")

        for key, child in list(value.items()):
            changed.extend(normalize_calculation_structure(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            changed.extend(normalize_calculation_structure(child, f"{path}[{index}]"))
    return changed


def canonicalize_supported_fields(
    value,
    source_text="",
    inherited_evidence="",
    evidence_owner=None,
    path="artifact",
):
    changed = []
    if isinstance(value, dict):
        own_evidence = evidence_text(value)
        local_evidence = own_evidence or inherited_evidence
        local_owner = value if own_evidence else evidence_owner
        if not value.get("evidenceTokens") and local_evidence and isinstance(value.get("branches"), list):
            local_compact, _ = compact_with_positions(local_evidence)
            branch_tokens = []
            for branch in value["branches"]:
                for token in branch.get("evidenceTokens", []) if isinstance(branch, dict) else []:
                    if (
                        isinstance(token, str)
                        and compact_with_positions(token)[0] in local_compact
                        and token not in branch_tokens
                    ):
                        branch_tokens.append(token)
            if branch_tokens:
                value["evidenceTokens"] = branch_tokens
                changed.append(f"{path}.evidenceTokens")
        if (
            "formulaText" in value
            and not value.get("evidenceTokens")
            and value.get("calculationStatus") != "not_quantitative"
            and local_evidence
        ):
            formula = str(value.get("formulaText") or "").strip()
            local_compact, _ = compact_with_positions(local_evidence)
            if formula and compact_with_positions(formula)[0] in local_compact:
                value["evidenceTokens"] = [formula]
                changed.append(f"{path}.evidenceTokens")
        for key, child in list(value.items()):
            child_path = f"{path}.{key}"
            if key == "evidenceTokens" and isinstance(child, list) and local_evidence:
                local_compact, local_positions = compact_with_positions(local_evidence)
                repaired = []
                for token in child:
                    if not isinstance(token, str) or not token.strip():
                        repaired.append(token)
                        continue
                    token_compact, _ = compact_with_positions(token)
                    if token_compact in local_compact:
                        repaired.append(token)
                        continue
                    canonical = canonical_excerpt(
                        token,
                        local_evidence,
                        local_compact,
                        local_positions,
                        exact_source=True,
                    )
                    if canonical is None and source_text and local_owner is not None:
                        source_compact, source_positions = compact_with_positions(source_text)
                        canonical = canonical_excerpt(
                            token,
                            source_text,
                            source_compact,
                            source_positions,
                            exact_source=True,
                        )
                        if canonical is not None:
                            context = exact_context_excerpt(
                                canonical,
                                source_text,
                                source_compact,
                                source_positions,
                            )
                            append_evidence(local_owner, context or canonical)
                            local_evidence = evidence_text(local_owner)
                            local_compact, local_positions = compact_with_positions(local_evidence)
                    repaired.append(canonical if canonical is not None else token)
                if repaired != child:
                    value[key] = repaired
                    changed.append(child_path)
                continue
            if key == "branches" and isinstance(child, list) and local_evidence:
                local_compact, _ = compact_with_positions(local_evidence)
                for index, branch in enumerate(child):
                    if not isinstance(branch, dict) or branch.get("evidenceTokens"):
                        continue
                    formula = str(branch.get("formulaText") or "").strip()
                    condition = str(branch.get("conditionText") or "").strip()
                    supported = [
                        phrase for phrase in (formula, condition)
                        if phrase and compact_with_positions(phrase)[0] in local_compact
                    ]
                    if supported:
                        branch["evidenceTokens"] = [supported[0]]
                        changed.append(f"{child_path}[{index}].evidenceTokens")
            if key == "conditionText" and isinstance(child, str) and child.strip() and local_evidence:
                semantic_child = re.sub(r"\n{3,}", "\n\n", PAGE_MARKER_PATTERN.sub("", child)).strip()
                if semantic_child != child:
                    value[key] = semantic_child
                    child = semantic_child
                    changed.append(child_path)
                compact, positions = compact_with_positions(local_evidence)
                canonical = canonical_excerpt(child, local_evidence, compact, positions)
                if canonical is None and source_text and local_owner is not None:
                    source_compact, source_positions = compact_with_positions(source_text)
                    canonical = canonical_excerpt(
                        child,
                        source_text,
                        source_compact,
                        source_positions,
                        exact_source=True,
                    )
                    child_compact, _ = compact_with_positions(child)
                    canonical_compact, _ = compact_with_positions(canonical)
                    if canonical and len(canonical_compact) <= max(len(child_compact) * 1.5, len(child_compact) + 12):
                        append_evidence(local_owner, canonical)
                        local_evidence = evidence_text(local_owner)
                    else:
                        canonical = None
                if canonical is not None and canonical != child:
                    value[key] = canonical
                    changed.append(child_path)
                continue
            changed.extend(canonicalize_supported_fields(
                child,
                source_text,
                local_evidence,
                local_owner,
                child_path,
            ))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            changed.extend(canonicalize_supported_fields(
                child,
                source_text,
                inherited_evidence,
                evidence_owner,
                f"{path}[{index}]",
            ))
    return changed


def canonicalize_to_fixed_point(
    artifact,
    source_text,
    source_compact,
    source_positions,
    max_passes=3,
):
    """Normalize repeatedly until the artifact stops changing or the pass limit is reached."""
    passes = []
    unresolved = []
    converged = False
    for pass_index in range(1, max_passes + 1):
        before = json.dumps(artifact, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        changed, unresolved = canonicalize(
            artifact,
            source_text,
            source_compact,
            source_positions,
        )
        after = json.dumps(artifact, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        converged = after == before
        passes.append({
            "pass": pass_index,
            "changed": changed,
            "unresolved": unresolved,
            "stable": converged,
        })
        if converged:
            break
    return passes, unresolved, converged


def main(argv=None):
    parser = argparse.ArgumentParser(description="Canonicalize artifact excerpts from official source text")
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--source-text", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
        source_text = args.source_text.read_text(encoding="utf-8")
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f"input: {error}", file=sys.stderr)
        return 2
    if not isinstance(artifact, dict):
        print("artifact: root must be an object", file=sys.stderr)
        return 2
    source_compact, source_positions = compact_with_positions(source_text)
    passes, unresolved, converged = canonicalize_to_fixed_point(
        artifact,
        source_text,
        source_compact,
        source_positions,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
    changed = list(dict.fromkeys(
        path
        for normalization_pass in passes
        for path in normalization_pass["changed"]
    ))
    print(json.dumps({
        "passCount": len(passes),
        "converged": converged,
        "passes": passes,
        "changed": changed,
        "unresolved": unresolved,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
