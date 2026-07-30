---
name: ocr-insurance-responsibility-inventory
description: Extract a complete, evidence-backed insurance-product responsibility inventory and product overview from exact-version official clauses or official insurer materials. Use before creating responsibility cards, mapping indicators, repairing incomplete products, reviewing optional responsibilities, or deciding whether existing OCR_insurance responsibility data is complete.
---

# Insurance Responsibility Inventory

Build the source-of-truth responsibility list for exactly one product. Do not create cards, indicators, or database writes in this stage.

## Required Input

- Exact legal insurer name, optional brand display name, and product name.
- Product version evidence when available: filing code, clause title, effective date, sales material version, or PDF hash.
- Official insurer PDF/page or regulator disclosure tied to that exact product.
- Existing database rows only as comparison material, never as proof of completeness.

## Source Rules

- Prefer exact-version policy clauses. Use official brochures only to supplement plain-language overview.
- Reject third-party summaries, search snippets, table-of-contents fragments, claim procedures, and similarly named product versions.
- Record `sourceUrl`, `sourceTitle`, `sourceDigest`, access time, page/section, and an exact `sourceExcerpt` for every accepted responsibility.
- Record field-level official evidence for `filingCode`, `productCode`, and `filingDate`. If a reviewed official source does not contain one of these fields, keep its value empty and mark it `not_present_in_source`; never infer it from another identifier.
- Preserve reviewed official query URLs. A URL parameter such as `riskCode=00936000` is official product-code evidence and must not be discarded while declaring the product code absent.
- If exact-version evidence is uncertain, stop with `product_version_unresolved`. Do not silently combine versions.

## Inventory Workflow

1. Lock the exact product identity and source set.
2. Locate the complete responsibility section, including all subsections and attached or optional responsibility sections.
3. Enumerate every concrete insurer obligation: payment, reimbursement, annuity, survival benefit, maturity benefit, waiver, medical service, or other benefit.
4. Separate concrete responsibilities from grouping labels.
   - `可选责任一`, `可选责任二`, `基本责任`, and similar headings are groups, not responsibility names.
   - Store groups in `optionalGroups`; store their concrete child benefits in `responsibilities`.
   - Preserve selectable package boundaries exactly. Two numbered options remain two groups even when one option contains multiple child benefits.
   - Capture one group-level excerpt containing the option label and every child heading; child excerpts alone do not prove package membership.
   - Split staged payments when each stage has its own numbered heading, trigger, and payment obligation. Link those sibling stages with the same `parentResponsibilityId` rather than merging them into one card.
   - Keep mere formula branches inside one responsibility when they do not have independent source headings and obligations.
   - Retain a waiting-period refund only as `responsibilityKind: waiting_period_refund` with `coverageAggregation: exclude`; it is displayed but not counted as protection coverage.
   - Mark every premium-waiver obligation as `responsibilityKind: waiver`.
5. Preserve selection evidence for each optional child: `included`, `not_included`, or `unknown`.
6. Produce a product overview from the official material: product type, primary customer need, main protection or savings function, and important structural limits.
7. Compare the extracted list with existing cards and indicators only after the official inventory is complete.

## Responsibility Acceptance Gate

Accept a responsibility only when its evidence contains both:

- a covered event, date, age, condition, expense, survival state, or waiver trigger; and
- the insurer obligation or benefit provided.

Reject exclusions, definitions without an obligation, cash-value descriptions, isolated headings, underwriting conditions, and claim-document instructions.

Do not use `…` or `...` to shorten accepted evidence. Prefer one exact `sourceExcerpt`; when layout or separate clauses make that impossible, use ordered `evidenceSegments`, each copied exactly from the official source. Together they must prove the trigger, obligation, formula, cumulative count, and termination effect.

Store a deductible, reimbursement ratio, annual limit, compensation principle, or other rule shared by multiple responsibilities once in `productRules`. Link affected responsibilities through stable `ruleRefs`; do not turn the rule into a responsibility or duplicate its calculation branches.

## Output Contract

Produce one artifact with:

```json
{
  "company": "",
  "displayCompany": "",
  "productName": "",
  "productIdentity": {
    "filingCode": "",
    "productCode": "",
    "filingDate": "",
    "sourceDigest": "",
    "fieldEvidence": {
      "filingCode": { "status": "not_present_in_source", "reviewScope": "官方条款PDF全部页面" },
      "productCode": { "status": "verified", "sourceUrl": "", "sourcePage": "", "sourceExcerpt": "" },
      "filingDate": { "status": "not_present_in_source", "reviewScope": "官方条款PDF全部页面" }
    }
  },
  "productOverview": {
    "productType": "",
    "primaryPurpose": "",
    "mainFunctions": [],
    "importantLimits": []
  },
  "optionalGroups": [
    {
      "groupId": "optional_1",
      "label": "可选责任一",
      "selectionStatus": "unknown",
      "childResponsibilityIds": [],
      "sourcePage": "",
      "sourceExcerpt": ""
    }
  ],
  "responsibilities": [
    {
      "responsibilityId": "stable-source-derived-id",
      "liability": "具体保险金或服务名称",
      "groupId": null,
      "parentResponsibilityId": null,
      "responsibilityKind": "benefit",
      "coverageAggregation": "include",
      "selectionStatus": "included",
      "triggerCondition": "",
      "insurerObligation": "",
      "importantLimits": [],
      "sourceUrl": "",
      "sourceTitle": "",
      "sourcePage": "",
      "sourceExcerpt": ""
    }
  ],
  "rejectedFragments": [],
  "blockers": []
}
```

## Completion Gate

Mark the inventory complete only when:

- every responsibility subsection in the official source is accounted for as accepted or explicitly rejected;
- optional group children are enumerated instead of represented only by group headings;
- every selectable package has its own source-backed boundary and child list;
- every accepted item has exact source evidence;
- the source matches the exact product version; and
- a second pass over the responsibility section finds no unaccounted benefit heading.

Do not use existing card count or indicator count as evidence that the inventory is complete.
