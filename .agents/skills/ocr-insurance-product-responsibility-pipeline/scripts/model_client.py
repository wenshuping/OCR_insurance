#!/usr/bin/env python3
"""Small OpenAI-compatible client for responsibility extraction models."""

import json
from urllib import error, parse, request


DEFAULT_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}


class ModelRequestError(RuntimeError):
    def __init__(self, provider, status_code, detail):
        self.provider = provider
        self.status_code = status_code
        self.detail = detail
        self.failure_class = model_failure_class(status_code)
        self.retryable = status_code in {408, 409, 425, 429} or status_code >= 500
        super().__init__(f"{provider} model request failed: HTTP {status_code}: {detail}")


def model_failure_class(status_code):
    if status_code == 402:
        return "model_billing"
    if status_code in {401, 403}:
        return "model_auth_or_permission"
    if status_code == 429:
        return "model_rate_limit"
    if status_code >= 500:
        return "model_upstream"
    return "model_request"


def chat_completions_url(provider, base_url=""):
    base = (base_url or DEFAULT_BASE_URLS.get(provider) or "").rstrip("/")
    if not base:
        raise ValueError("base URL is required for an openai-compatible provider")
    parsed = parse.urlparse(base)
    if parsed.hostname and parsed.hostname.endswith(".maas.aliyuncs.com") and parsed.path.rstrip("/") == "/api/v1":
        base = parse.urlunparse(parsed._replace(path="/compatible-mode/v1"))
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def call_model(
    api_key,
    model,
    messages,
    *,
    provider="deepseek",
    base_url="",
    max_tokens=65536,
    response_format=None,
    timeout=300,
    return_metadata=False,
):
    body = {
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": max_tokens,
        "response_format": response_format or {"type": "json_object"},
    }
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    http_request = request.Request(
        chat_completions_url(provider, base_url),
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with request.urlopen(http_request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as http_error:
        detail = http_error.read().decode("utf-8", errors="replace").strip()
        raise ModelRequestError(provider, http_error.code, detail[:1000] or http_error.reason) from http_error
    choice = body["choices"][0]
    content = choice["message"]["content"]
    if return_metadata:
        return {
            "content": content,
            "finish_reason": choice.get("finish_reason"),
            "usage": body.get("usage") or {},
        }
    return content
