# Source Contract

Emit one JSON manifest per product:

```json
{
  "company": "",
  "productName": "",
  "sourceStatus": "source_ready",
  "sourceUrl": "",
  "discoveryUrl": "",
  "sourceTitle": "",
  "officialHost": "",
  "retrievalMethod": "local_archive|company_adapter|direct|headless_real_chrome|browser|cdp|cloakbrowser|crawl4ai|firecrawl|screenshot_ocr",
  "directHttpStatus": null,
  "retrievedAt": "",
  "sourceDigest": "sha256:<64 lowercase hex>",
  "sourceFile": "",
  "extractedTextFile": "",
  "responsibilityTextFile": "",
  "responsibilityPages": [],
  "referencedTablePages": [],
  "screenshots": [],
  "pdf": {
    "pages": 0,
    "encrypted": false,
    "encryption": "",
    "emptyPasswordDecryptable": false
  },
  "identityEvidence": {
    "company": "",
    "productName": "",
    "version": ""
  },
  "attempts": [
    {
      "method": "direct",
      "result": "blocked_403",
      "status": 403,
      "evidencePath": ""
    }
  ],
  "blockers": []
}
```

Allowed `sourceStatus`:

- `source_ready`: exact official source and readable responsibility evidence.
- `ocr_needs_review`: official raster source obtained but OCR/table fidelity is
  unresolved.
- `source_blocked`: access, identity, bytes, or official-host proof failed.

## Required Relationships

- `sourceFile` contains unchanged official bytes or an unchanged official HTML
  snapshot.
- `extractedTextFile` contains complete extraction from that source.
- `responsibilityTextFile` contains the responsibility chapter and necessary
  adjacent evidence, not a model summary.
- Every screenshot path maps to a rendered official page or raster source page.
- `attempts` records failed routes so later runs do not repeat the same route
  without changed conditions.

## Handoff Gate

Only `source_ready` may automatically enter responsibility parsing.
`ocr_needs_review` requires image/text verification. `source_blocked` remains in
the retry queue with its exact blocker and next lawful route.
