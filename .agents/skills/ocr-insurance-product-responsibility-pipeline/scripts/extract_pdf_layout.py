#!/usr/bin/env python3
"""Extract ordinary PDF text plus layout-preserving table evidence."""

import argparse
import json
import re
from pathlib import Path

import pdfplumber
from pypdf import PdfReader


TABLE_TERMS = (
    "保险计划", "给付比例", "赔付比例", "累计限额", "年度限额",
    "免赔额", "给付次数", "保险金额", "医疗机构",
)


def clean_layout(value):
    lines = [line.rstrip() for line in str(value or "").splitlines()]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def table_like(value):
    compact = re.sub(r"\s+", "", str(value or ""))
    return sum(term in compact for term in TABLE_TERMS) >= 2


def extract(pdf_path):
    reader = PdfReader(str(pdf_path))
    output = []
    report_pages = []
    with pdfplumber.open(str(pdf_path)) as document:
        for index, reader_page in enumerate(reader.pages, start=1):
            ordinary = reader_page.extract_text() or ""
            layout = ""
            if index <= len(document.pages):
                layout = clean_layout(document.pages[index - 1].extract_text(
                    layout=True,
                    x_density=7.25,
                    y_density=13,
                ))
            page_text = f"PDF_PAGE_{index}\n{ordinary}"
            if layout:
                page_text += f"\n\nPDF_LAYOUT_PAGE_{index}\n{layout}"
            output.append(page_text)
            report_pages.append({
                "page": index,
                "layoutAvailable": bool(layout),
                "tableLike": table_like(layout or ordinary),
                "ordinaryCharacters": len(ordinary),
                "layoutCharacters": len(layout),
            })
    continuation_ranges = []
    range_start = None
    for page in report_pages:
        if page["tableLike"] and range_start is None:
            range_start = page["page"]
        if not page["tableLike"] and range_start is not None:
            if page["page"] - range_start > 1:
                continuation_ranges.append({"startPage": range_start, "endPage": page["page"] - 1})
            range_start = None
    if range_start is not None and report_pages[-1]["page"] - range_start >= 1:
        continuation_ranges.append({"startPage": range_start, "endPage": report_pages[-1]["page"]})
    return "\n\n".join(output), {
        "extractor": "pdfplumber-layout-plus-pypdf",
        "pages": report_pages,
        "tablePages": [page["page"] for page in report_pages if page["tableLike"]],
        "crossPageTableRanges": continuation_ranges,
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--output-text", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args(argv)
    source_text, report = extract(args.pdf)
    if "保险责任" not in source_text:
        raise ValueError("extracted PDF text does not contain 保险责任")
    args.output_text.parent.mkdir(parents=True, exist_ok=True)
    args.output_text.write_text(source_text, encoding="utf-8")
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
