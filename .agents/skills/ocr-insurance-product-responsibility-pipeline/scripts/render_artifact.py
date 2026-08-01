#!/usr/bin/env python3
import argparse
import hashlib
import json
import sys
from pathlib import Path

from validate_artifact import validate_artifact


def clean(value):
    return " ".join(str(value or "").split())


def evidence_text(item):
    segments = item.get("evidenceSegments") if isinstance(item, dict) else None
    if isinstance(segments, list) and segments:
        return " / ".join(clean(segment.get("sourceExcerpt")) for segment in segments if isinstance(segment, dict))
    return clean(item.get("sourceExcerpt")) if isinstance(item, dict) else ""


def evidence_pages(item):
    segments = item.get("evidenceSegments") if isinstance(item, dict) else None
    if isinstance(segments, list) and segments:
        return "、".join(clean(segment.get("sourcePage")) for segment in segments if isinstance(segment, dict))
    return clean(item.get("sourcePage")) if isinstance(item, dict) else ""


def identity_value(identity, key):
    value = clean(identity.get(key))
    if value:
        return value
    evidence = identity.get("fieldEvidence") if isinstance(identity.get("fieldEvidence"), dict) else {}
    item = evidence.get(key) if isinstance(evidence.get(key), dict) else {}
    if item.get("status") == "not_present_in_source":
        return "官方来源未载明"
    return "未核验"


