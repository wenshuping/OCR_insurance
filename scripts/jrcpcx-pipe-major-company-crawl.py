#!/usr/bin/env python3
import argparse
import asyncio
import importlib.util
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CRAWLER_PATH = PROJECT_ROOT / "server" / "scrapling-policy-crawler.py"
SOURCE = "https://www.jrcpcx.cn/#/query"
SOURCE_LEVEL = "regulatory_industry_index"
SUPPORTED_PAGE_SIZES = (10, 20, 50)
USABLE_QUERY_FIELDS = ("deptName", "company", "queryDeptName", "productName", "industryCode")
BROWSER_ARGS = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--disable-blink-features=AutomationControlled",
]


def trim(value: Any) -> str:
    return str(value or "").strip()


def generated_at() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def path_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def resolve_path(value: str) -> str:
    return str(Path(value).expanduser().resolve())


def parse_args() -> argparse.Namespace:
    stamp = path_stamp()
    parser = argparse.ArgumentParser(
        description="Run a visible JRCPCX major-company crawl with checkpointed JSON output."
    )
    parser.add_argument("--query-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--pdf-archive-dir",
        default=f".runtime/policy-material-pdfs/jrcpcx-major-company-gap-{stamp}",
    )
    parser.add_argument(
        "--user-data-dir",
        default=f".runtime/chrome-jrcpcx-major-company-gap-{stamp}",
    )
    parser.add_argument("--wait-ms", type=int, default=20000)
    parser.add_argument("--page-size", type=int, choices=SUPPORTED_PAGE_SIZES, default=50)
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--max-detail-products", type=int, default=180)
    parser.add_argument("--db-path", default=".runtime/policy-ocr.sqlite")
    parser.add_argument("--skip-existing", dest="skip_existing", action="store_true", default=True)
    parser.add_argument("--no-skip-existing", dest="skip_existing", action="store_false")
    parser.add_argument("--headless", action="store_true", default=False)
    parser.add_argument("--pdf-only", dest="pdf_only", action="store_true", default=False)
    args = parser.parse_args()
    args.query_file = resolve_path(args.query_file)
    args.output = resolve_path(args.output)
    args.pdf_archive_dir = resolve_path(args.pdf_archive_dir)
    args.user_data_dir = resolve_path(args.user_data_dir)
    args.db_path = resolve_path(args.db_path)
    args.wait_ms = max(1, args.wait_ms)
    args.max_pages = max(1, args.max_pages)
    args.max_detail_products = max(0, args.max_detail_products)
    return args


