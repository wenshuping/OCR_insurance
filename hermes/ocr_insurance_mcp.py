#!/usr/bin/env python3
import json
import os
import sqlite3
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from mcp.server.fastmcp import FastMCP


mcp = FastMCP("ocr-insurance")


def local_settings() -> dict:
    settings = dict(os.environ)
    env_path = Path(__file__).resolve().parents[1] / ".env.local"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            settings.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    return settings


def configured_principal(settings: dict) -> str:
    supplied = settings.get("OCR_INSURANCE_DING_USER_ID", "").strip()
    if supplied:
        return supplied
    db_path = settings.get("OCR_INSURANCE_DB_PATH", "").strip()
    if not db_path:
        return ""
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "select ding_user_id from user_dingtalk_identities where status = 'active' limit 2"
        ).fetchall()
    return str(rows[0][0]).strip() if len(rows) == 1 else ""


def invoke(tool: str, input_data: dict) -> dict:
    settings = local_settings()
    api_base = settings.get("DINGTALK_CHANNEL_API_BASE_URL", "http://127.0.0.1:4207").rstrip("/")
    token = settings.get("DINGTALK_IDENTITY_SERVICE_TOKEN", "").strip()
    corp_id = settings.get("DINGTALK_CORP_ID", "").strip()
    ding_user_id = configured_principal(settings)
    if not token or not corp_id or not ding_user_id:
        raise RuntimeError("OCR_INSURANCE_MCP_IDENTITY_NOT_CONFIGURED")
    body = json.dumps({
        "corpId": corp_id,
        "dingUserId": ding_user_id,
        "conversationType": "direct",
        "requestId": str(uuid.uuid4()),
        "tool": tool,
        "input": input_data,
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{api_base}/api/wukong/mcp",
        data=body,
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            code = json.loads(error.read().decode("utf-8")).get("code", "OCR_INSURANCE_TOOL_FAILED")
        except Exception:
            code = "OCR_INSURANCE_TOOL_FAILED"
        raise RuntimeError(code) from None
    return payload["result"]


@mcp.tool()
def list_accessible_families() -> dict:
    """列出当前顾问有权限访问的家庭。先调用此工具解析用户所说的家庭名称或序号。"""
    return invoke("list_accessible_families", {})


@mcp.tool()
def get_family_context(family_ref: int) -> dict:
    """读取一个家庭的脱敏摘要、成员数量、保单数量和保单列表。"""
    return invoke("get_family_context", {"familyRef": family_ref})


@mcp.tool()
def ask_sales_champion(family_ref: int, question: str) -> dict:
    """针对指定家庭回答保障缺口、销售建议、异议处理和跟进问题。"""
    return invoke("ask_sales_champion", {"familyRef": family_ref, "question": question})


@mcp.tool()
def ask_insurance_expert(question: str, policy_ref: int | None = None) -> dict:
    """回答保险责任、条款、等待期、免责、续保或具体保单问题。"""
    input_data = {"question": question}
    if policy_ref is not None:
        input_data["policyRef"] = policy_ref
    return invoke("ask_insurance_expert", input_data)


if __name__ == "__main__":
    mcp.run(transport="stdio")
