#!/usr/bin/env python3

import argparse
import asyncio
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pypdf import PdfWriter

from repair_source_queue import (
    choose_route,
    discover_pdf_candidates,
    identity_matches,
    next_lawful_route,
    normalize_url,
    official_host_matches,
    run,
    validate_pdf_bytes,
    version_clues,
)


class SourceRepairTest(unittest.TestCase):
    def test_source_http_and_model_http_failures_route_differently(self):
        self.assertEqual(choose_route({"failureCategory": "pdf_download_403"}), "browser_session")
        self.assertEqual(choose_route({"failureCategory": "pdf_download_404"}), "official_rediscovery")
        self.assertEqual(choose_route({"failureCategory": "pdf_download_ssl"}), "certificate_blocked")
        self.assertEqual(choose_route({"failureCategory": "model_auth_or_permission"}), "not_source_failure")
        self.assertEqual(
            next_lawful_route("browser_session", "source_blocked"),
            "company_browser_adapter",
        )

    def test_discovery_keeps_only_official_pdf_links_and_prefers_version(self):
        html = """
        <a href="/files/example-2024.pdf">安心保 2024版条款</a>
        <a href="/files/example-2023.pdf">安心保 2023版条款</a>
        <a href="https://unofficial.example/example-2024.pdf">镜像</a>
        """
        candidates = discover_pdf_candidates(
            html,
            "https://www.insurer.example/products/1",
            "安心保（2024版）",
            "insurer.example",
        )
        self.assertEqual(candidates[0], "https://www.insurer.example/files/example-2024.pdf")
        self.assertEqual(len(candidates), 2)

    def test_discovery_uses_product_name_from_the_same_table_row(self):
        html = """
        <table>
          <tr><td>另一款保险</td><td><a href="/files/other.pdf">产品条款</a></td></tr>
          <tr><td>安心保（2024版）</td><td><a href="/files/expected.pdf">产品条款</a></td></tr>
        </table>
        """
        candidates = discover_pdf_candidates(
            html,
            "https://www.insurer.example/products",
            "安心保（2024版）",
            "insurer.example",
        )
        self.assertEqual(candidates[0], "https://www.insurer.example/files/expected.pdf")

    def test_identity_requires_requested_version(self):
        self.assertTrue(identity_matches("安心保（2024版）", "安心保（2024版）保险条款 第三条 保险责任"))
        self.assertFalse(identity_matches("安心保（2024版）", "安心保（2023版）保险条款 第三条 保险责任"))
        self.assertEqual(version_clues("安心保（2024版）"), ["2024版"])

    def test_url_and_host_normalization(self):
        self.assertEqual(
            normalize_url("HTTPS://WWW.Example.COM:443/a.pdf?b=2&a=1#page=2"),
            "https://www.example.com/a.pdf?a=1&b=2",
        )
        self.assertTrue(official_host_matches("https://assets.insurer.example/a.pdf", "insurer.example"))
        self.assertFalse(official_host_matches("https://insurer.example.evil.test/a.pdf", "insurer.example"))

    def test_pdf_magic_is_required(self):
        validate_pdf_bytes(b"%PDF-1.7\n")
        with self.assertRaises(ValueError):
            validate_pdf_bytes(b"<html>blocked</html>")

    def test_browser_session_reuses_detail_page_cookie_and_referer(self):
        pdf = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.write(pdf)
        pdf_bytes = pdf.getvalue()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/detail":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Set-Cookie", "source_session=ready; Path=/")
                    self.end_headers()
                    self.wfile.write(b'<a href="/file.pdf">official terms</a>')
                    return
                if self.path == "/file.pdf":
                    cookie = self.headers.get("Cookie", "")
                    referer = self.headers.get("Referer", "")
                    if "source_session=ready" not in cookie or not referer.endswith("/detail"):
                        self.send_response(403)
                        self.end_headers()
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.end_headers()
                    self.wfile.write(pdf_bytes)
                    return
                self.send_response(404)
                self.end_headers()

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                queue = root / "queue.jsonl"
                output = root / "output"
                base = f"http://127.0.0.1:{server.server_port}"
                queue.write_text(json.dumps({
                    "company": "测试保险",
                    "productName": "安心保",
                    "sourceUrl": f"{base}/file.pdf",
                    "discoveryUrl": f"{base}/detail",
                    "officialDomain": "127.0.0.1",
                    "failureCategory": "pdf_download_403",
                }, ensure_ascii=False) + "\n", encoding="utf-8")

                asyncio.run(run(argparse.Namespace(
                    queue=queue,
                    output_dir=output,
                    domain_delay=0,
                    headed=False,
                )))

                manifests = list((output / "products").glob("*/source-manifest.json"))
                self.assertEqual(len(manifests), 1)
                manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
                self.assertTrue(Path(manifest["sourceFile"]).exists())
                self.assertTrue(any(attempt.get("status") == 200 for attempt in manifest["attempts"]))
        finally:
            server.shutdown()
            server.server_close()

    def test_alternative_official_candidate_can_replace_blocked_legacy_url(self):
        pdf = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.write(pdf)
        pdf_bytes = pdf.getvalue()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/old.pdf":
                    self.send_response(404)
                    self.end_headers()
                    return
                if self.path == "/candidate.pdf":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.end_headers()
                    self.wfile.write(pdf_bytes)
                    return
                self.send_response(404)
                self.end_headers()

            def log_message(self, *_args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                queue = root / "queue.jsonl"
                output = root / "output"
                base = f"http://127.0.0.1:{server.server_port}"
                queue.write_text(json.dumps({
                    "company": "测试保险",
                    "productName": "安心保",
                    "sourceUrl": f"{base}/old.pdf",
                    "officialDomain": "127.0.0.1",
                    "failureCategory": "pdf_download_404",
                    "alternativeSourceUrls": [{"url": f"{base}/candidate.pdf"}],
                }, ensure_ascii=False) + "\n", encoding="utf-8")

                asyncio.run(run(argparse.Namespace(
                    queue=queue,
                    output_dir=output,
                    domain_delay=0,
                    headed=False,
                )))

                manifest_path = next((output / "products").glob("*/source-manifest.json"))
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                self.assertEqual(manifest["sourceStatus"], "ocr_needs_review")
                self.assertTrue(Path(manifest["sourceFile"]).exists())
                self.assertEqual(manifest["sourceUrl"], f"http://127.0.0.1:{server.server_port}/candidate.pdf")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
