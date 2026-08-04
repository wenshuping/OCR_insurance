import json
import os
from pathlib import Path


def _canonical(value: str | os.PathLike[str]) -> Path:
    return Path(value).expanduser().resolve(strict=False)


def _configured_development_database(project_root: Path) -> str:
    config_path = project_root / ".runtime" / "local" / "policy-ocr-env.json"
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
        return str(payload.get("POLICY_OCR_APP_DB_PATH") or "").strip()
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return ""


def resolve_policy_ocr_write_database(
    project_root: str | os.PathLike[str],
    requested_path: str = "",
    profile: str = "",
) -> str:
    root = _canonical(project_root)
    legacy_path = _canonical(root / ".runtime" / "local" / "policy-ocr.sqlite")
    configured_development_path = (
        _configured_development_database(root)
        or str(os.environ.get("POLICY_OCR_APP_DB_PATH") or "").strip()
        or str(Path.home() / "OCR_insurance_ssd" / ".runtime" / "local" / "policy-ocr.sqlite")
    )
    expected_development_path = _canonical(configured_development_path)
    target_profile = str(profile or os.environ.get("POLICY_OCR_PROFILE") or "").strip().lower()
    is_production = target_profile in {"prod", "production"} or (
        not target_profile and os.environ.get("NODE_ENV") == "production"
    )

    if is_production:
        target = _canonical(
            requested_path
            or os.environ.get("POLICY_OCR_APP_DB_PATH")
            or root / ".runtime" / "policy-ocr.sqlite"
        )
        if target == legacy_path:
            raise RuntimeError(f"已拒绝写入旧开发数据库: {target}")
        if target == expected_development_path:
            raise RuntimeError(f"生产发布不得写入开发 SSD 数据库: {target}")
        return str(target)

    target = _canonical(requested_path or expected_development_path)
    if target == legacy_path:
        raise RuntimeError(f"已拒绝写入旧开发数据库: {target}")
    if target != expected_development_path:
        raise RuntimeError(
            "开发写入目标与配置的 SSD 数据库不一致: "
            f"configured={expected_development_path} requested={target}"
        )
    return str(target)
