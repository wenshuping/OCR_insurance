import concurrent.futures
import importlib.util
import json
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).resolve().parent


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


batch = load_module("batch_for_offline_shadow_test", SCRIPTS / "batch_deepseek_backfill.py")
offline = load_module("offline_shadow_test", SCRIPTS / "run_offline_packetized_shadow.py")
packet = load_module(
    "packet_shadow_test",
    Path("/Volumes/OCR_ARCHIVE/OCR_insurance/.agents/skills/"
         "ocr-insurance-fast-responsibility-pipeline/scripts/run_packetized_shadow.py"),
)


class OfflinePacketizedShadowTest(unittest.TestCase):
    def test_launch_is_non_blocking_and_defaults_to_four_generations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "artifact.json"
            artifact.write_text("{}", encoding="utf-8")
            args = mock.Mock(
                offline_packetized_shadow=True,
                offline_shadow_packet_runner=root / "packet.py",
                offline_shadow_base_url="http://fake/v1",
                offline_shadow_model="replaceable-model",
                offline_shadow_api_key="",
                offline_shadow_max_active_generations=4,
                offline_shadow_timeout_ms=90000,
                offline_shadow_max_tokens=768,
                output_dir=root / "run",
            )
            process = mock.Mock(pid=123)
            started = time.monotonic()
            with mock.patch.object(batch.subprocess, "Popen", return_value=process) as popen:
                receipt = batch.launch_offline_packetized_shadow(
                    args, [{"artifactPath": str(artifact)}]
                )
            self.assertLess(time.monotonic() - started, 0.1)
            self.assertEqual(receipt["status"], "launched")
            command = popen.call_args.args[0]
            self.assertIn("--max-active-generations=4", command)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])

    def test_coordinator_applies_global_limit_and_has_no_database_flags(self):
        args = offline.parse_args([
            "--manifest=m.json", "--output-dir=out",
            "--packet-runner=packet.py", "--batch-runner=batch.py",
            "--base-url=http://fake/v1", "--model=fake",
        ])
        self.assertEqual(args.max_active_generations, 4)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "artifact.json"
            artifact.write_text(json.dumps({
                "company": "c", "productName": "p", "responsibilities": []
            }), encoding="utf-8")
            args.output_dir = root / "out"
            args.packet_runner = root / "packet.py"
            args.batch_runner = root / "batch.py"
            captured = {}
            def fake_run(command, **kwargs):
                captured["command"] = command
                product_dir = Path(next(x.split("=", 1)[1] for x in command if x.startswith("--output-dir=")))
                product_dir.mkdir(parents=True)
                (product_dir / "summary.json").write_text(
                    json.dumps({"status": "completed", "comparisonStatus": "aligned"}),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess(command, 0, "", "")
            with mock.patch.object(offline.subprocess, "run", side_effect=fake_run):
                offline.run_product(args, {"artifactPath": str(artifact)})
            self.assertIn("--workers=4", captured["command"])
            self.assertFalse(any("sqlite" in value.lower() or "publish" in value.lower()
                                 for value in captured["command"]))

    def test_failed_product_reruns_but_completed_product_is_cached(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "artifact.json"
            artifact.write_text(json.dumps({"company": "c", "productName": "p"}), encoding="utf-8")
            args = mock.Mock(output_dir=root, packet_runner=root / "p.py",
                             batch_runner=root / "b.py", base_url="http://fake",
                             model="m", api_key="", max_active_generations=4,
                             timeout_ms=1000, max_tokens=64)
            product_dir = root / "products" / offline.safe_name("c", "p")
            product_dir.mkdir(parents=True)
            summary = product_dir / "summary.json"
            summary.write_text(json.dumps({"status": "completed"}), encoding="utf-8")
            with mock.patch.object(offline.subprocess, "run") as run:
                offline.run_product(args, {"artifactPath": str(artifact)})
                run.assert_not_called()
            summary.write_text(json.dumps({"status": "failed"}), encoding="utf-8")
            with mock.patch.object(offline.subprocess, "run",
                                   return_value=subprocess.CompletedProcess([], 1, "", "failed")) as run:
                result = offline.run_product(args, {"artifactPath": str(artifact)})
                run.assert_called_once()
                self.assertEqual(result["status"], "failed")

    def test_packet_rejects_duplicate_and_unknown_responsibility_ids(self):
        expected = {"ids": ["r1", "r2"], "items": [
            {"responsibilityId": "r1", "sourceExcerpt": "一百元"},
            {"responsibilityId": "r2", "sourceExcerpt": "二百元"},
        ]}
        base = {"riskSignals": [], "responsibilities": [
            {"responsibilityId": "r1", "formulaBranches": [], "limits": []},
            {"responsibilityId": "r1", "formulaBranches": [], "limits": []},
        ]}
        with self.assertRaisesRegex(ValueError, "duplicate"):
            packet.validate_packet(base, expected)
        base["responsibilities"][1]["responsibilityId"] = "unknown"
        with self.assertRaisesRegex(ValueError, "mismatch"):
            packet.validate_packet(base, expected)

    def test_packet_executor_enforces_global_generation_limit(self):
        responsibilities = [
            {
                "responsibilityId": f"r{index}",
                "liability": f"责任{index}",
                "sourceExcerpt": "给付一百元",
            }
            for index in range(6)
        ]
        active = 0
        peak = 0
        lock = threading.Lock()

        def fake_run(batch_module, args, artifact, candidate):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.01)
            with lock:
                active -= 1
            return {
                "packetIndex": candidate["index"],
                "responsibilityIds": candidate["ids"],
                "latencyMs": 10,
                "rejectedNumericTokens": [],
                "rejectedClaims": [],
                "output": {
                    "responsibilities": [
                        {"title": item["liability"], "formulaBranches": [], "limits": []}
                        for item in candidate["items"]
                    ],
                    "riskSignals": [],
                },
            }

        candidates = packet.build_packets(responsibilities, 1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(
                lambda candidate: fake_run(None, None, None, candidate),
                candidates,
            ))
        self.assertEqual(peak, 4)

    def test_shadow_launch_failure_is_isolated_from_approved_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifact = root / "artifact.json"
            artifact.write_text("{}", encoding="utf-8")
            approved = [{"status": "approved", "artifactPath": str(artifact)}]
            original = json.loads(json.dumps(approved))
            args = mock.Mock(
                offline_packetized_shadow=True,
                offline_shadow_packet_runner=root / "packet.py",
                offline_shadow_base_url="http://fake/v1",
                offline_shadow_model="replaceable-model",
                offline_shadow_api_key="",
                offline_shadow_max_active_generations=4,
                offline_shadow_timeout_ms=90000,
                offline_shadow_max_tokens=768,
                output_dir=root / "run",
            )
            with mock.patch.object(
                batch.subprocess, "Popen", side_effect=OSError("fake launch failure")
            ):
                receipt = batch.launch_offline_packetized_shadow(args, approved)
            self.assertEqual(receipt["status"], "launch_failed")
            self.assertEqual(approved, original)


if __name__ == "__main__":
    unittest.main()
