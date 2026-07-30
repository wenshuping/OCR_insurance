import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import batch_deepseek_backfill as batch
from build_responsibility_inventory import build_inventory


SOURCE_TEXT = """===== PAGE 1 =====
第五条 保险责任
意外住院津贴保险金
被保险人因意外伤害住院治疗的，我们按实际住院日数给付意外住院津贴保险金。
一般住院津贴保险金
被保险人在等待期后因疾病住院治疗的，我们按实际住院日数给付一般住院津贴保险金。
第六条 责任免除
"""


class LockedResponsibilityInventoryTest(unittest.TestCase):
    def build_locked_product(self, root):
        pdf_path = root / "official.pdf"
        pdf_path.write_bytes(b"%PDF-1.4 deterministic-test")
        source_digest = "sha256:" + hashlib.sha256(pdf_path.read_bytes()).hexdigest()
        source_path = root / "official.pages.txt"
        source_path.write_text(SOURCE_TEXT, encoding="utf-8")
        product = {
            "company": "测试人寿保险有限公司",
            "productName": "测试住院津贴保险",
            "sourceUrl": "https://official.example.com/policy.pdf",
            "sourceDigest": source_digest,
            "sourceDocumentPath": str(pdf_path),
            "sourceTextPath": str(source_path),
            "officialDomain": "official.example.com",
            "requireLockedInventory": True,
        }
        inventory = build_inventory(product, SOURCE_TEXT)
        inventory_path = root / "inventory.json"
        inventory_path.write_text(
            json.dumps(inventory, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        product["inventoryPath"] = str(inventory_path)
        product["inventorySha256"] = (
            "sha256:" + hashlib.sha256(inventory_path.read_bytes()).hexdigest()
        )
        return product, inventory

    def test_accepts_exact_locked_inventory_and_builds_bounded_prompt(self):
        with tempfile.TemporaryDirectory() as temporary:
            product, inventory = self.build_locked_product(Path(temporary))
            loaded, receipt = batch.load_locked_inventory(
                product,
                product["sourceDigest"],
                SOURCE_TEXT,
            )

            self.assertEqual(loaded, inventory)
            self.assertEqual(receipt["status"], "passed")
            self.assertEqual(receipt["responsibilityCount"], 2)
            prompt_text = batch.locked_inventory_source_text(loaded)
            self.assertIn("意外住院津贴保险金", prompt_text)
            self.assertIn("一般住院津贴保险金", prompt_text)
            self.assertNotIn("第六条 责任免除", prompt_text)

    def test_accepts_exact_cross_section_official_title(self):
        source_text = (
            "第五条保险责任\n"
            "被保险人身故，我们按保险金额给付保险金。\n"
            "第六条责任免除\n"
            "第十条受益人\n"
            "投保人可以指定身故保险金受益人。\n"
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pdf_path = root / "official.pdf"
            pdf_path.write_bytes(b"%PDF-1.4 deterministic-test")
            source_digest = "sha256:" + hashlib.sha256(pdf_path.read_bytes()).hexdigest()
            source_path = root / "official.pages.txt"
            source_path.write_text(source_text, encoding="utf-8")
            product = {
                "company": "测试人寿保险有限公司",
                "productName": "测试定期寿险",
                "sourceUrl": "https://official.example.com/policy.pdf",
                "sourceDigest": source_digest,
                "sourceDocumentPath": str(pdf_path),
                "sourceTextPath": str(source_path),
                "requireLockedInventory": True,
            }
            inventory = build_inventory(product, source_text)
            inventory_path = root / "inventory.json"
            inventory_path.write_text(
                json.dumps(inventory, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            product["inventoryPath"] = str(inventory_path)
            product["inventorySha256"] = (
                "sha256:" + hashlib.sha256(inventory_path.read_bytes()).hexdigest()
            )

            loaded, receipt = batch.load_locked_inventory(
                product,
                source_digest,
                source_text,
            )

            responsibility = loaded["responsibilities"][0]
            self.assertEqual(responsibility["officialTitle"], "身故保险金")
            self.assertEqual(
                responsibility["detectedBy"],
                "cross_section_official_title",
            )
            self.assertTrue(receipt["allOffsetsExact"])

    @mock.patch.object(batch, "call_model")
    def test_invalid_inventory_stops_before_provider_call(self, call_model_mock):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            product, _ = self.build_locked_product(root)
            product["inventorySha256"] = "sha256:wrong"
            result = batch.process_product(
                product,
                skill_dir=root,
                skill_text="test",
                api_key="not-used",
                provider="deepseek",
                base_url="",
                model="deepseek-v4-flash",
                shadow_config=None,
                repair_rounds=0,
                request_timeout_ms=1000,
                max_output_tokens=256,
                max_prompt_candidate_chars=0,
                max_prompt_skill_chars=0,
                max_prompt_hint_chars=0,
                run_dir=root / "run",
                published_source_digests=set(),
                retry_manual=False,
                retry_failure_classes=set(),
                retry_failure_layers=set(),
            )

            call_model_mock.assert_not_called()
            self.assertEqual(result["failureClass"], "responsibility_inventory_gate")
            self.assertEqual(result["failureLayer"], "pipeline")
            receipt_paths = list((root / "run" / "products").glob(
                "*/locked-responsibility-inventory-receipt.json"
            ))
            self.assertEqual(len(receipt_paths), 1)
            receipt = json.loads(receipt_paths[0].read_text(encoding="utf-8"))
            self.assertEqual(receipt["status"], "failed")
            self.assertFalse(receipt["providerCallStarted"])

    def test_coverage_gate_accepts_insurance_responsibility_and_benefit_suffixes(self):
        inventory = {
            "responsibilities": [
                {"responsibilityId": "R01", "officialTitle": "意外伤害身故保险责任"},
                {"responsibilityId": "R02", "officialTitle": "住院自费医疗费用"},
            ],
        }
        artifact = {
            "responsibilities": [
                {"responsibilityId": "A01", "liability": "意外伤害身故保险金"},
                {"responsibilityId": "A02", "liability": "住院自费医疗费用保险金"},
            ],
        }

        receipt = batch.verify_locked_inventory_coverage(inventory, artifact)

        self.assertTrue(receipt["passed"])
        self.assertEqual(receipt["expectedCount"], 2)
        self.assertEqual(receipt["actualCount"], 2)

    def test_coverage_gate_rejects_omission_and_duplicate(self):
        inventory = {
            "responsibilities": [
                {"responsibilityId": "R01", "officialTitle": "身故保险金"},
                {"responsibilityId": "R02", "officialTitle": "伤残保险金"},
            ],
        }
        artifact = {
            "responsibilities": [
                {"responsibilityId": "A01", "liability": "身故保险金"},
                {"responsibilityId": "A02", "liability": "身故保险责任"},
            ],
        }

        receipt = batch.verify_locked_inventory_coverage(inventory, artifact)

        self.assertFalse(receipt["passed"])
        self.assertEqual([item["title"] for item in receipt["missing"]], ["伤残保险金"])
        self.assertEqual(receipt["duplicatedKeys"], ["身故"])


if __name__ == "__main__":
    unittest.main()