def render_artifact(artifact):
    identity = artifact["productIdentity"]
    lines = [
        f"# {clean(artifact['company'])}《{clean(artifact['productName'])}》",
        "",
        f"- 条款备案号：{identity_value(identity, 'filingCode')}",
        f"- 产品代码：{identity_value(identity, 'productCode')}",
        f"- 备案日期：{identity_value(identity, 'filingDate')}",
        f"- 官方来源：{clean(identity['sourceUrl'])}",
        f"- 来源摘要：{clean(identity['sourceDigest'])}",
        "",
        "## 可选责任套餐",
        "",
    ]
    responsibility_by_id = {item["responsibilityId"]: item for item in artifact["responsibilities"]}
    groups = artifact.get("optionalGroups") or []
    if groups:
        for group in groups:
            child_names = [responsibility_by_id[item]["liability"] for item in group["childResponsibilityIds"]]
            lines.append(f"- {clean(group['label'])}｜{clean(group['selectionStatus'])}｜{'+'.join(child_names)}")
            lines.append(f"  - 原文位置：{evidence_pages(group)}")
            lines.append(f"  - 分组原文：{evidence_text(group)}")
    else:
        lines.append("- 无可选责任套餐")

    services = artifact.get("productServices") or []
    if services:
        lines.extend(["", "## 产品服务（不计入保险责任）", ""])
        for service in services:
            lines.extend([
                f"- {clean(service['title'])}：{clean(service['customerSummary'])}",
                f"  - 原文位置：{evidence_pages(service)}",
                f"  - 原文摘录：{evidence_text(service)}",
            ])

    rules = artifact.get("productRules") or []
    if rules:
        lines.extend(["", "## 跨责任规则（不单独计为保险责任）", ""])
        for rule in rules:
            lines.extend([
                f"- {clean(rule['title'])}",
                f"  - 规则类型：`{clean(rule.get('ruleKind'))}`",
                f"  - 原文位置：{evidence_pages(rule)}",
                f"  - 原文摘录：{evidence_text(rule)}",
            ])
            calculation = rule.get("calculation") if isinstance(rule.get("calculation"), dict) else None
            if calculation:
                lines.append(f"  - 结算公式：{clean(calculation.get('formulaText'))}")
                for branch in calculation.get("branches") or []:
                    lines.append(
                        f"    - `{clean(branch.get('branchId'))}`：{clean(branch.get('conditionText'))}｜"
                        f"{clean(branch.get('formulaText'))}"
                    )

    lines.extend(["", "## 保险责任、责任卡与指标", ""])
    for index, responsibility in enumerate(artifact["responsibilities"], start=1):
        card = responsibility["card"]
        lines.extend([
            f"### {index}. {clean(card['title'])}",
            "",
            f"- 责任ID：`{clean(responsibility['responsibilityId'])}`",
            f"- 选择状态：{clean(responsibility['selectionStatus'])}",
            f"- 触发条件：{clean(responsibility['triggerCondition'])}",
            f"- 保险人责任：{clean(responsibility['insurerObligation'])}",
            f"- 客户卡摘要：{clean(card['customerSummary'])}",
            f"- 客户卡给付说明：{clean(card['benefitExplanation'])}",
        ])
        if responsibility.get("parentResponsibilityId"):
            lines.append(f"- 父责任分组：`{clean(responsibility['parentResponsibilityId'])}`")
        if responsibility.get("responsibilityKind"):
            lines.append(f"- 责任类型：`{clean(responsibility['responsibilityKind'])}`")
        if responsibility.get("coverageAggregation"):
            lines.append(f"- 保障汇总：`{clean(responsibility['coverageAggregation'])}`")
        if responsibility.get("ruleRefs"):
            lines.append(f"- 适用跨责任规则：{', '.join(f'`{clean(value)}`' for value in responsibility['ruleRefs'])}")
        for indicator in responsibility["indicators"]:
            lines.extend([
                f"- 量化指标：{clean(indicator['indicatorName'])}",
                f"- 指标公式：{clean(indicator.get('formulaText'))}",
                f"- 计算基数：`{clean(indicator.get('basisKey'))}`",
                f"- 计算状态：`{clean(indicator.get('calculationStatus'))}`",
            ])
            definition = indicator.get("basisDefinition") if isinstance(indicator.get("basisDefinition"), dict) else None
            if definition:
                lines.append(
                    f"- 基数定义：{evidence_text(definition)}（{evidence_pages(definition)}）"
                )
            for branch in indicator.get("branches") or []:
                lines.append(
                    f"  - 分支 `{clean(branch.get('branchId'))}`："
                    f"{clean(branch.get('conditionText'))}｜{clean(branch.get('formulaText'))}｜"
                    f"基数 `{clean(branch.get('basisKey'))}`｜状态 `{clean(branch.get('calculationStatus'))}`"
                )
                branch_definition = branch.get("basisDefinition") if isinstance(branch.get("basisDefinition"), dict) else None
                if branch_definition:
                    lines.append(
                        f"    - 基数定义：{evidence_text(branch_definition)}"
                        f"（{evidence_pages(branch_definition)}）"
                    )
                for operand in branch.get("operands") or []:
                    lines.append(
                        f"    - 分支比较项 `{clean(operand.get('operandId'))}`："
                        f"{clean(operand.get('formulaText'))}｜基数 `{clean(operand.get('basisKey'))}`"
                    )
            for operand in indicator.get("operands") or []:
                lines.append(
                    f"  - 比较项 `{clean(operand.get('operandId'))}`："
                    f"{clean(operand.get('formulaText'))}｜基数 `{clean(operand.get('basisKey'))}`"
                )
        lines.extend([
            f"- 原文位置：{evidence_pages(responsibility)}",
            f"- 原文摘录：{evidence_text(responsibility)}",
            "",
        ])

    audit = artifact["audit"]
    lines.extend([
        "## 确定性审计",
        "",
        f"- 状态：`{clean(audit['status'])}`",
        f"- 官方清单：{audit['officialChecklistCount']}",
        f"- 责任清单：{audit['inventoryCount']}",
        f"- 责任卡：{audit['cardCount']}",
        f"- 指标决策：{audit['indicatorDecisionCount']}",
        "- 校验器：`passed`",
        "",
    ])
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Render a validated OCR insurance responsibility artifact")
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--source-text", required=True, type=Path)
    parser.add_argument("--source-document", required=True, type=Path)
    parser.add_argument("--official-domain", required=True, action="append")
    args = parser.parse_args(argv)
    try:
        artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"artifact: {error}", file=sys.stderr)
        return 2
    if not isinstance(artifact, dict):
        print("artifact: root must be an object", file=sys.stderr)
        return 2
    try:
        source_text = args.source_text.read_text(encoding="utf-8")
        source_digest = f"sha256:{hashlib.sha256(args.source_document.read_bytes()).hexdigest()}"
    except (OSError, UnicodeError) as error:
        print(f"source: {error}", file=sys.stderr)
        return 2
    issues = validate_artifact(
        artifact,
        source_text=source_text,
        source_digest=source_digest,
        official_domains=args.official_domain,
    )
    if issues:
        for issue in issues:
            print(issue, file=sys.stderr)
        return 1
    print(render_artifact(artifact))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
