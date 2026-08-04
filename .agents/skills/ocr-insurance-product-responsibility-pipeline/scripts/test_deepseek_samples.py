#!/usr/bin/env python3
"""Manual integration test for the responsibility pipeline with DeepSeek.

This script never writes product data to SQLite. It stores model artifacts and
validator receipts only in the requested output directory.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib import parse, request


SAMPLES = {
    "endowment": {
        "company": "新华人寿保险股份有限公司",
        "product": "成长阳光少儿两全保险（A款）（分红型）",
        "source_url": "https://static-cdn.newchinalife.com/ncl/pdf/20230630/8ee394d7-3c7b-4b7c-9404-00cdbc11ec2b.pdf",
        "domain": "newchinalife.com",
        "source_document": "xinhua-chengzhang-yangguang-a-clause.pdf",
        "source_text": "xinhua-chengzhang-yangguang-a-clause.pages.txt",
    },
    "term": {
        "company": "中韩人寿保险有限公司",
        "product": "中韩全意畅行两全保险",
        "source_url": "https://www.sinokorealife.com.cn/u/cms/www/202311/0216255918tw.pdf",
        "domain": "sinokorealife.com.cn",
        "source_document": "sinokorea-quanyi-changxing-terms-20260721.pdf",
        "source_text": "sinokorea-quanyi-changxing-terms-20260721.pages.txt",
    },
    "medical": {
        "company": "东方嘉富人寿保险有限公司",
        "product": "东方嘉富互联网菁英悠享高端医疗保险",
        "source_url": "https://www.sinokorealife.com.cn/u/cms/www/202505/21100321wazt.pdf",
        "domain": "sinokorealife.com.cn",
        "source_document": "sinokorea-internet-jingying-youxiang-medical-terms-20260721.pdf",
        "source_text": "sinokorea-internet-jingying-youxiang-medical-terms-20260721.pages.txt",
    },
    "critical_illness": {
        "company": "新华人寿保险股份有限公司",
        "product": "瑞康D款团体终身重大疾病保险",
        "source_url": "https://static-cdn.newchinalife.com/ncl/pdf/20260512/afa5e6ab-9828-40ba-91ff-5b2b03271ee2.pdf",
        "domain": "newchinalife.com",
        "source_document": "xinhua-ruikang-d-group-ci-terms-20260721.pdf",
        "source_text": "xinhua-ruikang-d-group-ci-terms-20260721.pages.txt",
    },
}


def load_env(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def extract_json(content):
    text = str(content or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    decoder = json.JSONDecoder()
    for index, character in enumerate(text):
        if character != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("DeepSeek response did not contain a JSON object")


def chat_completions_url(base_url=""):
    base = (base_url or "https://api.deepseek.com").rstrip("/")
    parsed = parse.urlparse(base)
    if parsed.hostname and parsed.hostname.endswith(".maas.aliyuncs.com") and parsed.path.rstrip("/") == "/api/v1":
        base = parse.urlunparse(parsed._replace(path="/compatible-mode/v1"))
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def call_deepseek(api_key, model, messages, base_url=""):
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0,
        "max_tokens": 65536,
        "response_format": {"type": "json_object"},
    }, ensure_ascii=False).encode("utf-8")
    http_request = request.Request(
        chat_completions_url(base_url),
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with request.urlopen(http_request, timeout=300) as response:
        body = json.loads(response.read().decode("utf-8"))
    return body["choices"][0]["message"]["content"]


def validate(skill_dir, artifact_path, sample):
    command = [
        sys.executable,
        str(skill_dir / "scripts" / "validate_artifact.py"),
        "--artifact", str(artifact_path),
        "--source-document", str(sample["source_document_path"]),
        "--source-text", str(sample["source_text_path"]),
        "--official-domain", sample["domain"],
    ]
    return command, subprocess.run(command, capture_output=True, text=True, check=False)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample", action="append", choices=sorted(SAMPLES), required=True)
    parser.add_argument("--source-cache", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--model", default="")
    parser.add_argument("--repair-rounds", type=int, default=2)
    args = parser.parse_args(argv)

    skill_dir = Path(__file__).resolve().parent.parent
    skill_text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    env = load_env(args.env_file)
    api_key = os.environ.get("DEEPSEEK_API_KEY") or env.get("DEEPSEEK_API_KEY")
    if not api_key:
        print("DEEPSEEK_API_KEY is not configured", file=sys.stderr)
        return 2
    base_url = os.environ.get("DEEPSEEK_BASE_URL") or env.get("DEEPSEEK_BASE_URL") or ""
    model = args.model or os.environ.get("DEEPSEEK_MODEL") or env.get("DEEPSEEK_MODEL") or "deepseek-v4-flash"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary = []

    for sample_name in args.sample:
        sample = dict(SAMPLES[sample_name])
        sample["source_document_path"] = args.source_cache / sample["source_document"]
        sample["source_text_path"] = args.source_cache / sample["source_text"]
        source_text = sample["source_text_path"].read_text(encoding="utf-8")
        source_digest = "sha256:" + hashlib.sha256(sample["source_document_path"].read_bytes()).hexdigest()
        user_prompt = f"""
