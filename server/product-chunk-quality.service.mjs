function text(value) {
  return String(value ?? '').trim();
}

function result(code, status, message) {
  return { code, status, message };
}

function assessChunk(chunk, duplicateHashes) {
  const content = text(chunk?.content);
  const confidence = chunk?.payload?.confidence && typeof chunk.payload.confidence === 'object'
    ? chunk.payload.confidence
    : null;
  const checks = [];
  if (!content) checks.push(result('empty_content', 'blocked', '切片内容为空'));
  if (!Number(chunk?.pageStart) || !Number(chunk?.pageEnd)) {
    checks.push(result('missing_page_reference', 'blocked', '切片缺少有效页码'));
  }
  if (text(chunk?.chunkType) === 'table' && !/[\p{L}\p{Script=Han}]/u.test(content)) {
    checks.push(result('isolated_table_values', 'blocked', '表格切片只包含孤立数值'));
  }
  if (text(chunk?.chunkType) !== 'parent' && Number(chunk?.tokenCount || 0) < 4) {
    checks.push(result('very_short_content', 'warning', '切片内容过短，需要人工确认上下文'));
  }
  if (chunk?.ocrConfidence != null && Number(chunk.ocrConfidence) < 0.7) {
    checks.push(result('low_ocr_confidence', 'warning', '切片OCR置信度低于0.7'));
  }
  if (confidence?.decision === 'blocked') {
    checks.push(result('low_critical_fact_confidence', 'blocked', '切片中的关键数字或保险事实识别置信度不足'));
  } else if (confidence?.decision === 'review_required') {
    checks.push(result('evidence_confidence_review_required', 'warning', '切片识别置信度需要人工复核'));
  }
  const hash = text(chunk?.contentHash);
  if (text(chunk?.chunkType) !== 'parent' && hash && duplicateHashes.has(hash)) {
    checks.push(result('duplicate_content', 'blocked', '切片内容与同一文档中的其他切片重复'));
  }
  if (text(chunk?.chunkType) !== 'parent' && hash) duplicateHashes.add(hash);
  return checks;
}

export function assessProductChunksQuality(chunks = []) {
  const duplicateHashes = new Set();
  const assessedChunks = (Array.isArray(chunks) ? chunks : []).map((chunk) => {
    const checks = assessChunk(chunk, duplicateHashes);
    const blocked = checks.some((item) => item.status === 'blocked');
    const warning = checks.some((item) => item.status === 'warning');
    return {
      ...chunk,
      indexStatus: blocked ? 'blocked' : text(chunk?.indexStatus) || 'ready',
      payload: {
        ...(chunk?.payload && typeof chunk.payload === 'object' ? chunk.payload : {}),
        quality: {
          decision: blocked ? 'blocked' : warning ? 'review_required' : 'pass',
          checks,
          qualityRuleVersion: 'product-chunk-quality-v2',
        },
      },
    };
  });
  const blockedChunkCount = assessedChunks.filter((chunk) => chunk.indexStatus === 'blocked').length;
  const reviewChunkCount = assessedChunks.filter((chunk) => chunk?.payload?.quality?.decision === 'review_required').length;
  return { chunks: assessedChunks, blockedChunkCount, reviewChunkCount, qualityRuleVersion: 'product-chunk-quality-v2' };
}
