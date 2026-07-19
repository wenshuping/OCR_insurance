function text(value) {
  return String(value ?? '').trim();
}

function fail(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function uniqueLines(...values) {
  const result = [];
  const seen = new Set();
  for (const line of values.flatMap((value) => text(value).split('\n')).map(text).filter(Boolean)) {
    const key = line.replace(/\s+/gu, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result;
}

function visualTables(result = {}, extractionMethod = 'paddleocr_vl16') {
  return (Array.isArray(result.tables) ? result.tables : []).flatMap((table, index) => {
    const headers = Array.isArray(table?.headers) ? table.headers.map(text) : [];
    const rows = Array.isArray(table?.rows) ? table.rows.map((row) => Array.isArray(row) ? row.map(text) : []) : [];
    const allRows = [headers, ...rows].filter((row) => row.some(Boolean));
    if (!allRows.length) return [];
    return [{
      text: allRows.map((row) => row.join(' | ')).join('\n'),
      rows: allRows,
      metadata: { kind: 'visual_table', tableIndex: index, extractionMethod, source: text(table?.source) },
    }];
  });
}

function visualElements(result = {}) {
  const boxes = Array.isArray(result.boxes) ? result.boxes : [];
  if (boxes.length) {
    return boxes.flatMap((box) => {
      const content = text(box?.text);
      if (!content) return [];
      return [{
        kind: text(box?.blockType) || 'text',
        text: content,
        bbox: Array.isArray(box?.box) ? box.box.map(Number) : null,
        confidence: Number.isFinite(Number(box?.confidence)) ? Number(box.confidence) : null,
        source: 'paddleocr_vl16',
      }];
    });
  }
  return (Array.isArray(result.blocks) ? result.blocks : []).flatMap((block) => {
    const content = text(block?.content || (Array.isArray(block?.lines) ? block.lines.join('\n') : ''));
    if (!content) return [];
    return [{ kind: text(block?.type) || 'text', text: content, bbox: Array.isArray(block?.box) ? block.box.map(Number) : null, source: 'paddleocr_vl16' }];
  });
}

export function mergeProductSlideVisualEvidence(page = {}, result = {}, reconstruction = {}) {
  const nativeText = text(page.rawText);
  const ocrText = text(result.ocrText);
  if (!ocrText) throw fail('PRODUCT_PPT_PADDLE_VL16_EMPTY', `第 ${page.pageNo} 页 PaddleOCR-VL 1.6 未返回可用内容`);
  const nativeElements = nativeText.split('\n').map(text).filter(Boolean).map((line) => ({ kind: 'text', text: line, bbox: null, source: 'pptx_native' }));
  const reconstructedText = text(reconstruction.canonicalMarkdown);
  if (!reconstructedText) throw fail('PRODUCT_PPT_DEEPSEEK_EMPTY', `第 ${page.pageNo} 页 DeepSeek 未返回结构化内容`);
  const tables = visualTables({ tables: reconstruction.tables }, 'deepseek_reconstruction');
  const paddleTables = visualTables(result);
  const retainedNativeTables = (Array.isArray(page.tables) ? page.tables : [])
    .filter((table) => text(table?.metadata?.extractionMethod) !== 'pptx_xml');
  return {
    ...page,
    rawText: uniqueLines(reconstructedText, nativeText, ocrText).join('\n'),
    tables: tables.length ? [...tables, ...retainedNativeTables] : [...paddleTables, ...retainedNativeTables],
    layout: {
      ...(page.layout && typeof page.layout === 'object' ? page.layout : {}),
      elements: [...nativeElements, ...visualElements(result)],
      nativeExtraction: { text: nativeText, characterCount: [...nativeText].length, parser: 'pptx_native' },
      visualExtraction: {
        provider: text(result.provider) || 'paddleocr_vl16_autodl',
        model: text(result.model),
        promptVersion: text(result.promptVersion) || 'product-ppt-paddle-vl16-v1',
        markdown: text(result.markdown),
        boxes: Array.isArray(result.boxes) ? result.boxes : [],
        tables: Array.isArray(result.tables) ? result.tables : [],
        characterCount: [...ocrText].length,
        blockCount: Array.isArray(result.blocks) ? result.blocks.length : 0,
        tableCount: paddleTables.length,
      },
      semanticReconstruction: {
        model: text(reconstruction.model),
        version: 'product-ppt-reconstruction-v1',
        issues: Array.isArray(reconstruction.issues) ? reconstruction.issues : [],
        canonicalMarkdown: reconstructedText,
      },
      extraction: { method: 'pptx_native+paddleocr_vl16', incomplete: false, needsVisualOcr: false },
    },
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function enrichPptxWithPaddleVisual(input = {}) {
  const parsed = input.parsed || {};
  const pages = Array.isArray(parsed.pages) ? parsed.pages : [];
  if (!pages.length) throw fail('PRODUCT_PPT_NO_PAGES', 'PPT 没有可处理的幻灯片');
  if (typeof input.renderPages !== 'function' || typeof input.parsePage !== 'function' || typeof input.reconstructPage !== 'function') {
    throw fail('PRODUCT_PPT_PIPELINE_UNAVAILABLE', 'PPT PaddleOCR-VL 1.6 与 DeepSeek 处理链路未配置', 503);
  }
  const images = await input.renderPages(input.document);
  if (!Array.isArray(images) || images.length < pages.length) {
    throw fail('PRODUCT_PPT_RENDER_INCOMPLETE', 'PPT 页面图片渲染不完整');
  }
  const enrichedPages = await mapWithConcurrency(pages, 2, async (page, index) => {
    const image = Buffer.from(images[Number(page.pageNo || index + 1) - 1] || []);
    if (!image.length) throw fail('PRODUCT_PPT_RENDER_INCOMPLETE', `第 ${page.pageNo} 页图片渲染失败`);
    const result = await input.parsePage({
      documentId: text(input.document?.id),
      pageNo: Number(page.pageNo),
      nativeText: text(page.rawText),
      promptVersion: 'product-ppt-paddle-vl16-v1',
      uploadItem: {
        name: `slide-${page.pageNo}.png`,
        type: 'image/png',
        size: image.length,
        dataUrl: `data:image/png;base64,${image.toString('base64')}`,
      },
    });
    const reconstruction = await input.reconstructPage({
      pageNo: Number(page.pageNo),
      nativeText: text(page.rawText),
      paddleOcrText: text(result.ocrText),
      paddleMarkdown: text(result.markdown),
      paddleTables: Array.isArray(result.tables) ? result.tables : [],
      paddleBoxes: Array.isArray(result.boxes) ? result.boxes : [],
    });
    return mergeProductSlideVisualEvidence(page, result, reconstruction);
  });
  return {
    ...parsed,
    parser: `${text(parsed.parser) || 'pptx-native'}+paddleocr-vl16`,
    pages: enrichedPages,
    visualQuality: {
      decision: 'pass',
      visualPageCount: enrichedPages.length,
      totalPageCount: pages.length,
      nativeTextRetention: 1,
      ruleVersion: 'product-slide-quality-v1',
    },
  };
}
