#!/usr/bin/env python3
"""Repair official PDF sources without invoking responsibility models."""

import argparse
import asyncio
import hashlib
import json
import re
import ssl
import time
from html.parser import HTMLParser
from http.cookiejar import CookieJar
from pathlib import Path
from urllib import error, parse, request

from pypdf import PdfReader


BLOCKED_HTTP_STATUSES = {403, 405, 412}
CAPTCHA_MARKERS = ("验证码", "滑块", "captcha", "短信验证", "登录后")
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138 Safari/537.36"
)


def text(value):
    return str(value or "").strip()


def normalized_identity(value):
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", text(value)).lower().replace("条款", "")


def normalize_url(value):
    parsed = parse.urlsplit(text(value))
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    hostname = parsed.hostname.lower()
    port = parsed.port
    if (parsed.scheme == "https" and port == 443) or (parsed.scheme == "http" and port == 80):
        port = None
    netloc = hostname if port is None else f"{hostname}:{port}"
    query = parse.urlencode(sorted(parse.parse_qsl(parsed.query, keep_blank_values=True)))
    return parse.urlunsplit((parsed.scheme.lower(), netloc, parsed.path or "/", query, ""))


def official_host_matches(url, official_domain):
    hostname = (parse.urlsplit(url).hostname or "").lower()
    official = text(official_domain).lower().split(":", 1)[0]
    return bool(hostname and official and (hostname == official or hostname.endswith(f".{official}")))


def version_clues(product_name):
    compact = normalized_identity(product_name)
    patterns = (
        r"20\d{2}版",
        r"\d+(?:\.\d+)?版",
        r"[A-Za-z]款",
        r"尊享版|典藏版|互联网版|互联网专属",
    )
    return sorted({match for pattern in patterns for match in re.findall(pattern, compact, flags=re.I)})


def identity_matches(product_name, source_text):
    expected = normalized_identity(product_name).replace("已停售", "")
    actual = normalized_identity(source_text)
    if not expected or not actual:
        return False
    name_matches = expected in actual or (len(expected) >= 10 and expected[-10:] in actual)
    return name_matches and all(normalized_identity(clue) in actual for clue in version_clues(product_name))


def choose_route(row):
    category = text(
        row.get("historicalFailureCategory")
        or row.get("sourceFailureClass")
        or row.get("failureCategory")
    ).lower()
    if category.startswith("model_"):
        return "not_source_failure"
    if "ssl" in category or "certificate" in category:
        return "certificate_blocked"
    if "404" in category:
        return "official_rediscovery"
    if any(code in category for code in ("403", "405", "412")):
        return "browser_session"
    if category in {"screenshot_ocr_candidate", "damaged_or_unreadable_pdf"}:
        return "direct_then_ocr"
    return "direct_then_browser"


class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self._href = ""
        self._label = []
        self._row_text = []
        self._row_links = []
        self._in_row = False

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "tr":
            self._in_row = True
            self._row_text = []
            self._row_links = []
        if tag.lower() != "a":
            return
        self._href = dict(attrs).get("href", "")
        self._label = []

    def handle_data(self, data):
        if self._in_row:
            self._row_text.append(data)
        if self._href:
            self._label.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "a" and self._href:
            link = (self._href, " ".join(self._label))
            if self._in_row:
                self._row_links.append(link)
            else:
                self.links.append((*link, ""))
            self._href = ""
            self._label = []
        if tag.lower() == "tr" and self._in_row:
            row_text = " ".join(self._row_text)
            self.links.extend((*link, row_text) for link in self._row_links)
            self._row_text = []
            self._row_links = []
            self._in_row = False


def discover_pdf_candidates(html, page_url, product_name, official_domain):
    parser = LinkParser()
    parser.feed(html)
    expected = normalized_identity(product_name)
    clues = version_clues(product_name)
    candidates = []
    for href, label, context in parser.links:
        url = normalize_url(parse.urljoin(page_url, href))
        if not url or not official_host_matches(url, official_domain):
            continue
        if not parse.urlsplit(url).path.lower().endswith(".pdf"):
            continue
        haystack = normalized_identity(f"{context} {label} {parse.unquote(url)}")
        overlap = sum(1 for token in re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9]+", expected) if token in haystack)
        score = overlap * 10 + sum(20 for clue in clues if normalized_identity(clue) in haystack)
        candidates.append((score, url))
    return [url for _, url in sorted(set(candidates), key=lambda item: (-item[0], item[1]))]


