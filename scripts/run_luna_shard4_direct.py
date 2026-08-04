#!/usr/bin/env python3
"""Run the fixed rolling-wave-next shard-4 through Codex Luna, parse-only."""

from __future__ import annotations

import importlib.util
from pathlib import Path


DRIVER = Path(__file__).with_name("run_luna_window4_shard3_direct.py")
INPUT = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/"
    "responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/"
    "run-window-3-33-20260727/subagent-luna-resume-1/luna-shards/shard-4.json"
)
OUTPUT = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/"
    "responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/"
    "run-window-3-33-20260727/subagent-luna-resume-1/shard-4-run"
)


def main() -> int:
    spec = importlib.util.spec_from_file_location("luna_shard_driver", DRIVER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load driver: {DRIVER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.INPUT = INPUT
    module.OUTPUT = OUTPUT
    module.MAX_WORKERS = 1
    module.DOWNLOAD_UA = "Mozilla/5.0 OCRInsuranceLunaShard4/1.0"
    module.EXPECTED_COUNT = 6
    module.RUN_SCOPE = "rolling-wave-next-20260727/run-window-3-33-20260727/subagent-luna-resume-1/shard-4"
    return module.main()


if __name__ == "__main__":
    raise SystemExit(main())
