#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import urlparse


GENERIC_CARD_TITLES = {
    "基本责任",
    "基本生存保险金",
    "保险责任",
    "可选责任",
    "可选责任一",
    "可选责任二",
    "可选生存保险金",
}
SELECTION_STATUSES = {"included", "not_included", "unknown"}
CALCULATION_STATUSES = {
    "calculable",
    "display_only",
    "needs_table",
    "needs_claim_facts",
    "not_quantitative",
}
IDENTITY_EVIDENCE_STATUSES = {"verified", "not_present_in_source"}
AMBIGUOUS_BASIS_KEYS = {"effective_insured_amount", "sum_assured", "death_formula"}
RESPONSIBILITY_KINDS = {"benefit", "waiver", "waiting_period_refund"}
COVERAGE_AGGREGATION_STATES = {"include", "exclude"}
TRUNCATION_MARKERS = ("…", "...")
UNSUPPORTED_CONTINUATION_CLAIMS = ("权益不受影响", "不影响其他保险责任", "其他责任不受影响")
NON_RESPONSIBILITY_HEADINGS = {
    "责任延续",
    "保险金给付限额",
    "给付限额",
    "补偿原则",
    "免赔额",
    "给付比例",
    "健康管理服务",
}
PAGE_MARKER_PATTERN = re.compile(
    r"^(?:=+\s*)?PDF(?:_(?:LAYOUT_)?PAGE|\s+PAGE)[^\n=]*(?:\s*=+)?\s*$",
    flags=re.IGNORECASE | re.MULTILINE,
)
NAMED_CHILD_BENEFIT_PATTERN = re.compile(
    r"(?:\(\d+\)|（\d+）)([^:：;；。]{2,40}?(?:保险金|津贴))[:：]"
)
SHARED_PARENT_CHILD_HEADING_PATTERN = re.compile(r"^(.+?)(\(\d+\).+)$")


def compact(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or "")))


def rows(value):
    return value if isinstance(value, list) else []


def evidence_segments(item):
    if not isinstance(item, dict):
        return []
    segments = [segment for segment in rows(item.get("evidenceSegments")) if isinstance(segment, dict)]
    if segments:
        return segments
    excerpt = item.get("sourceExcerpt")
    if isinstance(excerpt, str) and excerpt.strip():
        return [{"sourcePage": item.get("sourcePage"), "sourceExcerpt": excerpt}]
    return []


def combined_evidence_text(item):
    return compact(" ".join(str(segment.get("sourceExcerpt") or "") for segment in evidence_segments(item)))


def group_evidence_supports_heading(heading, source):
    normalized_heading = compact(heading)
    if normalized_heading in source:
        return True
    match = SHARED_PARENT_CHILD_HEADING_PATTERN.fullmatch(normalized_heading)
    if not match:
        return False
    parent, numbered_child = match.groups()
    parent_index = source.find(parent)
    child_index = source.find(numbered_child)
    return parent_index >= 0 and child_index > parent_index


def evidence_signature(item):
    return tuple(compact(segment.get("sourceExcerpt")) for segment in evidence_segments(item))


def date_is_supported(value, evidence):
    normalized_value = compact(value)
    normalized_evidence = compact(evidence)
    if normalized_value in normalized_evidence:
        return True
    match = re.fullmatch(r"(\d{4})-(\d{1,2})", normalized_value)
    if not match:
        return False
    year, month = match.groups()
    return f"{year}年{int(month)}月" in normalized_evidence


def risk_codes_from_urls(urls):
    codes = set()
    for url in urls:
        codes.update(re.findall(r"[?&]riskCode=([^&#]+)", str(url or ""), flags=re.IGNORECASE))
    return codes


def host_is_allowed(url, allowed_domains):
    host = (urlparse(str(url or "")).hostname or "").lower().rstrip(".")
    return any(host == domain or host.endswith(f".{domain}") for domain in allowed_domains)