Use the selected pipeline rules below to independently parse this exact product.
Return one complete unified artifact as a JSON object only. Do not write prose.
Do not use a database or any prior artifact. Use only the supplied official text.

Hard facts:
- company: {sample['company']}
- productName: {sample['product']}
- official source URL: {sample['source_url']}
- official source digest: {source_digest}
- every sourceExcerpt must be copied as one exact contiguous passage from OFFICIAL_SOURCE_TEXT
- independently named child benefits must be separate responsibilities
- services belong in productServices; settlement/extension rules belong in productRules
- publication.sqlite and publication.feishu must be not_requested

PIPELINE_SKILL:
{skill_text}

OFFICIAL_SOURCE_TEXT:
{source_text}
""".strip()
        messages = [
            {"role": "system", "content": "You are a deterministic Chinese insurance contract parser. Output strict JSON only."},
            {"role": "user", "content": user_prompt},
        ]
        first_pass = None
        final_result = None
        artifact_path = args.output_dir / f"{sample_name}-deepseek-strict-artifact.json"
        for round_index in range(args.repair_rounds + 1):
            artifact = None
            content = ""
            parse_error = None
            for request_attempt in range(1, 4):
                content = call_deepseek(api_key, model, messages, base_url)
                try:
                    artifact = extract_json(content)
                    break
                except ValueError as error:
                    parse_error = error
                    (args.output_dir / f"{sample_name}-round-{round_index + 1}-attempt-{request_attempt}-raw.txt").write_text(
                        content,
                        encoding="utf-8",
                    )
            if artifact is None:
                raise parse_error
            (args.output_dir / f"{sample_name}-round-{round_index + 1}-raw.txt").write_text(
                content,
                encoding="utf-8",
            )
            artifact_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
            canonical_path = args.output_dir / f"{sample_name}-round-{round_index + 1}-canonical.json"
            canonical_result = subprocess.run(
                [
                    sys.executable,
                    str(skill_dir / "scripts" / "canonicalize_excerpts.py"),
                    "--artifact", str(artifact_path),
                    "--source-text", str(sample["source_text_path"]),
                    "--output", str(canonical_path),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            if canonical_result.returncode != 0:
                raise RuntimeError(canonical_result.stderr)
            artifact_path.write_text(canonical_path.read_text(encoding="utf-8"), encoding="utf-8")
            command, result = validate(skill_dir, artifact_path, sample)
            receipt = {
                "canonicalizerStdout": canonical_result.stdout,
                "command": command,
                "exitCode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
            (args.output_dir / f"{sample_name}-round-{round_index + 1}-validator.json").write_text(
                json.dumps(receipt, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            if first_pass is None:
                first_pass = result.returncode
            final_result = result
            if result.returncode == 0:
                break
            messages.extend([
                {"role": "assistant", "content": content},
                {
                    "role": "user",
                    "content": (
                        "The deterministic validator rejected the artifact. Repair the complete JSON using only "
                        "OFFICIAL_SOURCE_TEXT. Return JSON only. Do not remove real responsibilities merely to silence "
                        "the validator. For exact-excerpt failures, copy one contiguous passage verbatim instead of "
                        "paraphrasing. Every branch conditionText and evidence token must literally occur in its own "
                        f"indicator sourceExcerpt. Validator issues:\n{result.stderr}"
                    ),
                },
            ])
        summary.append({
            "sample": sample_name,
            "firstPassExitCode": first_pass,
            "finalExitCode": final_result.returncode,
            "responsibilityCount": len(json.loads(artifact_path.read_text(encoding="utf-8")).get("responsibilities", [])),
            "artifactPath": str(artifact_path),
        })

    summary_path = args.output_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if all(item["finalExitCode"] == 0 for item in summary) else 1


if __name__ == "__main__":
    raise SystemExit(main())
