#!/usr/bin/env python3
import json
import os
import shutil
import sys
import traceback
from pathlib import Path

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")


def fail(message: str, code: int = 1) -> None:
    sys.stderr.write(f"{message}\n")
    raise SystemExit(code)


def parse_args(argv: list[str]) -> dict:
    parsed = {
        "warmup": False,
        "input": "",
        "output_dir": "",
        "positional": [],
    }

    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--warmup":
            parsed["warmup"] = True
        elif item == "--input":
            if index + 1 < len(argv):
                parsed["input"] = argv[index + 1]
                index += 1
        elif item.startswith("--input="):
            parsed["input"] = item[len("--input="):]
        elif item == "--output-dir":
            if index + 1 < len(argv):
                parsed["output_dir"] = argv[index + 1]
                index += 1
        elif item.startswith("--output-dir="):
            parsed["output_dir"] = item[len("--output-dir="):]
        elif not item.startswith("--"):
            parsed["positional"].append(item)
        index += 1

    if not parsed["input"] and parsed["positional"]:
        parsed["input"] = parsed["positional"][0]
    return parsed


def load_input_path(args: dict) -> Path:
    raw = str(args.get("input") or "").strip()
    if not raw:
        fail("POLICY_STRUCTUREV3_INPUT_REQUIRED")
    input_path = Path(raw).expanduser().resolve()
    if not input_path.exists():
        fail("POLICY_STRUCTUREV3_INPUT_NOT_FOUND")
    return input_path


def load_output_dir(args: dict) -> Path:
    raw = str(args.get("output_dir") or "").strip()
    if not raw:
        fail("POLICY_STRUCTUREV3_OUTPUT_REQUIRED")
    output_dir = Path(raw).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "")


def bootstrap_project_dir() -> None:
    project_dir = os.environ.get("POLICY_OCR_PADDLE_PROJECT_DIR", "").strip()
    if project_dir and project_dir not in sys.path:
        sys.path.insert(0, project_dir)


def resolve_device() -> str:
    return (
        os.environ.get("POLICY_OCR_STRUCTUREV3_DEVICE")
        or os.environ.get("POLICY_OCR_PADDLE_DEVICE")
        or "gpu"
    ).strip() or "gpu"


def materialize(value):
    if callable(value):
        try:
            return value()
        except Exception:
            return None
    return value


def safe_attr(item, name: str):
    try:
        return getattr(item, name)
    except Exception:
        return None


def to_jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(item) for item in value]
    if hasattr(value, "tolist"):
        try:
            return to_jsonable(value.tolist())
        except Exception:
            return str(value)
    if hasattr(value, "__dict__"):
        return to_jsonable(vars(value))
    return str(value)


def result_list(results) -> list:
    if results is None:
        return []
    if isinstance(results, (str, bytes, dict)):
        return [results]
    if isinstance(results, list):
        return results
    if isinstance(results, tuple):
        return list(results)
    try:
        return list(results)
    except TypeError:
        return [results]


def collect_result_payloads(results: list) -> list:
    payloads = []
    for item in results:
        payload = materialize(safe_attr(item, "json"))
        if payload is None:
            payload = materialize(safe_attr(item, "res"))
        if payload is None:
            payload = item
        payloads.append(to_jsonable(payload))
    return payloads


def find_first_file(root: Path, suffix: str) -> Path | None:
    matches = sorted(root.rglob(f"*{suffix}"))
    return matches[0] if matches else None


def copy_generated_file(source: Path | None, target: Path) -> bool:
    if not source or not source.exists():
        return False
    shutil.copyfile(source, target)
    return True


def read_generated_json(source: Path | None):
    if not source or not source.exists():
        return None
    try:
        return json.loads(source.read_text(encoding="utf-8"))
    except Exception:
        return None


def raw_payload(device: str, result_payloads: list, generated_payload=None) -> dict:
    results = result_payloads
    if generated_payload is not None:
        results = [generated_payload] if not result_payloads else result_payloads

    payload = {
        "ok": True,
        "pipeline": "pp_structurev3",
        "device": device,
        "results": results,
    }
    if isinstance(generated_payload, dict):
        return {**generated_payload, **payload}
    if generated_payload is not None:
        payload["generatedJson"] = generated_payload
    return payload


def write_raw_json(target: Path, payload: dict) -> None:
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def warmup() -> None:
    try:
        from paddleocr import PPStructureV3  # noqa: F401
    except Exception:
        fail("POLICY_STRUCTUREV3_IMPORT_FAILED")
    sys.stdout.write(json.dumps({"ok": True, "warmup": True, "pipeline": "pp_structurev3"}, ensure_ascii=False))


def main() -> None:
    args = parse_args(sys.argv[1:])
    bootstrap_project_dir()

    if args["warmup"]:
        warmup()
        return

    input_path = load_input_path(args)
    output_dir = load_output_dir(args)
    raw_json_path = output_dir / "raw.structurev3.json"
    raw_md_path = output_dir / "raw.structurev3.md"
    generated_dir = output_dir / "_structurev3-generated"
    generated_dir.mkdir(parents=True, exist_ok=True)

    try:
        from paddleocr import PPStructureV3
    except Exception:
        fail("POLICY_STRUCTUREV3_IMPORT_FAILED")

    device = resolve_device()

    try:
        pipeline = PPStructureV3(
            device=device,
            use_doc_orientation_classify=env_flag("POLICY_OCR_STRUCTUREV3_USE_DOC_ORIENTATION_CLASSIFY", True),
            use_doc_unwarping=env_flag("POLICY_OCR_STRUCTUREV3_USE_DOC_UNWARPING", True),
            use_textline_orientation=env_flag("POLICY_OCR_STRUCTUREV3_USE_TEXTLINE_ORIENTATION", True),
            use_formula_recognition=env_flag("POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION", False),
            use_chart_recognition=env_flag("POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION", False),
        )
        results = result_list(pipeline.predict(str(input_path)))
        result_payloads = collect_result_payloads(results)

        for item in results:
            save_json = safe_attr(item, "save_to_json")
            if callable(save_json):
                save_json(save_path=str(generated_dir))
            save_markdown = safe_attr(item, "save_to_markdown")
            if callable(save_markdown):
                save_markdown(save_path=str(generated_dir))

        generated_json = find_first_file(generated_dir, ".json")
        generated_md = find_first_file(generated_dir, ".md")
        if generated_json:
            copy_generated_file(generated_json, raw_json_path)
        generated_payload = read_generated_json(generated_json)
        write_raw_json(raw_json_path, raw_payload(device, result_payloads, generated_payload))

        copied_markdown = copy_generated_file(generated_md, raw_md_path)
        if not copied_markdown:
            raw_md_path.write_text("", encoding="utf-8")
    except Exception:
        traceback.print_exc(file=sys.stderr)
        fail("POLICY_STRUCTUREV3_RUNTIME_FAILED")

    status = {
        "ok": True,
        "pipeline": "pp_structurev3",
        "device": device,
        "rawJsonPath": str(raw_json_path),
        "rawMarkdownPath": str(raw_md_path),
    }
    sys.stdout.write(json.dumps(status, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
