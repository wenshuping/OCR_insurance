import crypto from 'node:crypto';

const ALLOWED_OPERATION_TYPES = new Set([
  'edit_chunk', 'split_chunk', 'merge_chunks', 'add_source_elements',
  'remove_source_elements', 'exclude_chunk', 'create_relation', 'remove_relation',
]);

function text(value) {
  return String(value ?? '').trim();
}

function uniqueText(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function normalizedPayload(chunk) {
  return chunk?.payload && typeof chunk.payload === 'object' && !Array.isArray(chunk.payload) ? chunk.payload : {};
}

function withContent(chunk, content, correction = {}) {
  const normalized = text(content);
  return {
    ...chunk,
    content: normalized,
    contentHash: crypto.createHash('sha256').update(normalized).digest('hex'),
    payload: {
      ...normalizedPayload(chunk),
      manualCorrection: {
        ...(normalizedPayload(chunk).manualCorrection || {}),
        ...correction,
      },
    },
  };
}

export function normalizeProductDocumentCorrectionOperations(operations = []) {
  return (Array.isArray(operations) ? operations : []).flatMap((operation) => {
    const type = text(operation?.type);
    if (!ALLOWED_OPERATION_TYPES.has(type)) return [];
    const normalized = { type };
    if (text(operation?.targetChunkId)) normalized.targetChunkId = text(operation.targetChunkId);
    const targetChunkIds = uniqueText(operation?.targetChunkIds);
    if (targetChunkIds.length) normalized.targetChunkIds = targetChunkIds;
    const elementIds = uniqueText(operation?.elementIds);
    if (elementIds.length) normalized.elementIds = elementIds;
    if (text(operation?.content)) normalized.content = text(operation.content);
    if (text(operation?.splitAtText)) normalized.splitAtText = text(operation.splitAtText);
    if (text(operation?.relationType)) normalized.relationType = text(operation.relationType);
    if (text(operation?.relatedChunkId)) normalized.relatedChunkId = text(operation.relatedChunkId);
    return [normalized];
  });
}

export function buildProductDocumentCorrectionPlan(input = {}) {
  const reasonCode = text(input.reasonCode);
  const targetChunkIds = uniqueText(input.targetChunkIds);
  const sourceElementIds = uniqueText(input.sourceElementIds);
  const operations = normalizeProductDocumentCorrectionOperations(input.operations);
  if (!operations.length && targetChunkIds[0] && sourceElementIds.length && ['missing_content', 'semantic_incomplete', 'ocr_error'].includes(reasonCode)) {
    operations.push({ type: 'add_source_elements', targetChunkId: targetChunkIds[0], elementIds: sourceElementIds });
  }
  if (!operations.length && targetChunkIds[0] && reasonCode === 'content_extra' && sourceElementIds.length) {
    operations.push({ type: 'remove_source_elements', targetChunkId: targetChunkIds[0], elementIds: sourceElementIds });
  }
  return {
    reasonCode,
    note: text(input.note),
    scope: text(input.scope) || 'current_chunk',
    operations,
    requiresConfirmation: true,
  };
}

function sourceElementsById(pages) {
  return new Map((Array.isArray(pages) ? pages : []).flatMap((page) => (
    Array.isArray(page?.layout?.elements) ? page.layout.elements : []
  )).map((element) => [text(element?.id), element]));
}

export function applyChunkCorrectionOperations({ chunks = [], pages = [], operations = [] } = {}) {
  let result = (Array.isArray(chunks) ? chunks : []).map((chunk) => ({ ...chunk, payload: { ...normalizedPayload(chunk) } }));
  const elements = sourceElementsById(pages);
  for (const operation of normalizeProductDocumentCorrectionOperations(operations)) {
    if (operation.type === 'exclude_chunk') {
      result = result.map((chunk) => chunk.id === operation.targetChunkId ? { ...chunk, indexStatus: 'blocked', payload: { ...normalizedPayload(chunk), manualCorrection: { type: 'exclude_chunk' } } } : chunk);
      continue;
    }
    if (operation.type === 'edit_chunk') {
      result = result.map((chunk) => chunk.id === operation.targetChunkId ? withContent(chunk, operation.content, { type: 'edit_chunk' }) : chunk);
      continue;
    }
    if (operation.type === 'add_source_elements') {
      const selected = operation.elementIds.map((id) => elements.get(id)).filter(Boolean);
      const addedText = selected.map((element) => text(element?.text || element?.caption)).filter(Boolean);
      result = result.map((chunk) => {
        if (chunk.id !== operation.targetChunkId || !addedText.length) return chunk;
        const existing = text(chunk.content);
        const additions = addedText.filter((value) => !existing.includes(value));
        return withContent(chunk, [...additions, existing].filter(Boolean).join('\n'), {
          type: 'add_source_elements',
          elementIds: operation.elementIds,
        });
      });
      continue;
    }
    if (operation.type === 'remove_source_elements') {
      const removedText = operation.elementIds.map((id) => text(elements.get(id)?.text || elements.get(id)?.caption)).filter(Boolean);
      result = result.map((chunk) => chunk.id === operation.targetChunkId
        ? withContent(chunk, removedText.reduce((content, value) => content.replaceAll(value, ''), text(chunk.content)), { type: 'remove_source_elements', elementIds: operation.elementIds })
        : chunk);
      continue;
    }
    if (operation.type === 'split_chunk') {
      const index = result.findIndex((chunk) => chunk.id === operation.targetChunkId);
      if (index < 0) continue;
      const chunk = result[index];
      const splitAt = text(operation.splitAtText);
      const position = splitAt ? text(chunk.content).indexOf(splitAt) : -1;
      if (position <= 0) continue;
      const first = withContent({ ...chunk, id: `${chunk.id}_split_1` }, text(chunk.content).slice(0, position), { type: 'split_chunk', sourceChunkId: chunk.id });
      const second = withContent({ ...chunk, id: `${chunk.id}_split_2` }, text(chunk.content).slice(position), { type: 'split_chunk', sourceChunkId: chunk.id });
      result.splice(index, 1, first, second);
      continue;
    }
    if (operation.type === 'merge_chunks') {
      const selected = operation.targetChunkIds.map((id) => result.find((chunk) => chunk.id === id)).filter(Boolean);
      if (selected.length < 2) continue;
      const firstIndex = Math.min(...selected.map((chunk) => result.indexOf(chunk)));
      const merged = withContent({
        ...selected[0],
        id: `${selected[0].id}_merged`,
        pageStart: Math.min(...selected.map((chunk) => Number(chunk.pageStart || 0))),
        pageEnd: Math.max(...selected.map((chunk) => Number(chunk.pageEnd || 0))),
      }, selected.map((chunk) => chunk.content).join('\n'), { type: 'merge_chunks', sourceChunkIds: operation.targetChunkIds });
      result = result.filter((chunk) => !operation.targetChunkIds.includes(chunk.id));
      result.splice(firstIndex, 0, merged);
      continue;
    }
    if (operation.type === 'create_relation' || operation.type === 'remove_relation') {
      result = result.map((chunk) => {
        if (chunk.id !== operation.targetChunkId || !operation.relatedChunkId) return chunk;
        const payload = normalizedPayload(chunk);
        const semantic = payload.semantic && typeof payload.semantic === 'object' ? payload.semantic : {};
        const current = uniqueText(semantic.requiredContextChunkIds);
        const next = operation.type === 'create_relation'
          ? uniqueText([...current, operation.relatedChunkId])
          : current.filter((id) => id !== operation.relatedChunkId);
        return { ...chunk, payload: { ...payload, semantic: { ...semantic, requiredContextChunkIds: next } } };
      });
    }
  }
  return result.filter((chunk) => text(chunk.content));
}