class InputError(Exception):
    def __init__(self, code: str, message: str, **summary: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.summary = summary


def has_usable_query_filter(query: dict[str, Any]) -> bool:
    return any(trim(query.get(field)) for field in USABLE_QUERY_FIELDS)


def normalize_query(query: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(query)
    if not trim(normalized.get("deptName")) and not trim(normalized.get("company")):
        query_dept_name = trim(normalized.get("queryDeptName"))
        if query_dept_name:
            normalized["deptName"] = query_dept_name
    return normalized


def load_queries(query_file: str) -> list[dict[str, Any]]:
    with open(query_file, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    queries = data if isinstance(data, list) else data.get("queries") if isinstance(data, dict) else None
    if not isinstance(queries, list):
        raise InputError(
            "INVALID_QUERY",
            "Query file must contain a JSON array or an object with a queries array.",
            queryFile=query_file,
        )
    if not queries:
        raise InputError("EMPTY_QUERY_FILE", "Query file contains no queries.", queryFile=query_file)
    normalized: list[dict[str, Any]] = []
    for index, query in enumerate(queries):
        if not isinstance(query, dict):
            raise InputError(
                "INVALID_QUERY",
                f"Query at index {index} must be an object.",
                queryFile=query_file,
                index=index,
            )
        if not has_usable_query_filter(query):
            raise InputError(
                "INVALID_QUERY",
                f"Query at index {index} has no usable filter.",
                queryFile=query_file,
                index=index,
                usableFields=list(USABLE_QUERY_FIELDS),
            )
        normalized.append(normalize_query(query))
    return normalized


def load_crawler_module() -> Any:
    spec = importlib.util.spec_from_file_location("scrapling_policy_crawler", CRAWLER_PATH)
    if not spec or not spec.loader:
        raise RuntimeError(f"failed to load crawler module spec from {CRAWLER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_known_clause_urls(db_path: str, crawler: Any, enabled: bool) -> set[str]:
    if not enabled or not os.path.exists(db_path):
        return set()
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT url FROM knowledge_records WHERE TRIM(COALESCE(url, '')) <> ''"
        ).fetchall()
    finally:
        connection.close()
    normalized: set[str] = set()
    for (url,) in rows:
        value = crawler.normalize_jrcpcx_clause_url(trim(url))
        if value:
            normalized.add(value)
    return normalized


def refresh_counts(state: dict[str, Any]) -> None:
    records = state.get("records") if isinstance(state.get("records"), list) else []
    products = state.get("products") if isinstance(state.get("products"), list) else []
    detail_results = state.get("detailResults") if isinstance(state.get("detailResults"), list) else []
    state["productCount"] = len(products)
    state["recordCount"] = len(records)
    state["responsibilityCount"] = sum(1 for record in records if trim(record.get("pageText")))
    state["pdfDownloadSkippedExistingCount"] = sum(
        1 for result in detail_results if isinstance(result, dict) and result.get("skippedExisting")
    )
    state["detailFailureCount"] = sum(
        1 for result in detail_results if isinstance(result, dict) and result.get("ok") is False
    )


def write_checkpoint(output_path: str, state: dict[str, Any]) -> None:
    refresh_counts(state)
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = Path(f"{output_path}.tmp")
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp_path, target)


def query_metadata(result: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in result.items() if key != "products"}


def detail_metadata(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {
            "ok": False,
            "code": "JRCPCX_DETAIL_INVALID_RESULT",
            "message": "Detail fetch returned a non-object result.",
        }
    return {key: value for key, value in result.items() if key != "record"}


def is_life_ins_detail_url(value: str) -> bool:
    return "/lifeIns/" in trim(value)


def filter_query_products(query: dict[str, Any], products: list[dict[str, Any]]) -> list[dict[str, Any]]:
    product_type_label = trim(query.get("productTypeLabel"))
    if product_type_label != "人身保险类":
        return products
    return [
        product
        for product in products
        if isinstance(product, dict) and is_life_ins_detail_url(product.get("detailUrl"))
    ]


def build_initial_state(args: argparse.Namespace, query_count: int) -> dict[str, Any]:
    return {
        "ok": True,
        "partial": False,
        "code": "",
        "message": "",
        "generatedAt": generated_at(),
        "source": SOURCE,
        "sourceLevel": SOURCE_LEVEL,
        "queryFile": args.query_file,
        "queryCount": query_count,
        "pageSize": args.page_size,
        "maxPages": args.max_pages,
        "productCount": 0,
        "recordCount": 0,
        "responsibilityCount": 0,
        "detailFailureCount": 0,
        "pdfArchiveDir": args.pdf_archive_dir,
        "dbPath": args.db_path,
        "skipExisting": bool(args.skip_existing),
        "pdfOnly": bool(args.pdf_only),
        "knownClauseUrlCount": 0,
        "filteredNonLifeProductCount": 0,
        "pdfDownloadSkippedExistingCount": 0,
        "userDataDir": args.user_data_dir,
        "waitMs": args.wait_ms,
        "maxDetailProducts": args.max_detail_products,
        "headless": bool(args.headless),
        "queries": [],
        "detailResults": [],
        "records": [],
        "products": [],
    }


def mark_partial(state: dict[str, Any], code: str, message: str) -> None:
    state["partial"] = True
    if not trim(state.get("code")):
        state["code"] = code
        state["message"] = message


async def run_queries(args: argparse.Namespace, crawler: Any, queries: list[dict[str, Any]], state: dict[str, Any]) -> None:
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            args.user_data_dir,
            headless=args.headless,
            viewport=None,
            args=BROWSER_ARGS,
        )
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(SOURCE, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(2000)
            await crawler.jrcpcx_set_visible_page_size(page, args.page_size)
            for query in queries:
                result = await crawler.jrcpcx_query_visible_page(
                    page,
                    query,
                    args.wait_ms,
                    max_pages=args.max_pages,
                    fetch_detail_links=True,
                )
                products = result.get("products") if isinstance(result.get("products"), list) else []
                raw_product_count = len(products)
                products = filter_query_products(query, products)
                filtered_non_life_count = raw_product_count - len(products)
                state["filteredNonLifeProductCount"] = int(state.get("filteredNonLifeProductCount") or 0) + filtered_non_life_count
                metadata = query_metadata(result)
                if filtered_non_life_count:
                    metadata["rawProductCount"] = raw_product_count
                    metadata["filteredNonLifeProductCount"] = filtered_non_life_count
                state["queries"].append(metadata)
                state["products"].extend(products)
                if result.get("queryButtonDisabled"):
                    mark_partial(
                        state,
                        "JRCPCX_QUERY_BUTTON_DISABLED",
                        "Query button stayed disabled; refresh the visible JRCPCX page or complete verification and retry.",
                    )
                elif result.get("verificationVisible") and not products:
                    mark_partial(
                        state,
                        "JRCPCX_VERIFICATION_REQUIRED",
                        "JRCPCX verification is still visible and no products were returned; complete the slider and retry.",
                    )
                write_checkpoint(args.output, state)
                if state["partial"]:
                    break
        finally:
            await context.close()


def run_details(
    args: argparse.Namespace,
    crawler: Any,
    state: dict[str, Any],
    known_clause_urls: set[str],
) -> None:
    seen_detail_urls: set[str] = set()
    fetched = 0
    for product in state.get("products") or []:
        if fetched >= args.max_detail_products:
            break
        if not isinstance(product, dict):
            continue
        detail_url = trim(product.get("detailUrl"))
        if not detail_url or detail_url in seen_detail_urls:
            continue
        if not is_life_ins_detail_url(detail_url):
            state["detailResults"].append(
                {
                    "ok": True,
                    "skippedNonLifeProduct": True,
                    "reason": "non_life_detail_url",
                    "detailUrl": detail_url,
                    "productName": trim(product.get("productName")),
                }
            )
            write_checkpoint(args.output, state)
            continue
        seen_detail_urls.add(detail_url)
        fetched += 1
        try:
            detail_result = crawler.jrcpcx_fetch_life_ins_detail(
                product,
                args.pdf_archive_dir,
                skip_clause_urls=known_clause_urls,
                extract_responsibility=not args.pdf_only,
            )
        except Exception as error:
            detail_result = {
                "ok": False,
                "code": "JRCPCX_DETAIL_EXCEPTION",
                "message": str(error)[:300],
                "detailUrl": detail_url,
                "productName": trim(product.get("productName")),
            }
            mark_partial(
                state,
                "JRCPCX_DETAIL_EXCEPTION",
                "One or more detail fetches raised an exception; inspect detailResults and retry.",
            )
        metadata = detail_metadata(detail_result)
        state["detailResults"].append(metadata)
        if metadata.get("ok") is False:
            mark_partial(
                state,
                "JRCPCX_DETAIL_FETCH_INCOMPLETE",
                "One or more detail fetches failed; inspect detailResults and retry if needed.",
            )
        record = detail_result.get("record") if isinstance(detail_result, dict) else None
        if isinstance(record, dict):
            state["records"].append(record)
        write_checkpoint(args.output, state)


def compact_summary(output_path: str, state: dict[str, Any]) -> dict[str, Any]:
    refresh_counts(state)
    return {
        "ok": state["ok"],
        "partial": state["partial"],
        "code": state["code"],
        "message": state["message"],
        "output": output_path,
        "queryFile": state["queryFile"],
        "queryCount": state["queryCount"],
        "completedQueryCount": len(state["queries"]),
        "productCount": state["productCount"],
        "detailCount": len(state["detailResults"]),
        "detailFailureCount": state["detailFailureCount"],
        "recordCount": state["recordCount"],
        "responsibilityCount": state["responsibilityCount"],
        "filteredNonLifeProductCount": state.get("filteredNonLifeProductCount", 0),
        "pdfDownloadSkippedExistingCount": state["pdfDownloadSkippedExistingCount"],
        "pdfArchiveDir": state["pdfArchiveDir"],
        "dbPath": state["dbPath"],
        "skipExisting": state["skipExisting"],
        "pdfOnly": state.get("pdfOnly"),
        "knownClauseUrlCount": state["knownClauseUrlCount"],
        "userDataDir": state["userDataDir"],
    }


async def run_async() -> dict[str, Any]:
    args = parse_args()
    queries = load_queries(args.query_file)
    crawler = load_crawler_module()
    state = build_initial_state(args, len(queries))
    known_clause_urls = load_known_clause_urls(args.db_path, crawler, args.skip_existing)
    state["knownClauseUrlCount"] = len(known_clause_urls)
    write_checkpoint(args.output, state)
    await run_queries(args, crawler, queries, state)
    run_details(args, crawler, state, known_clause_urls)
    write_checkpoint(args.output, state)
    return compact_summary(args.output, state)


def main() -> int:
    try:
        summary = asyncio.run(run_async())
    except InputError as error:
        summary = {
            "ok": False,
            "partial": False,
            "code": error.code,
            "message": error.message,
            **error.summary,
        }
        print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
        return 1
    print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
    return 0 if summary.get("ok") and not summary.get("partial") else 1


if __name__ == "__main__":
    raise SystemExit(main())
