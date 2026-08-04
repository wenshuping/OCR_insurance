# Crawler Routing

## Route Selection

Use the first successful official route. Do not run every expensive route.

| Observation | Route | Required evidence |
| --- | --- | --- |
| Existing official file and unchanged digest | local archive | URL, title, digest, readable chapter |
| Company has `crawl:*knowledge` script | company adapter | adapter result and official material URL |
| Official API/static page works | direct fetch | status, final URL, bytes/HTML |
| Public page needs real Chrome or official PDF is encrypted | `insurance-official-headless-pdf` | original bytes, digest, identity, encryption metadata, readable chapter |
| JavaScript or cookie-dependent page | Browser/Chrome | rendered identity, screenshot, discovered material URL |
| Direct 403/405/412 but public page renders | CDP/cloakbrowser | direct status plus rendered/download evidence |
| SPA pagination is difficult | crawl4ai | official pages, pagination receipt, structured output |
| Large official section needs discovery | firecrawl | official URL candidates, then first-party retrieval |
| CAPTCHA/SMS/login remains | stop | blocker screenshot and exact resume point |

## Existing Project Routes

Discover the current company command from `package.json` instead of inventing a
new crawler:

```bash
rg -n '"crawl:[^"]+knowledge"' package.json
```

The repository currently has dozens of insurer runners under
`scripts/crawl-*-knowledge.mjs`. Prefer the matching runner.

Known browser-oriented routes include:

```text
中国平安:
  npm run crawl:ping-an-knowledge
  npm run crawl:ping-an-cloak-knowledge

国联人寿:
  npm run crawl:guolian-life-cloak-knowledge

陆家嘴国泰:
  npm run crawl:cathay-life-cloak-knowledge
```

东吴人寿的历史资产路由迁移：

```text
旧路由: https://www.soochowlife.net/eportal/fileDir/cs/resource/<file>.pdf
当前披露页: https://www.soochowlife.net/cs/gkxxpl/jbxx/cpjbxx/index.html
优先资产路由: https://www.soochowlife.net/cs/resource/<file>.pdf
```

对东吴先从当前披露页按产品名称和版本发现条款链接，再验证静态 PDF。
不要把旧 `/eportal/` 地址的 403 直接重试成批量请求；先完成 20 条
source-only canary，且每条都通过产品身份、PDF 字节、责任章节和 SHA-256
门禁。发现换版时输出 `version_conflict`，不能用新版本冒充历史版本。

Some company runners, including Beijing Life and MetLife flows, already contain
their own cloakbrowser fallback. Read the matching runner before adding another
browser layer.

For a company without a runner:

1. Prove one exact product/material pair.
2. Use Browser/Chrome only for discovery and official download.
3. Reuse `server/scrapling-policy-crawler.py` for PDF/ZIP extraction.
4. Add a company adapter only when repeated scheduled crawling justifies code.

## Browser Evidence

When a browser route is necessary:

- Follow the available Browser or Chrome control skill.
- Capture a screenshot only after the page reaches a stable official state or a
  stable blocker.
- Save the rendered title, final URL, visible product name, and discovered
  material links.
- Do not inspect or export cookies, passwords, local storage, or unrelated tabs.
- Do not treat a screenshot of a search result as official evidence.

## Download Validation

For every downloaded material:

- Confirm the host belongs to the official disclosure flow.
- Confirm content type and file signature.
- Reject HTML verification pages saved with a `.pdf` suffix.
- Calculate SHA-256.
- Preserve source URL and browser page URL separately when the material was
  discovered through a rendered page.
- Keep original bytes unchanged; write extracted text to a separate file.
- For encrypted PDFs, try only the empty user password, preserve encryption
  metadata, and stop if a non-empty authorized password is required.

## Stop Conditions

Stop without further retries when:

- the rendered page still shows CAPTCHA, slider, SMS, or login;
- the product version cannot be distinguished;
- the downloaded bytes are not the claimed material;
- only unofficial copies remain;
- pagination end cannot be proved;
- OCR cannot reliably preserve a formula table.
