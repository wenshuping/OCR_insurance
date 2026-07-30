#!/usr/bin/env python3

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib import error

from batch_deepseek_backfill import (
    bounded_shadow_text,
    build_high_capability_review_packet,
    classify_failure,
    compare_shadow_to_artifact,
    shadow_complexity_reasons,
    should_retry,
    start_shadow_assistant,
    validate_high_capability_review_result,
    validate_shadow_result,
)
from model_client import ModelRequestError, call_model, chat_completions_url


class Response:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class ModelClientTest(unittest.TestCase):
    def test_gemini_uses_openai_compatible_endpoint(self):
        self.assertEqual(
            chat_completions_url("gemini"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        )

    @mock.patch("model_client.request.urlopen")
    def test_call_model_returns_message_content(self, urlopen):
        urlopen.return_value = Response(json.dumps({
            "choices": [{"message": {"content": "{\"ok\":true}"}}],
        }).encode())

        result = call_model("key", "gemini-flash-latest", [{"role": "user", "content": "x"}], provider="gemini")

        self.assertEqual(result, "{\"ok\":true}")
        sent = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(sent["model"], "gemini-flash-latest")

    @mock.patch("model_client.request.urlopen")
    def test_call_model_accepts_shadow_limits_and_schema(self, urlopen):
        urlopen.return_value = Response(json.dumps({
            "choices": [{"message": {"content": "{\"riskSignals\":[]}"}}],
        }).encode())
        response_format = {
            "type": "json_schema",
            "json_schema": {"name": "shadow", "schema": {"type": "object"}},
        }

        call_model(
            "",
            "local-model",
            [{"role": "user", "content": "x"}],
            provider="openai-compatible",
            base_url="http://127.0.0.1:18080/v1",
            max_tokens=1024,
            response_format=response_format,
            timeout=45,
        )

        sent_request = urlopen.call_args.args[0]
        sent = json.loads(sent_request.data)
        self.assertEqual(sent["max_tokens"], 1024)
        self.assertEqual(sent["response_format"], response_format)
        self.assertNotIn("Authorization", sent_request.headers)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 45)

    @mock.patch("model_client.request.urlopen")
    def test_billing_error_is_structured(self, urlopen):
        urlopen.side_effect = error.HTTPError(
            "https://api.deepseek.com/chat/completions",
            402,
            "Payment Required",
            {},
            io.BytesIO(b'{"error":"insufficient balance"}'),
        )

        with self.assertRaises(ModelRequestError) as raised:
            call_model("key", "deepseek-chat", [], provider="deepseek")

        self.assertEqual(raised.exception.failure_class, "model_billing")
        self.assertEqual(raised.exception.status_code, 402)
        self.assertFalse(raised.exception.retryable)

    def test_legacy_bare_403_is_classified_as_model_failure(self):
        result = classify_failure("HTTP Error 403: Forbidden")
        self.assertEqual(result["failureClass"], "model_auth_or_permission")
        self.assertEqual(result["failureLayer"], "model")

    def test_selective_retry_supports_legacy_results(self):
        previous = {"status": "manual_review", "error": "HTTP Error 403: Forbidden"}
        self.assertTrue(should_retry(previous, False, {"model_auth_or_permission"}, set()))
        self.assertTrue(should_retry(previous, False, set(), {"model"}))
        self.assertFalse(should_retry(previous, False, {"source_acquisition"}, set()))

    def test_shadow_text_starts_at_responsibility_page_when_bounded(self):
        source = "PDF_PAGE_1\nidentity\n" + ("x" * 50) + "\nPDF_PAGE_2\n2.4 保险责任\nbenefit text"

        bounded, truncated = bounded_shadow_text(source, 35)

        self.assertTrue(truncated)
        self.assertTrue(bounded.startswith("PDF_PAGE_2"))
        self.assertIn("保险责任", bounded)

    @mock.patch("batch_deepseek_backfill.call_model")
    def test_shadow_assistant_persists_model_response(self, call_model_mock):
        response = json.dumps({
            "responsibilities": [],
            "riskSignals": [],
        })
        call_model_mock.return_value = response

        with tempfile.TemporaryDirectory() as directory:
            product_dir = Path(directory)
            thread, receipt_path = start_shadow_assistant(
                {"company": "测试保险", "productName": "测试产品"},
                "保险责任：按基本保险金额给付。",
                product_dir,
                base_url="http://127.0.0.1:18081/v1",
                model="DianJin-R1-32B",
                api_key="",
                timeout_ms=45000,
                max_tokens=3000,
                max_input_chars=4000,
                routing_reasons=["test"],
            )
            thread.join(timeout=2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(
                json.loads(receipt_path.read_text(encoding="utf-8"))["status"],
                "completed",
            )
            self.assertEqual(
                (product_dir / "shadow-raw.txt").read_text(encoding="utf-8"),
                response,
            )

    def test_shadow_validation_rejects_unanchored_signals_and_non_numeric_tokens(self):
        parsed = {
            "responsibilities": [{
                "title": "身故保险金",
                "formulaBranches": [{
                    "condition": "年满18周岁",
                    "formula": "较大者",
                    "numericTokens": ["18周岁", "基本保险金额", "160%"],
                }],
                "limits": [],
            }],
            "riskSignals": ["age_branch", "policy_year_branch", "max_formula", "min_formula"],
        }
        source = "年满18周岁，按累计已交保险费的160%与现金价值的较大者给付。"

        validated, receipt = validate_shadow_result(parsed, source)

        self.assertEqual(validated["riskSignals"], ["age_branch", "max_formula"])
        self.assertEqual(validated["responsibilities"][0]["formulaBranches"][0]["numericTokens"], ["18周岁", "160%"])
        self.assertEqual(receipt["rejectedRiskSignals"], ["policy_year_branch", "min_formula"])
        self.assertEqual(receipt["rejectedNumericTokens"], ["基本保险金额"])

    def test_shadow_complexity_routes_multi_age_max_formula(self):
        reasons = shadow_complexity_reasons(
            "18周岁前按100%，41周岁前按160%与现金价值的较大者",
            {"selectedTablePages": []},
        )

        self.assertIn("multiple_age_boundaries", reasons)
        self.assertIn("multiple_percentages", reasons)
        self.assertIn("max_formula", reasons)

    def test_shadow_complexity_skips_simple_direct_benefit(self):
        self.assertEqual(
            shadow_complexity_reasons("身故后按基本保险金额给付身故保险金。", {}),
            [],
        )

    def test_shadow_comparison_aligns_matching_formula(self):
        shadow = {
            "responsibilities": [{
                "title": "身故保险金",
                "formulaBranches": [{
                    "condition": "18周岁后",
                    "formula": "160%",
                    "numericTokens": ["18周岁", "160%"],
                }],
            }],
        }
        artifact = {
            "responsibilities": [{
                "responsibilityId": "death",
                "liability": "身故保险金",
                "sourceExcerpt": "18周岁后按160%给付",
                "indicators": [{"branches": [{
                    "conditionText": "18周岁后",
                    "formulaText": "160%",
                }]}],
            }],
        }

        comparison = compare_shadow_to_artifact(shadow, artifact)

        self.assertEqual(comparison["status"], "aligned")
        self.assertEqual(comparison["materialConflicts"], [])

    def test_shadow_comparison_routes_missing_numeric_token(self):
        shadow = {
            "responsibilities": [{
                "title": "身故保险金",
                "formulaBranches": [{
                    "condition": "18周岁后",
                    "formula": "160%",
                    "numericTokens": ["160%"],
                }],
            }],
        }
        artifact = {
            "responsibilities": [{
                "responsibilityId": "death",
                "liability": "身故保险金",
                "sourceExcerpt": "按基本保险金额给付",
                "indicators": [{"branches": [{
                    "conditionText": "身故",
                    "formulaText": "基本保险金额",
                }]}],
            }],
        }

        comparison = compare_shadow_to_artifact(shadow, artifact)

        self.assertEqual(comparison["status"], "review_required")
        self.assertEqual(
            comparison["materialConflicts"][0]["type"],
            "numeric_tokens_missing_from_artifact",
        )

    def test_shadow_comparison_prefers_exact_title_over_earlier_contains_match(self):
        shadow = {
            "responsibilities": [{
                "title": "身故或高残保险金",
                "formulaBranches": [{
                    "condition": "18周岁后",
                    "formula": "160%",
                    "numericTokens": ["160%"],
                }],
            }],
        }
        artifact = {
            "responsibilities": [
                {
                    "responsibilityId": "waiting",
                    "liability": "等待期身故或高残已交保险费返还",
                    "indicators": [{"branches": []}],
                },
                {
                    "responsibilityId": "death",
                    "liability": "身故或高残保险金",
                    "sourceExcerpt": "按160%给付",
                    "indicators": [{"branches": [{
                        "conditionText": "18周岁后",
                        "formulaText": "160%",
                    }]}],
                },
            ],
        }

        comparison = compare_shadow_to_artifact(shadow, artifact)

        self.assertEqual(comparison["status"], "aligned")
        self.assertEqual(comparison["comparisons"][0]["responsibilityId"], "death")

    def test_high_capability_packet_contains_only_conflicting_responsibility(self):
        artifact = {
            "productIdentity": {"sourceDigest": "sha256:abc"},
            "responsibilities": [
                {
                    "responsibilityId": "death",
                    "liability": "身故保险金",
                    "sourceExcerpt": "按基本保险金额给付身故保险金。",
                },
                {
                    "responsibilityId": "maturity",
                    "liability": "满期保险金",
                    "sourceExcerpt": "期满按基本保险金额给付。",
                },
            ],
        }
        shadow = {
            "responsibilities": [
                {"title": "身故保险金", "formulaBranches": []},
                {"title": "满期保险金", "formulaBranches": []},
            ],
        }
        comparison = {
            "comparisons": [
                {
                    "status": "conflict",
                    "responsibilityId": "death",
                    "artifactLiability": "身故保险金",
                    "shadowTitle": "身故保险金",
                },
                {
                    "status": "aligned",
                    "responsibilityId": "maturity",
                    "artifactLiability": "满期保险金",
                    "shadowTitle": "满期保险金",
                },
            ],
        }

        packet = build_high_capability_review_packet(
            {"company": "测试人寿", "productName": "测试产品"},
            artifact,
            shadow,
            comparison,
            "保险责任：按基本保险金额给付身故保险金。",
        )

        self.assertEqual(len(packet["reviewItems"]), 1)
        self.assertEqual(packet["reviewItems"][0]["responsibilityId"], "death")
        self.assertNotIn("maturity", json.dumps(packet, ensure_ascii=False))

    def test_shadow_comparison_does_not_let_source_excerpt_hide_wrong_formula(self):
        shadow = {
            "responsibilities": [{
                "title": "身故保险金",
                "formulaBranches": [{
                    "condition": "18周岁后",
                    "formula": "160%",
                    "numericTokens": ["18周岁", "160%"],
                }],
            }],
        }
        artifact = {
            "responsibilities": [{
                "responsibilityId": "death",
                "liability": "身故保险金",
                "sourceExcerpt": "18周岁后按160%给付",
                "indicators": [{"formulaText": "按140%给付", "branches": [{
                    "conditionText": "18周岁后",
                    "formulaText": "140%",
                }]}],
            }],
        }

        comparison = compare_shadow_to_artifact(shadow, artifact)

        self.assertEqual(comparison["status"], "review_required")
        self.assertEqual(
            comparison["materialConflicts"][0]["tokens"],
            ["160%"],
        )

    def test_high_capability_result_requires_exact_official_evidence(self):
        packet = {
            "reviewItems": [{
                "responsibilityId": "death",
                "officialSourceWindow": "按累计已交保险费的160%给付。",
                "validatedArtifactResponsibility": {},
            }],
        }
        valid = {
            "decisions": [{
                "responsibilityId": "death",
                "decision": "repair_artifact",
                "officialEvidence": ["累计已交保险费的160%"],
            }],
            "overallDecision": "repair_required",
        }
        invalid = {
            "decisions": [{
                "responsibilityId": "death",
                "decision": "repair_artifact",
                "officialEvidence": ["累计已交保险费的180%"],
            }],
            "overallDecision": "repair_required",
        }

        self.assertTrue(validate_high_capability_review_result(packet, valid)["ok"])
        self.assertFalse(validate_high_capability_review_result(packet, invalid)["ok"])

if __name__ == "__main__":
    unittest.main()