def validate_pdf_bytes(body):
    if not body.startswith(b"%PDF"):
        raise ValueError("downloaded bytes are not a PDF")


def source_gate(pdf_path, product_name):
    reader = PdfReader(str(pdf_path))
    pages = [page.extract_text() or "" for page in reader.pages]
    source_text = "\n\n".join(f"===== PAGE {index} =====\n{page}" for index, page in enumerate(pages, 1))
    responsibility_pages = [index for index, page in enumerate(pages, 1) if "保险责任" in page]
    readable = bool("".join(pages).strip())
    identity_ok = identity_matches(product_name, "".join(pages[:30]))
    if readable and responsibility_pages and identity_ok:
        status = "source_ready"
        blockers = []
    elif readable and "保险" in source_text and not identity_ok:
        status = "version_conflict"
        blockers = ["downloaded official PDF does not prove the requested product/version identity"]
    else:
        status = "ocr_needs_review"
        blockers = ["PDF text is raster-only, damaged, or the responsibility chapter is not readable"]
    return {
        "sourceStatus": status,
        "sourceText": source_text,
        "responsibilityPages": responsibility_pages,
        "blockers": blockers,
    }


def build_opener():
    return request.build_opener(request.HTTPCookieProcessor(CookieJar()))


def fetch(opener, url, referer=""):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8"}
    if referer:
        headers["Referer"] = referer
    response = opener.open(request.Request(url, headers=headers), timeout=45)
    return response.status, response.headers.get("Content-Type", ""), response.geturl(), response.read()


def direct_acquire(row, *, include_legacy_source=True):
    source_url = normalize_url(row.get("sourceUrl") or row.get("normalizedSourceUrl"))
    discovery_url = normalize_url(
        row.get("discoveryUrl") or row.get("detailUrl") or row.get("sourcePage")
    )
    official_domain = text(row.get("officialDomain")) or (parse.urlsplit(source_url).hostname or "")
    opener = build_opener()
    candidates = []
    if discovery_url:
        _, content_type, final_url, body = fetch(opener, discovery_url)
        if "html" in content_type.lower():
            candidates.extend(
                discover_pdf_candidates(body.decode("utf-8", "replace"), final_url, row.get("productName"), official_domain)
            )
    for candidate in row.get("alternativeSourceUrls") or row.get("sourceCandidates") or []:
        candidate_url = normalize_url(candidate.get("url") if isinstance(candidate, dict) else candidate)
        if candidate_url:
            candidates.append(candidate_url)
    if include_legacy_source:
        candidates.append(source_url)
    attempts = []
    for candidate in dict.fromkeys(url for url in candidates if url):
        try:
            status, content_type, final_url, body = fetch(opener, candidate, discovery_url)
            attempts.append({"method": "direct_session", "url": candidate, "status": status})
            validate_pdf_bytes(body)
            if not official_host_matches(final_url, official_domain):
                raise ValueError("final PDF host is outside the official domain")
            return body, final_url, attempts
        except error.HTTPError as exc:
            attempts.append({"method": "direct_session", "url": candidate, "status": exc.code})
        except (error.URLError, TimeoutError, ssl.SSLError, ValueError) as exc:
            attempts.append({"method": "direct_session", "url": candidate, "error": str(exc)})
    return None, "", attempts


