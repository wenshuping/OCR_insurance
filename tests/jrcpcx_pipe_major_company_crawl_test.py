import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "jrcpcx-pipe-major-company-crawl.py"


def load_module():
    spec = importlib.util.spec_from_file_location("jrcpcx_pipe_major_company_crawl", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class JrcpcxPipeMajorCompanyCrawlTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def test_human_insurance_query_keeps_only_life_ins_detail_urls(self):
        products = [
            {
                "productName": "寿险产品",
                "detailUrl": "https://inspdinfo.iachina.cn/lifeIns/detail?data=life",
            },
            {
                "productName": "财险产品",
                "detailUrl": "https://inspdinfo.iachina.cn/propertyIns/detail?data=property",
            },
            {
                "productName": "空详情产品",
                "detailUrl": "",
            },
        ]

        filtered = self.module.filter_query_products({"productTypeLabel": "人身保险类"}, products)

        self.assertEqual([item["productName"] for item in filtered], ["寿险产品"])

    def test_non_human_query_keeps_original_products(self):
        products = [
            {"productName": "财险产品", "detailUrl": "https://inspdinfo.iachina.cn/propertyIns/detail?data=property"},
        ]

        self.assertEqual(self.module.filter_query_products({"productTypeLabel": "财产保险类"}, products), products)

    def test_load_products_accepts_saved_crawl_products(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            product_file = Path(temp_dir) / "crawl.json"
            product_file.write_text(
                json.dumps({"products": [{"productName": "寿险产品", "detailUrl": "https://example.test/lifeIns/detail"}]}),
                encoding="utf-8",
            )

            products = self.module.load_products(str(product_file))

        self.assertEqual(products[0]["productName"], "寿险产品")

    def test_load_excluded_detail_urls_reads_detail_results_and_records(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            crawl_file = Path(temp_dir) / "crawl.json"
            crawl_file.write_text(
                json.dumps(
                    {
                        "detailResults": [{"detailUrl": "https://example.test/lifeIns/detail?data=detail"}],
                        "records": [{"detailUrl": "https://example.test/lifeIns/detail?data=record"}],
                    }
                ),
                encoding="utf-8",
            )

            urls = self.module.load_excluded_detail_urls([str(crawl_file)])

        self.assertEqual(
            urls,
            {
                "https://example.test/lifeIns/detail?data=detail",
                "https://example.test/lifeIns/detail?data=record",
            },
        )


if __name__ == "__main__":
    unittest.main()
