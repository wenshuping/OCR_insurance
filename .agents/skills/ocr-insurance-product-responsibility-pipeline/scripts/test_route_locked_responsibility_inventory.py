import unittest

from route_locked_responsibility_inventory import classify


def inventory(*titles, evidence="被保险人身故，我们给付保险金。"):
    return {
        "status": "inventory_ready",
        "blockers": [],
        "responsibilities": [
            {"officialTitle": title, "evidencePacket": evidence}
            for title in titles
        ],
    }


class LockedResponsibilityInventoryRoutingTest(unittest.TestCase):
    def test_routes_simple_life_to_deepseek(self):
        route, reason = classify(
            {"productName": "测试定期寿险"},
            inventory("身故保险金", "全残保险金"),
        )

        self.assertEqual(route, "deepseek-standard")
        self.assertEqual(reason, "simple_inventory")

    def test_routes_medical_to_luna(self):
        route, _ = classify(
            {"productName": "测试医疗保险"},
            inventory("一般医疗保险金", "重大疾病医疗保险金"),
        )

        self.assertEqual(route, "luna-complex")

    def test_quarantines_narrative_title(self):
        route, reason = classify(
            {"productName": "测试终身寿险"},
            inventory("予相应的保险金"),
        )

        self.assertEqual(route, "inventory_review")
        self.assertEqual(reason, "suspicious_inventory_title")

    def test_quarantines_medical_cost_subheading(self):
        route, reason = classify(
            {"productName": "测试医疗保险"},
            inventory("一般医疗保险金", "住院医疗费用"),
        )

        self.assertEqual(route, "inventory_review")
        self.assertEqual(reason, "suspicious_inventory_title")

    def test_quarantines_annuity_without_annuity_benefit(self):
        route, reason = classify(
            {"productName": "测试养老年金保险"},
            inventory("身故保险金"),
        )

        self.assertEqual(route, "inventory_review")
        self.assertEqual(reason, "annuity_inventory_missing_annuity_benefit")

    def test_quarantines_blocked_inventory(self):
        value = inventory("身故保险金")
        value["status"] = "inventory_blocked"
        value["blockers"] = ["packet_gate_failed"]

        route, reason = classify({"productName": "测试定期寿险"}, value)

        self.assertEqual(route, "inventory_review")
        self.assertEqual(reason, "inventory_not_ready")


if __name__ == "__main__":
    unittest.main()