async def browser_acquire(row, browser, output_dir):
    source_url = normalize_url(row.get("sourceUrl") or row.get("normalizedSourceUrl"))
    discovery_url = normalize_url(
        row.get("discoveryUrl") or row.get("detailUrl") or row.get("sourcePage")
    )
    official_domain = text(row.get("officialDomain")) or (parse.urlsplit(source_url).hostname or "")
    context = await browser.new_context(accept_downloads=True, user_agent=USER_AGENT)
    page = await context.new_page()
    attempts = []
    try:
        candidates = []
        if discovery_url:
            response = await page.goto(discovery_url, wait_until="domcontentloaded", timeout=45000)
            attempts.append({
                "method": "browser_discovery",
                "url": discovery_url,
                "status": response.status if response else None,
            })
            await page.wait_for_timeout(1200)
            rendered = await page.content()
            lowered = rendered.lower()
            if any(marker in lowered for marker in CAPTCHA_MARKERS):
                return None, "", attempts, "captcha_or_login_blocked"
            candidates.extend(
                discover_pdf_candidates(rendered, page.url, row.get("productName"), official_domain)
            )
        candidates.append(source_url)
        for candidate in dict.fromkeys(url for url in candidates if url):
            if not official_host_matches(candidate, official_domain):
                continue
            try:
                response = await context.request.get(
                    candidate,
                    headers={"Referer": page.url if discovery_url else source_url},
                    timeout=45000,
                    fail_on_status_code=False,
                )
                attempts.append({"method": "browser_context_request", "url": candidate, "status": response.status})
                body = await response.body()
                if response.ok and body.startswith(b"%PDF"):
                    return body, str(response.url), attempts, ""
                navigation = await page.goto(candidate, wait_until="domcontentloaded", timeout=45000)
                attempts.append({
                    "method": "browser_navigation",
                    "url": candidate,
                    "status": navigation.status if navigation else None,
                })
                await page.wait_for_timeout(2500)
                retry = await context.request.get(
                    candidate,
                    headers={"Referer": page.url},
                    timeout=45000,
                    fail_on_status_code=False,
                )
                retry_body = await retry.body()
                attempts.append({"method": "browser_context_retry", "url": candidate, "status": retry.status})
                if retry.ok and retry_body.startswith(b"%PDF"):
                    return retry_body, str(retry.url), attempts, ""
            except Exception as exc:
                attempts.append({"method": "browser", "url": candidate, "error": str(exc)})
        screenshot = output_dir / "blocker.png"
        await page.screenshot(path=str(screenshot), full_page=True)
        return None, "", attempts, "browser_session_did_not_yield_verified_pdf_bytes"
    finally:
        await context.close()


def load_queue(path):
    raw = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        value = json.loads(raw)
        if not isinstance(value, list):
            raise ValueError("JSON queue must be an array")
        return value
    return [json.loads(line) for line in raw.splitlines() if line.strip()]


def receipt_class(source_status):
    if source_status == "source_ready":
        return "source_ready"
    if source_status == "version_conflict":
        return "version_conflict"
    return "still_blocked"


def next_lawful_route(route, source_status):
    if source_status in {"source_ready", "version_conflict"}:
        return ""
    if route == "official_rediscovery":
        return "supply_or_discover_official_product_detail_page"
    if route == "browser_session":
        return "company_browser_adapter"
    if route == "certificate_blocked":
        return "official_certificate_repair_or_verified_company_adapter"
    if source_status == "ocr_needs_review":
        return "page_numbered_screenshot_ocr_review"
    return "browser_session_or_company_adapter"