def iter_source_excerpts(value, path="artifact"):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key == "sourceExcerpt" and isinstance(child, str) and child.strip():
                yield child_path, child
            yield from iter_source_excerpts(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from iter_source_excerpts(child, f"{path}[{index}]")


def validate_artifact(artifact, source_text=None, source_digest=None, official_domains=None):
    issues = []
    allowed_domains = {
        str(domain or "").lower().strip().lstrip(".")
        for domain in (official_domains or [])
        if str(domain or "").strip()
    }

    def require_text(value, path):
        if not isinstance(value, str) or not value.strip():
            issues.append(f"{path}: required non-empty text")

    def require_evidence(item, path):
        segments = evidence_segments(item)
        if not segments:
            issues.append(f"{path}.sourceExcerpt: exact sourceExcerpt or evidenceSegments is required")
            return
        for index, segment in enumerate(segments):
            segment_path = f"{path}.evidenceSegments[{index}]" if item.get("evidenceSegments") else path
            require_text(segment.get("sourcePage"), f"{segment_path}.sourcePage")
            require_text(segment.get("sourceExcerpt"), f"{segment_path}.sourceExcerpt")
            if any(marker in str(segment.get("sourceExcerpt") or "") for marker in TRUNCATION_MARKERS):
                issues.append(f"{segment_path}.sourceExcerpt: truncated evidence is forbidden")

    def validate_rule_calculation(calculation, rule, path):
        if not isinstance(calculation, dict):
            return
        for key in ("formulaText", "basisKey", "calculationKey", "calculationReason"):
            require_text(calculation.get(key), f"{path}.{key}")
        status = calculation.get("calculationStatus")
        if status not in CALCULATION_STATUSES:
            issues.append(f"{path}.calculationStatus: invalid value")
        rule_source = combined_evidence_text(rule)
        basis_key = str(calculation.get("basisKey") or "")
        branches = rows(calculation.get("branches"))
        if branches and basis_key != "piecewise":
            issues.append(f"{path}.basisKey: shared piecewise rule must use 'piecewise'")
        for token in rows(calculation.get("evidenceTokens")):
            if compact(token) not in rule_source:
                issues.append(f"{path}.evidenceTokens: unsupported token {token!r}")
        for index, branch in enumerate(branches):
            branch_path = f"{path}.branches[{index}]"
            if not isinstance(branch, dict):
                issues.append(f"{branch_path}: required object")
                continue
            for key in ("branchId", "conditionText", "formulaText", "basisKey"):
                require_text(branch.get(key), f"{branch_path}.{key}")
            if branch.get("calculationStatus") not in CALCULATION_STATUSES:
                issues.append(f"{branch_path}.calculationStatus: invalid value")
            if not rows(branch.get("requiredInputs")):
                issues.append(f"{branch_path}.requiredInputs: must not be empty")
            if compact(branch.get("conditionText")) not in rule_source:
                issues.append(f"{branch_path}.conditionText: unsupported by product rule evidence")
            branch_tokens = rows(branch.get("evidenceTokens"))
            if not branch_tokens:
                issues.append(f"{branch_path}.evidenceTokens: required")
            for token in branch_tokens:
                if compact(token) not in rule_source:
                    issues.append(f"{branch_path}.evidenceTokens: unsupported token {token!r}")

    def validate_contract_defined_basis(item, path, inherited_definition=None):
        formula_text = compact(item.get("formulaText"))
        basis_key = str(item.get("basisKey") or "")
        uses_effective_amount = "有效保险金额" in formula_text
        if basis_key == "piecewise":
            return
        if uses_effective_amount and basis_key.startswith(("max_of_", "min_of_")):
            return
        if uses_effective_amount and basis_key != "contract_defined_effective_insured_amount":
            issues.append(
                f"{path}.basisKey: source term 有效保险金额 requires contract_defined_effective_insured_amount"
            )
            return
        if basis_key != "contract_defined_effective_insured_amount":
            return
        definition = item.get("basisDefinition") or inherited_definition
        if not isinstance(definition, dict):
            issues.append(f"{path}.basisDefinition: required for contract-defined basis")
            return
        require_text(definition.get("term"), f"{path}.basisDefinition.term")
        require_evidence(definition, f"{path}.basisDefinition")
        definition_source = combined_evidence_text(definition)
        if compact(definition.get("term")) != "有效保险金额":
            issues.append(f"{path}.basisDefinition.term: expected 有效保险金额")
        if "有效保险金额" not in definition_source:
            issues.append(f"{path}.basisDefinition.sourceExcerpt: missing defined term 有效保险金额")
        evidence_tokens = rows(definition.get("evidenceTokens"))
        if not evidence_tokens:
            issues.append(f"{path}.basisDefinition.evidenceTokens: required")
        for token in evidence_tokens:
            if compact(token) not in definition_source:
                issues.append(f"{path}.basisDefinition.evidenceTokens: unsupported token {token!r}")

    def comparison_kind(item):
        formula = compact(item.get("formulaText")).lower()
        normalized = compact(item.get("normalizedFormula")).lower()
        calculation_key = str(item.get("calculationKey") or "").lower()
        is_maximum = "max(" in formula or "max(" in normalized or "较大者" in formula or calculation_key == "maximum_of_bases"
        is_minimum = "min(" in formula or "min(" in normalized or "较小者" in formula or calculation_key == "minimum_of_bases"
        return is_maximum, is_minimum

    def validate_operand(operand, operand_path, evidence_source, inherited_definition=None):
        if not isinstance(operand, dict):
            issues.append(f"{operand_path}: required object")
            return False
        require_text(operand.get("operandId"), f"{operand_path}.operandId")
        require_text(operand.get("formulaText"), f"{operand_path}.formulaText")
        operand_basis = str(operand.get("basisKey") or "")
        require_text(operand_basis, f"{operand_path}.basisKey")
        if operand_basis in AMBIGUOUS_BASIS_KEYS or operand_basis == "piecewise":
            issues.append(f"{operand_path}.basisKey: exact non-piecewise operand basis required")
        validate_contract_defined_basis(operand, operand_path, inherited_definition)
        if not rows(operand.get("requiredInputs")):
            issues.append(f"{operand_path}.requiredInputs: must not be empty")
        operand_evidence = rows(operand.get("evidenceTokens"))
        if not operand_evidence:
            issues.append(f"{operand_path}.evidenceTokens: required")
        for token in operand_evidence:
            if compact(token) not in evidence_source:
                issues.append(f"{operand_path}.evidenceTokens: unsupported token {token!r}")
        return "cash_value" in operand_basis or "现金价值" in compact(operand.get("formulaText"))

    require_text(artifact.get("company"), "company")
    company = str(artifact.get("company") or "")
    if company and "公司" not in company and "互助社" not in company:
        issues.append("company: use the exact legal insurer name; keep the brand name in displayCompany")
    require_text(artifact.get("productName"), "productName")

    identity = artifact.get("productIdentity")
    if not isinstance(identity, dict):
        issues.append("productIdentity: required object")
        identity = {}
    for key in ("sourceUrl", "sourceDigest"):
        require_text(identity.get(key), f"productIdentity.{key}")
    field_evidence = identity.get("fieldEvidence")
    if not isinstance(field_evidence, dict):
        issues.append("productIdentity.fieldEvidence: required object")
        field_evidence = {}
    for key in ("filingCode", "productCode", "filingDate"):
        value = str(identity.get(key) or "")
        evidence = field_evidence.get(key)
        path = f"productIdentity.fieldEvidence.{key}"
        if not isinstance(evidence, dict):
            issues.append(f"{path}: required object")
            continue
        status = evidence.get("status")
        if status not in IDENTITY_EVIDENCE_STATUSES:
            issues.append(f"{path}.status: invalid value")
            continue
        if status == "not_present_in_source":
            if value:
                issues.append(f"productIdentity.{key}: must be empty when field evidence is not_present_in_source")
            require_text(evidence.get("reviewScope"), f"{path}.reviewScope")
            if "网页" in str(evidence.get("reviewScope") or "") or "查询" in str(evidence.get("reviewScope") or ""):
                if not rows(evidence.get("reviewedSourceUrls")):
                    issues.append(f"{path}.reviewedSourceUrls: required when reviewScope includes official web/query sources")
            continue
        require_text(value, f"productIdentity.{key}")
        require_text(evidence.get("sourceUrl"), f"{path}.sourceUrl")
        require_text(evidence.get("sourcePage"), f"{path}.sourcePage")
        require_text(evidence.get("sourceExcerpt"), f"{path}.sourceExcerpt")
        evidence_text = f"{evidence.get('sourceExcerpt') or ''} {evidence.get('sourceUrl') or ''}"
        supported = date_is_supported(value, evidence_text) if key == "filingDate" else compact(value) in compact(evidence_text)
        if value and not supported:
            issues.append(f"{path}: value is unsupported by its sourceExcerpt or sourceUrl")
    filing_code = str(identity.get("filingCode") or "")
    product_code = str(identity.get("productCode") or "")
    identity_urls = [identity.get("sourceUrl")]
    for evidence in field_evidence.values():
        if isinstance(evidence, dict):
            identity_urls.append(evidence.get("sourceUrl"))
            identity_urls.extend(rows(evidence.get("reviewedSourceUrls")))
    risk_codes = risk_codes_from_urls(identity_urls)
    product_code_evidence = field_evidence.get("productCode") if isinstance(field_evidence.get("productCode"), dict) else {}
    if risk_codes:
        if product_code_evidence.get("status") != "verified" or product_code not in risk_codes:
            issues.append("productIdentity.productCode: official riskCode URL requires the matching verified productCode")
    if ("备案" in filing_code or re.search(r"\d{4}\s*年", filing_code)) and not re.search(r"号\s*$", filing_code):
        issues.append("productIdentity.filingCode: filing date or备案 text must not replace the filing code")
    if filing_code and product_code and compact(filing_code).removesuffix("号") == compact(product_code).removesuffix("号"):
        filing_evidence = field_evidence.get("filingCode") if isinstance(field_evidence.get("filingCode"), dict) else {}
        filing_excerpt = compact(filing_evidence.get("sourceExcerpt"))
        if not any(marker in filing_excerpt for marker in ("备案号", "备案编号", "条款编号", "批准文号")):
            issues.append("productIdentity.filingCode: must not be derived from productCode without explicit official filing-code evidence")
    digest = str(identity.get("sourceDigest") or "")
    if digest and not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
        issues.append("productIdentity.sourceDigest: expected sha256:<64 hex characters>")
    if not allowed_domains:
        issues.append("officialDomains: at least one official insurer domain is required")
    elif not host_is_allowed(identity.get("sourceUrl"), allowed_domains):
        issues.append("productIdentity.sourceUrl: source host is not an approved official insurer domain")
    if not source_digest:
        issues.append("sourceDocument: official source document is required")
    elif digest.lower() != str(source_digest).lower():
        issues.append("productIdentity.sourceDigest: does not match the supplied official source document")
    if not isinstance(source_text, str) or not source_text.strip():
        issues.append("sourceText: extracted official source text is required")
    else:
        normalized_source = compact(PAGE_MARKER_PATTERN.sub("", source_text))
        for excerpt_path, excerpt in iter_source_excerpts(artifact):
            if compact(excerpt) not in normalized_source:
                issues.append(f"{excerpt_path}: must be an exact contiguous excerpt of the official source text")

    for key, evidence in field_evidence.items():
        if not isinstance(evidence, dict):
            continue
        urls = []
        if evidence.get("sourceUrl"):
            urls.append(evidence.get("sourceUrl"))
        urls.extend(rows(evidence.get("reviewedSourceUrls")))
        for url in urls:
            if allowed_domains and not host_is_allowed(url, allowed_domains):
                issues.append(
                    f"productIdentity.fieldEvidence.{key}: evidence URL is not on an approved official insurer domain"
                )

    checklist = rows(artifact.get("officialChecklist"))
    official_groups_present = "officialOptionalGroupChecklist" in artifact
    official_groups = rows(artifact.get("officialOptionalGroupChecklist"))
    responsibilities = rows(artifact.get("responsibilities"))
    product_services = rows(artifact.get("productServices"))
    for index, service in enumerate(product_services):
        path = f"productServices[{index}]"
        if not isinstance(service, dict):
            issues.append(f"{path}: required object")
            continue
        for key in ("serviceId", "title", "customerSummary"):
            require_text(service.get(key), f"{path}.{key}")
        require_evidence(service, path)
    product_rules = rows(artifact.get("productRules"))
    product_rule_by_id = {}
    for index, rule in enumerate(product_rules):
        path = f"productRules[{index}]"
        if not isinstance(rule, dict):
            issues.append(f"{path}: required object")
            continue
        for key in ("ruleId", "title"):
            require_text(rule.get(key), f"{path}.{key}")
        require_evidence(rule, path)
        rule_id = str(rule.get("ruleId") or "")
        if rule_id in product_rule_by_id:
            issues.append(f"{path}.ruleId: duplicate ruleId")
        product_rule_by_id[rule_id] = rule
        validate_rule_calculation(rule.get("calculation"), rule, f"{path}.calculation")
    current_policy_inputs = artifact.get("currentPolicyInputs") if isinstance(artifact.get("currentPolicyInputs"), dict) else {}
    groups = rows(artifact.get("optionalGroups"))
    audit = artifact.get("audit") if isinstance(artifact.get("audit"), dict) else {}
    matrix = rows(audit.get("matrix"))
    if "matrix" not in audit:
        issues.append("audit.matrix: required independent per-responsibility audit rows")

    checklist_ids = [str(item.get("responsibilityId") or "") for item in checklist if isinstance(item, dict)]
    responsibility_ids = [str(item.get("responsibilityId") or "") for item in responsibilities if isinstance(item, dict)]
    matrix_ids = [str(item.get("responsibilityId") or "") for item in matrix if isinstance(item, dict)]
    for label, ids in (
        ("officialChecklist", checklist_ids),
        ("responsibilities", responsibility_ids),
        ("audit.matrix", matrix_ids),
    ):
        if not ids:
            issues.append(f"{label}: must not be empty")
        if "" in ids:
            issues.append(f"{label}: responsibilityId is required")
        if len(ids) != len(set(ids)):
            issues.append(f"{label}: duplicate responsibilityId")
    if set(checklist_ids) != set(responsibility_ids):
        issues.append("responsibilityId sets: officialChecklist must equal responsibilities")
    if set(matrix_ids) != set(responsibility_ids):
        issues.append("responsibilityId sets: audit.matrix must equal responsibilities")
    for index, item in enumerate(checklist):
        if not isinstance(item, dict):
            continue
        require_text(item.get("officialHeading"), f"officialChecklist[{index}].officialHeading")
        require_evidence(item, f"officialChecklist[{index}]")

    checklist_by_id = {
        str(item.get("responsibilityId") or ""): item
        for item in checklist
        if isinstance(item, dict)
    }

    if groups and not official_groups_present:
        issues.append("officialOptionalGroupChecklist: required independent optional-group audit")

    official_group_by_id = {}
    official_group_children = []
    for index, group in enumerate(official_groups):
        path = f"officialOptionalGroupChecklist[{index}]"
        if not isinstance(group, dict):
            issues.append(f"{path}: required object")
            continue
        group_id = str(group.get("groupId") or "")
        require_text(group_id, f"{path}.groupId")
        require_text(group.get("officialLabel"), f"{path}.officialLabel")
        require_evidence(group, path)
        if group_id in official_group_by_id:
            issues.append(f"{path}.groupId: duplicate groupId")
        official_group_by_id[group_id] = group
        child_ids = [str(value) for value in rows(group.get("childResponsibilityIds"))]
        if not child_ids:
            issues.append(f"{path}.childResponsibilityIds: must not be empty")
        if len(child_ids) != len(set(child_ids)):
            issues.append(f"{path}.childResponsibilityIds: duplicate responsibilityId")
        official_group_children.extend(child_ids)
        source = combined_evidence_text(group)
        for child_id in child_ids:
            child = checklist_by_id.get(child_id)
            if not child:
                issues.append(f"{path}.childResponsibilityIds: unknown responsibilityId {child_id!r}")
                continue
            heading = child.get("officialHeading")
            if compact(heading) and not group_evidence_supports_heading(heading, source):
                issues.append(f"{path}.sourceExcerpt: missing child heading {child.get('officialHeading')!r}")
    if len(official_group_children) != len(set(official_group_children)):
        issues.append("officialOptionalGroupChecklist: a responsibility may belong to only one optional group")

    group_by_id = {}
    grouped_children = set()
    for index, group in enumerate(groups):
        path = f"optionalGroups[{index}]"
        if not isinstance(group, dict):
            issues.append(f"{path}: required object")
            continue
        group_id = str(group.get("groupId") or "")
        require_text(group_id, f"{path}.groupId")
        if group_id in group_by_id:
            issues.append(f"{path}.groupId: duplicate groupId")
        group_by_id[group_id] = group
        if group.get("selectionStatus") not in SELECTION_STATUSES:
            issues.append(f"{path}.selectionStatus: invalid value")
        require_evidence(group, path)
        child_ids = [str(value) for value in rows(group.get("childResponsibilityIds"))]
        if not child_ids:
            issues.append(f"{path}.childResponsibilityIds: must not be empty")
        if len(child_ids) != len(set(child_ids)):
            issues.append(f"{path}.childResponsibilityIds: duplicate responsibilityId")
        grouped_children.update(child_ids)

    generated_group_mapping = {
        group_id: tuple(sorted(str(value) for value in rows(group.get("childResponsibilityIds"))))
        for group_id, group in group_by_id.items()
    }
    official_group_mapping = {
        group_id: tuple(sorted(str(value) for value in rows(group.get("childResponsibilityIds"))))
        for group_id, group in official_group_by_id.items()
    }
    if generated_group_mapping != official_group_mapping:
        issues.append("optional group mapping: optionalGroups must equal officialOptionalGroupChecklist")
    for group_id in set(generated_group_mapping) & set(official_group_mapping):
        generated_group = group_by_id[group_id]
        official_group = official_group_by_id[group_id]
        if evidence_signature(generated_group) != evidence_signature(official_group):
            issues.append(f"optionalGroups[{group_id}].sourceExcerpt: must equal independent official group evidence")

    actual_grouped_children = set()
    staged_parent_entries = []
    for index, responsibility in enumerate(responsibilities):
        path = f"responsibilities[{index}]"
        if not isinstance(responsibility, dict):
            issues.append(f"{path}: required object")
            continue
        responsibility_id = str(responsibility.get("responsibilityId") or "")
        for key in ("liability", "triggerCondition", "insurerObligation"):
            require_text(responsibility.get(key), f"{path}.{key}")
        require_evidence(responsibility, path)
        liability = compact(responsibility.get("liability"))
        if liability in {compact(value) for value in NON_RESPONSIBILITY_HEADINGS}:
            issues.append(f"{path}.liability: {responsibility.get('liability')!r} is a rule or service, not an insurance responsibility")
        for rule_ref in rows(responsibility.get("ruleRefs")):
            if str(rule_ref) not in product_rule_by_id:
                issues.append(f"{path}.ruleRefs: unknown productRules ruleId {rule_ref!r}")
        responsibility_kind = responsibility.get("responsibilityKind", "benefit")
        coverage_aggregation = responsibility.get("coverageAggregation", "include")
        if responsibility_kind not in RESPONSIBILITY_KINDS:
            issues.append(f"{path}.responsibilityKind: invalid value")
        if "豁免" in str(responsibility.get("liability") or ""):
            if "responsibilityKind" in responsibility and responsibility_kind != "waiver":
                issues.append(f"{path}.responsibilityKind: premium-waiver responsibility must use 'waiver'")
        if coverage_aggregation not in COVERAGE_AGGREGATION_STATES:
            issues.append(f"{path}.coverageAggregation: invalid value")
        if responsibility_kind == "waiting_period_refund" and coverage_aggregation != "exclude":
            issues.append(f"{path}.coverageAggregation: waiting-period refund must be excluded from coverage totals")
        liability_text = compact(responsibility.get("liability"))
        waiting_refund_text = compact(f"{responsibility.get('liability') or ''}{combined_evidence_text(responsibility)}")
        if (
            "等待期" in waiting_refund_text
            and any(token in liability_text for token in ("退还", "返还"))
        ):
            if responsibility_kind != "waiting_period_refund":
                issues.append(f"{path}.responsibilityKind: waiting-period refund must be classified explicitly")
            if coverage_aggregation != "exclude":
                issues.append(f"{path}.coverageAggregation: waiting-period refund must be excluded from coverage totals")
        checklist_heading = compact(checklist_by_id.get(responsibility_id, {}).get("officialHeading"))
        if re.fullmatch(r"第[一二三四五六七八九十\d]+次重度疾病保险金", checklist_heading):
            parent_id = str(responsibility.get("parentResponsibilityId") or "")
            staged_parent_entries.append((path, parent_id))
        selection_status = responsibility.get("selectionStatus")
        if selection_status not in SELECTION_STATUSES:
            issues.append(f"{path}.selectionStatus: invalid value")
        group_id = responsibility.get("groupId")
        if group_id:
            actual_grouped_children.add(responsibility_id)
            group = group_by_id.get(str(group_id))
            if not group:
                issues.append(f"{path}.groupId: missing optionalGroups entry")
            elif group.get("selectionStatus") != selection_status:
                issues.append(f"{path}.selectionStatus: must equal optional group selectionStatus")
            elif responsibility_id not in rows(group.get("childResponsibilityIds")):
                issues.append(f"{path}.groupId: responsibility missing from optional group childResponsibilityIds")
        elif selection_status != "included":
            issues.append(f"{path}.selectionStatus: non-optional responsibility must be included")

        card = responsibility.get("card") if isinstance(responsibility.get("card"), dict) else {}
        title = str(card.get("title") or "")
        require_text(title, f"{path}.card.title")
        if compact(title).replace("(可选)", "").replace("（可选）", "") in {compact(value) for value in GENERIC_CARD_TITLES}:
            issues.append(f"{path}.card.title: generic group heading is not a responsibility card")
        require_text(card.get("customerSummary"), f"{path}.card.customerSummary")
        require_text(card.get("benefitExplanation"), f"{path}.card.benefitExplanation")

        source = combined_evidence_text(responsibility)
        named_children = {
            compact(match.group(1))
            for match in NAMED_CHILD_BENEFIT_PATTERN.finditer(" ".join(str(s.get("sourceExcerpt") or "") for s in evidence_segments(responsibility)))
        }
        if len(named_children) >= 2 and liability not in named_children:
            issues.append(
                f"{path}: independently named child benefits must be split into separate responsibilities: "
                f"{sorted(named_children)!r}"
            )
        card_text = compact(f"{card.get('customerSummary') or ''}{card.get('benefitExplanation') or ''}")
        customer_facing_text = compact(
            f"{card_text}{''.join(str(value) for value in rows(responsibility.get('importantLimits')))}"
        )
        cumulative_limit = re.search(r"累计(?:给付)?(?:次数)?(?:达到|以)?([一二三四五六七八九十\d]+)次", source)
        if cumulative_limit and ("累计" not in card_text or cumulative_limit.group(1) not in card_text):
            issues.append(f"{path}.card: cumulative payment count must be preserved exactly")
        for claim in UNSUPPORTED_CONTINUATION_CLAIMS:
            if claim in customer_facing_text and claim not in source:
                issues.append(f"{path}.card: unsupported continuation claim {claim!r}")
        if "不重复" in card_text and "不重复" not in source:
            issues.append(f"{path}.card: unsupported non-duplication claim")
        indicators = rows(responsibility.get("indicators"))
        if not indicators:
            issues.append(f"{path}.indicators: explicit indicator decision required")
        for indicator_index, indicator in enumerate(indicators):
            indicator_path = f"{path}.indicators[{indicator_index}]"
            if not isinstance(indicator, dict):
                issues.append(f"{indicator_path}: required object")
                continue
            require_text(indicator.get("indicatorName"), f"{indicator_path}.indicatorName")
            require_text(indicator.get("calculationReason"), f"{indicator_path}.calculationReason")
            indicator_source_raw = str(indicator.get("sourceExcerpt") or "")
            indicator_source = combined_evidence_text(indicator) or source
            if indicator_source_raw or rows(indicator.get("evidenceSegments")):
                require_evidence(indicator, indicator_path)
            for rule_ref in rows(indicator.get("ruleRefs")):
                if str(rule_ref) not in product_rule_by_id:
                    issues.append(f"{indicator_path}.ruleRefs: unknown productRules ruleId {rule_ref!r}")
            status = indicator.get("calculationStatus")
            if status not in CALCULATION_STATUSES:
                issues.append(f"{indicator_path}.calculationStatus: invalid value")
            required_inputs = [str(value) for value in rows(indicator.get("requiredInputs"))]
            if status == "calculable":
                missing_inputs = [key for key in required_inputs if key not in current_policy_inputs]
                if missing_inputs:
                    issues.append(
                        f"{indicator_path}.calculationStatus: calculable requires supplied currentPolicyInputs {missing_inputs!r}"
                    )
                if indicator.get("calculationEligible") is not True:
                    issues.append(f"{indicator_path}.calculationEligible: calculable indicator must be true")
            elif indicator.get("calculationEligible") is True:
                issues.append(f"{indicator_path}.calculationEligible: non-calculable indicator must not be true")
            basis_key = str(indicator.get("basisKey") or "")
            if status != "not_quantitative":
                require_text(basis_key, f"{indicator_path}.basisKey")
            if basis_key in AMBIGUOUS_BASIS_KEYS:
                issues.append(f"{indicator_path}.basisKey: ambiguous basis alias {basis_key!r} is forbidden")
            validate_contract_defined_basis(indicator, indicator_path)
            normalized_formula = str(indicator.get("normalizedFormula") or "")
            branches = rows(indicator.get("branches"))
            operands = rows(indicator.get("operands"))
            compact_formula = compact(indicator.get("formulaText"))
            normalized_basis_text = " ".join((
                basis_key,
                normalized_formula,
                str(indicator.get("calculationKey") or ""),
                " ".join(required_inputs),
            )).lower()
            if "实际交纳的保险费" in compact_formula and "total_paid_premium" in normalized_basis_text:
                issues.append(
                    f"{indicator_path}.basisKey: 实际交纳的保险费 requires actual_paid_premium, not total_paid_premium"
                )
            if compact_formula in {"实际交纳的保险费", "本合同实际交纳的保险费"} and basis_key != "actual_paid_premium":
                issues.append(f"{indicator_path}.basisKey: exact paid-premium term requires actual_paid_premium")
            if responsibility_kind == "waiver":
                waiver_indicator_text = compact(
                    f"{indicator.get('formulaText') or ''}{normalized_formula}"
                    f"{basis_key}{indicator.get('calculationKey') or ''}"
                ).lower()
                source_has_discounting = any(
                    term in indicator_source.lower() for term in ("现值", "折现", "presentvalue", "discount")
                )
                indicator_has_discounting = any(
                    term in waiver_indicator_text
                    for term in ("现值", "折现", "present_value", "presentvalue", "discount")
                )
                if indicator_has_discounting and not source_has_discounting:
                    issues.append(
                        f"{indicator_path}: waiver present-value/discounting semantics are unsupported by sourceExcerpt"
                    )
            is_piecewise = "if(" in normalized_formula.replace(" ", "").lower()
            is_piecewise = is_piecewise or normalized_formula.strip().lower().startswith("if ")
            is_piecewise = is_piecewise or normalized_formula.replace(" ", "").lower().startswith("piecewise(")
            is_piecewise = is_piecewise or ("之前" in compact_formula and "之后" in compact_formula)
            is_piecewise = is_piecewise or str(indicator.get("calculationKey") or "").lower() in {
                "piecewise",
                "branch_based",
            }
            is_piecewise = is_piecewise or (basis_key == "piecewise" and bool(branches))
            is_maximum, is_minimum = comparison_kind(indicator)
            is_comparison = (is_maximum or is_minimum) and not is_piecewise
            if is_piecewise and not branches:
                issues.append(f"{indicator_path}.branches: piecewise formula requires explicit branch statuses")
            if is_piecewise and basis_key != "piecewise":
                issues.append(f"{indicator_path}.basisKey: piecewise formula must use 'piecewise' and declare each branch basis")
            if is_piecewise and operands:
                issues.append(
                    f"{indicator_path}.operands: piecewise formula must store comparison operands inside each affected branch"
                )
            if branches and not is_piecewise:
                issues.append(f"{indicator_path}.branches: branches are only for condition-based piecewise formulas; comparisons use operands")
            expected_comparison_prefix = "max_of_" if is_maximum else "min_of_"
            if is_comparison and not basis_key.startswith(expected_comparison_prefix):
                issues.append(f"{indicator_path}.basisKey: comparison formula requires an exact {expected_comparison_prefix} composite basis")
            if is_comparison and len(operands) < 2:
                issues.append(f"{indicator_path}.operands: comparison formula requires at least two explicit operands")
            if operands and not is_comparison:
                issues.append(f"{indicator_path}.operands: operands are only for max/min comparison formulas")
            for branch_index, branch in enumerate(branches):
                branch_path = f"{indicator_path}.branches[{branch_index}]"
                if not isinstance(branch, dict):
                    issues.append(f"{branch_path}: required object")
                    continue
                require_text(branch.get("branchId"), f"{branch_path}.branchId")
                require_text(branch.get("conditionText"), f"{branch_path}.conditionText")
                require_text(branch.get("formulaText"), f"{branch_path}.formulaText")
                branch_basis = str(branch.get("basisKey") or "")
                require_text(branch_basis, f"{branch_path}.basisKey")
                if branch_basis in AMBIGUOUS_BASIS_KEYS:
                    issues.append(f"{branch_path}.basisKey: ambiguous basis alias {branch_basis!r} is forbidden")
                validate_contract_defined_basis(branch, branch_path, indicator.get("basisDefinition"))
                if branch.get("calculationStatus") not in CALCULATION_STATUSES:
                    issues.append(f"{branch_path}.calculationStatus: invalid value")
                if not rows(branch.get("requiredInputs")):
                    issues.append(f"{branch_path}.requiredInputs: must not be empty")
                condition_text = compact(branch.get("conditionText"))
                if condition_text and condition_text not in indicator_source:
                    issues.append(f"{branch_path}.conditionText: unsupported by responsibility sourceExcerpt")
                branch_evidence = rows(branch.get("evidenceTokens"))
                if not branch_evidence:
                    issues.append(f"{branch_path}.evidenceTokens: required")
                for token in branch_evidence:
                    if compact(token) not in indicator_source:
                        issues.append(f"{branch_path}.evidenceTokens: unsupported token {token!r}")
                branch_operands = rows(branch.get("operands"))
                branch_is_maximum, branch_is_minimum = comparison_kind(branch)
                branch_is_comparison = branch_is_maximum or branch_is_minimum
                expected_branch_prefix = "max_of_" if branch_is_maximum else "min_of_"
                if branch_is_comparison and not branch_basis.startswith(expected_branch_prefix):
                    issues.append(
                        f"{branch_path}.basisKey: comparison branch requires an exact {expected_branch_prefix} composite basis"
                    )
                if branch_is_comparison and len(branch_operands) < 2:
                    issues.append(f"{branch_path}.operands: comparison branch requires at least two explicit operands")
                if branch_operands and not branch_is_comparison:
                    issues.append(f"{branch_path}.operands: operands are only for max/min comparison formulas")
                branch_uses_cash_value = False
                for operand_index, operand in enumerate(branch_operands):
                    branch_uses_cash_value = validate_operand(
                        operand,
                        f"{branch_path}.operands[{operand_index}]",
                        indicator_source,
                        branch.get("basisDefinition") or indicator.get("basisDefinition"),
                    ) or branch_uses_cash_value
                if "有效保险金额" in compact(branch.get("formulaText")) and branch_is_comparison:
                    if not any(
                        str(operand.get("basisKey") or "") == "contract_defined_effective_insured_amount"
                        for operand in branch_operands if isinstance(operand, dict)
                    ):
                        issues.append(f"{branch_path}.operands: 有效保险金额 requires a contract-defined operand")
                cash_value_branch = branch_uses_cash_value or "cash_value" in branch_basis or "现金价值" in compact(branch.get("formulaText"))
                if cash_value_branch and branch.get("calculationStatus") != "needs_table":
                    issues.append(f"{branch_path}: cash value branch requires needs_table")
            comparison_uses_cash_value = False
            for operand_index, operand in enumerate(operands):
                operand_path = f"{indicator_path}.operands[{operand_index}]"
                comparison_uses_cash_value = validate_operand(
                    operand,
                    operand_path,
                    indicator_source,
                    indicator.get("basisDefinition"),
                ) or comparison_uses_cash_value
            if "有效保险金额" in compact_formula and is_comparison:
                if not any(
                    str(operand.get("basisKey") or "") == "contract_defined_effective_insured_amount"
                    for operand in operands if isinstance(operand, dict)
                ):
                    issues.append(f"{indicator_path}.operands: 有效保险金额 requires a contract-defined operand")
            if comparison_uses_cash_value and status != "needs_table":
                issues.append(f"{indicator_path}.calculationStatus: comparison containing cash value requires needs_table")
            evidence_tokens = rows(indicator.get("evidenceTokens"))
            if status != "not_quantitative" and not evidence_tokens:
                issues.append(f"{indicator_path}.evidenceTokens: required for quantitative indicator")
            for token in evidence_tokens:
                if compact(token) not in indicator_source:
                    issues.append(f"{indicator_path}.evidenceTokens: unsupported token {token!r}")

    if len(staged_parent_entries) > 1:
        for path, parent_id in staged_parent_entries:
            require_text(parent_id, f"{path}.parentResponsibilityId")
        if all(parent_id for _, parent_id in staged_parent_entries):
            if len({parent_id for _, parent_id in staged_parent_entries}) != 1:
                issues.append("parentResponsibilityId: staged severe-disease benefits must share one conceptual parent group")

    if grouped_children != actual_grouped_children:
        issues.append("optionalGroups.childResponsibilityIds: must equal responsibilities grouped by groupId")

    expected_count = len(responsibilities)
    for key in ("officialChecklistCount", "inventoryCount", "cardCount", "indicatorDecisionCount"):
        if audit.get(key) != expected_count:
            issues.append(f"audit.{key}: expected {expected_count}")
    for index, row in enumerate(matrix):
        if not isinstance(row, dict):
            continue
        for key in ("inventory", "card", "indicatorDecision", "formulaEvidence", "selectionEvidence", "productVersion", "result"):
            if row.get(key) != "pass":
                issues.append(f"audit.matrix[{index}].{key}: must be pass")
        if rows(row.get("issues")):
            issues.append(f"audit.matrix[{index}].issues: must be empty")
    if rows(audit.get("issues")):
        issues.append("audit.issues: must be empty for approved artifact")
    if audit.get("status") != "approved":
        issues.append("audit.status: validator accepts only approved artifacts")

    return issues


def main(argv=None):
    parser = argparse.ArgumentParser(description="Validate an OCR insurance responsibility artifact")
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
    print(json.dumps({"ok": True, "status": "approved", "responsibilityCount": len(artifact["responsibilities"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
