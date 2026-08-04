#!/usr/bin/env python3

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from batch_deepseek_backfill import classify_failure, select_from_database


class SourceFailureClassificationTest(unittest.TestCase):
    def test_source_403_and_model_403_are_not_conflated(self):
        source = classify_failure("PDF download failed: HTTP Error 403: Forbidden")
        model = classify_failure("HTTP Error 403: Forbidden")

        self.assertEqual(source["failureLayer"], "source")
        self.assertEqual(source["sourceFailureClass"], "pdf_download_403")
        self.assertEqual(source["nextSourceAction"], "browser_session_download")
        self.assertEqual(model["failureLayer"], "model")
        self.assertEqual(model["failureClass"], "model_auth_or_permission")

    def test_source_404_routes_to_official_rediscovery(self):
        result = classify_failure("PDF download failed: HTTP Error 404: Not Found")

        self.assertEqual(result["sourceFailureClass"], "pdf_download_404")
        self.assertEqual(result["nextSourceAction"], "official_detail_rediscovery")

    def test_ssl_failure_does_not_request_repeated_direct_download(self):
        result = classify_failure(
            "PDF download failed: <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed>"
        )

        self.assertEqual(result["sourceFailureClass"], "pdf_download_ssl")
        self.assertEqual(result["nextSourceAction"], "certificate_or_company_adapter_review")

    def test_database_selection_preserves_discovery_page(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "knowledge.sqlite"
            connection = sqlite3.connect(database)
            try:
                connection.execute(
                    "CREATE TABLE knowledge_records ("
                    "id INTEGER PRIMARY KEY, company TEXT, product_name TEXT, url TEXT, payload TEXT)"
                )
                connection.execute(
                    "INSERT INTO knowledge_records (company, product_name, url, payload) VALUES (?, ?, ?, ?)",
                    (
                        "测试保险",
                        "安心保（2024版）",
                        "https://www.insurer.example/files/old.pdf",
                        json.dumps(
                            {
                                "official": True,
                                "company": "测试保险",
                                "productName": "安心保（2024版）",
                                "url": "https://www.insurer.example/files/old.pdf",
                                "detailUrl": "https://www.insurer.example/products/安心保",
                                "pageText": "第三条 保险责任",
                            },
                            ensure_ascii=False,
                        ),
                    ),
                )
                connection.commit()
            finally:
                connection.close()

            selected = select_from_database(database, 1)

        self.assertEqual(
            selected[0]["discoveryUrl"],
            "https://www.insurer.example/products/安心保",
        )


if __name__ == "__main__":
    unittest.main()