async def run(args):
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise ValueError("output directory must be new or empty")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name in ("source_ready", "still_blocked", "version_conflict"):
        (args.output_dir / "receipts" / name).mkdir(parents=True, exist_ok=True)
    rows = load_queue(args.queue)
    browser = None
    playwright_runtime = None
    try:
        for index, row in enumerate(rows):
            route = choose_route(row)
            source_url = normalize_url(row.get("sourceUrl") or row.get("normalizedSourceUrl"))
            item_id = hashlib.sha256(source_url.encode("utf-8")).hexdigest()[:16]
            item_dir = args.output_dir / "products" / item_id
            item_dir.mkdir(parents=True, exist_ok=True)
            attempts = []
            body = None
            final_url = ""
            blocker = ""
            if route == "certificate_blocked":
                blocker = "official_certificate_chain_invalid"
            elif route == "not_source_failure":
                blocker = "non_source_failure_excluded_from_source_repair"
            elif route not in {"not_source_failure"}:
                try:
                    body, final_url, attempts = direct_acquire(
                        row,
                        include_legacy_source=route not in {"official_rediscovery", "certificate_blocked"},
                    )
                except Exception as exc:
                    attempts.append({"method": "direct_session", "error": str(exc)})
            if body is None and route not in {"certificate_blocked", "not_source_failure"}:
                discovery_url = text(
                    row.get("discoveryUrl") or row.get("detailUrl") or row.get("sourcePage")
                )
                if route == "official_rediscovery" and not discovery_url:
                    blocker = "official_detail_or_list_page_required_for_404_rediscovery"
                else:
                    if browser is None:
                        from playwright.async_api import async_playwright

                        playwright_runtime = await async_playwright().start()
                        try:
                            browser = await playwright_runtime.chromium.launch(
                                channel="chrome",
                                headless=not args.headed,
                            )
                        except Exception as exc:
                            attempts.append({"method": "browser_launch", "error": str(exc)})
                            blocker = "system_chrome_unavailable_for_browser_source_repair"
                    if browser is not None:
                        body, final_url, browser_attempts, blocker = await browser_acquire(
                            row,
                            browser,
                            item_dir,
                        )
                        attempts.extend(browser_attempts)
            if body is not None:
                validate_pdf_bytes(body)
                pdf_path = item_dir / "official-source.pdf"
                pdf_path.write_bytes(body)
                gate = source_gate(pdf_path, row.get("productName"))
                text_path = item_dir / "official-source.pages.txt"
                text_path.write_text(gate.pop("sourceText"), encoding="utf-8")
                source_status = gate["sourceStatus"]
                manifest = {
                    "company": text(row.get("company")),
                    "productName": text(row.get("productName")),
                    "sourceStatus": source_status,
                    "sourceUrl": final_url,
                    "discoveryUrl": text(
                        row.get("discoveryUrl") or row.get("detailUrl") or row.get("sourcePage")
                    ),
                    "officialHost": parse.urlsplit(final_url).hostname or "",
                    "retrievalMethod": "browser" if any("browser" in attempt["method"] for attempt in attempts) else "direct",
                    "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "sourceDigest": "sha256:" + hashlib.sha256(body).hexdigest(),
                    "sourceFile": str(pdf_path),
                    "extractedTextFile": str(text_path),
                    "responsibilityTextFile": str(text_path) if source_status == "source_ready" else "",
                    "responsibilityPages": gate["responsibilityPages"],
                    "referencedTablePages": [],
                    "screenshots": [str(path) for path in item_dir.glob("*.png")],
                    "identityEvidence": {
                        "company": text(row.get("company")),
                        "productName": text(row.get("productName")),
                        "version": ", ".join(version_clues(row.get("productName"))),
                    },
                    "attempts": attempts,
                    "blockers": gate["blockers"],
                }
            else:
                source_status = "source_blocked"
                manifest = {
                    "company": text(row.get("company")),
                    "productName": text(row.get("productName")),
                    "sourceStatus": source_status,
                    "sourceUrl": source_url,
                    "discoveryUrl": text(
                        row.get("discoveryUrl") or row.get("detailUrl") or row.get("sourcePage")
                    ),
                    "officialHost": parse.urlsplit(source_url).hostname or "",
                    "retrievalMethod": route,
                    "retrievedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "sourceDigest": "",
                    "sourceFile": "",
                    "extractedTextFile": "",
                    "responsibilityTextFile": "",
                    "responsibilityPages": [],
                    "referencedTablePages": [],
                    "screenshots": [str(path) for path in item_dir.glob("*.png")],
                    "identityEvidence": {
                        "company": text(row.get("company")),
                        "productName": text(row.get("productName")),
                        "version": ", ".join(version_clues(row.get("productName"))),
                    },
                    "attempts": attempts,
                    "blockers": [blocker or "official_pdf_not_recovered"],
                }
            manifest_path = item_dir / "source-manifest.json"
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            kind = receipt_class(source_status)
            receipt = {
                **manifest,
                "receiptClass": kind,
                "manifestPath": str(manifest_path),
                "nextLawfulRoute": next_lawful_route(route, source_status),
            }
            (args.output_dir / "receipts" / kind / f"{item_id}.json").write_text(
                json.dumps(receipt, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            if index + 1 < len(rows):
                await asyncio.sleep(args.domain_delay)
    finally:
        if browser is not None:
            await browser.close()
        if playwright_runtime is not None:
            await playwright_runtime.stop()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--domain-delay", type=float, default=1.5)
    parser.add_argument("--headed", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
