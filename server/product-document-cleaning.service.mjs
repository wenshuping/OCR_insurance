import crypto from 'node:crypto';

const CLEANING_VERSION = 'product-document-cleaning-v1';
const TERMINAL_PUNCTUATION = /[。！？；：.!?;:]$/u;
const STANDALONE_PAGE_NUMBER = /^(?:第\s*)?\d{1,5}\s*(?:页)?(?:\s*[/／]\s*\d{1,5})?$/u;
const LIST_OR_CLAUSE = /^(?:第[一二三四五六七八九十百千万\d]+[章节条款项]|[（(]?[一二三四五六七八九十\d]+[）).、．]|[-*•·])\s*/u;

function string(value) {
  return String(value ?? '');
}

function hash(value) {
  return crypto.createHash('sha256').update(string(value)).digest('hex');
}

function normalizeText(value) {
  return string(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, ' ')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function normalizedKey(value) {
  return normalizeText(value).replace(/\s+/gu, '').toLowerCase();
}

function elementText(element) {
  return normalizeText(element?.text || element?.caption);
}

function operation({ pageNo, rule, elementIds, before, after, decision = 'auto_applied' }) {
  return {
    pageNo,
    rule,
    elementIds: elementIds.filter(Boolean),
    before,
    after,
    beforeHash: hash(before),
    afterHash: hash(after),
    decision,
  };
}

function isHeading(line, element, page) {
  if (['heading', 'title'].includes(string(element?.kind).toLowerCase())) return true;
  if (LIST_OR_CLAUSE.test(line)) return true;
  return (Array.isArray(page?.headings) ? page.headings : []).some((heading) => normalizedKey(heading) === normalizedKey(line));
}

function isTable(element) {
  return string(element?.kind).toLowerCase() === 'table';
}

function pageElements(page) {
  const elements = Array.isArray(page?.layout?.elements) ? page.layout.elements : [];
  if (elements.length) return elements;
  return normalizeText(page?.rawText).split('\n').filter(Boolean).map((line, index) => ({
    id: '',
    kind: 'text',
    text: line,
    source: 'derived_cleaning_line',
    position: index,
  }));
}

function pageNumberValue(value) {
  const match = normalizeText(value).match(/^(?:第\s*)?(\d{1,5})\s*(?:页)?(?:\s*[/／]\s*\d{1,5})?$/u);
  return match ? Number(match[1]) : null;
}

function hasEdgePosition(element, page) {
  const position = [element?.position, element?.layoutPosition, element?.metadata?.position]
    .map((value) => string(value).toLowerCase())
    .find(Boolean);
  if (['top', 'bottom', 'header', 'footer', 'page_top', 'page_bottom'].includes(position)) return true;

  const bbox = Array.isArray(element?.bbox) && element.bbox.length === 4 ? element.bbox.map(Number) : null;
  if (!bbox?.every(Number.isFinite)) return false;
  const pageHeight = Number(page?.height || page?.layout?.height || page?.layout?.pageHeight || page?.layout?.metadata?.height);
  if (Number.isFinite(pageHeight) && pageHeight > 0) {
    return bbox[1] <= pageHeight * 0.08 || bbox[3] >= pageHeight * 0.92;
  }
  return bbox[1] >= 0 && bbox[3] <= 1 && (bbox[1] <= 0.08 || bbox[3] >= 0.92);
}

function pageNumberEvidence(pages) {
  const proven = new Set();
  const crossPage = new Map();
  for (const page of pages) {
    const elements = pageElements(page);
    elements.forEach((element, index) => {
      const value = pageNumberValue(elementText(element));
      if (value == null) return;
      const reference = `${Number(page?.pageNo || 0)}:${index}`;
      const kind = string(element?.kind).toLowerCase();
      if (['header', 'footer', 'page_number', 'page-number', 'pagenumber'].includes(kind) || hasEdgePosition(element, page)) {
        proven.add(reference);
        return;
      }
      const slot = index === 0 ? 'first' : index === elements.length - 1 ? 'last' : '';
      if (!slot) return;
      if (!crossPage.has(slot)) crossPage.set(slot, []);
      crossPage.get(slot).push({ pageNo: Number(page?.pageNo || 0), index, value });
    });
  }
  for (const entries of crossPage.values()) {
    const ordered = entries.sort((left, right) => left.pageNo - right.pageNo);
    const sequential = ordered.length >= 3 && ordered.every((entry, index) => (
      index === 0 || entry.value - ordered[index - 1].value === entry.pageNo - ordered[index - 1].pageNo
    ));
    if (sequential) ordered.forEach((entry) => proven.add(`${entry.pageNo}:${entry.index}`));
  }
  return proven;
}

function repeatedEdgeKeys(pages) {
  const occurrences = new Map();
  for (const page of pages) {
    const elements = pageElements(page).filter((element) => elementText(element));
    const edgeElements = elements.filter((element, index) => {
      const kind = string(element?.kind).toLowerCase();
      return kind === 'header' || kind === 'footer' || index === 0 || index === elements.length - 1;
    });
    for (const element of edgeElements) {
      const content = elementText(element);
      if (!content || content.length > 120 || isHeading(content, element, page) || STANDALONE_PAGE_NUMBER.test(content)) continue;
      const key = normalizedKey(content);
      if (!occurrences.has(key)) occurrences.set(key, new Set());
      occurrences.get(key).add(Number(page?.pageNo || 0));
    }
  }
  return new Set([...occurrences.entries()].filter(([, pageNos]) => pageNos.size >= 2).map(([key]) => key));
}

function shouldMerge(left, right, page) {
  if (!left?.text || !right?.text) return false;
  if (isTable(left.element) || isTable(right.element)) return false;
  if (isHeading(left.text, left.element, page) || isHeading(right.text, right.element, page)) return false;
  if (STANDALONE_PAGE_NUMBER.test(left.text) || STANDALONE_PAGE_NUMBER.test(right.text)) return false;
  if (TERMINAL_PUNCTUATION.test(left.text)) return false;
  return true;
}

function cleanPage(page, repeatedKeys, pageNumberReferences) {
  const pageNo = Number(page?.pageNo || 0);
  const operations = [];
  const includedElementIds = [];
  const excludedElementIds = [];
  const units = [];
  const elements = pageElements(page);

  elements.forEach((element, index) => {
    const id = string(element?.id).trim();
    const before = string(element?.text || element?.caption);
    const normalized = elementText(element);
    if (before !== normalized) {
      operations.push(operation({ pageNo, rule: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(before) ? 'normalize_control_characters_v1' : 'normalize_whitespace_v1', elementIds: [id], before, after: normalized }));
    }
    if (!normalized) return;

    if (STANDALONE_PAGE_NUMBER.test(normalized) && pageNumberReferences.has(`${pageNo}:${index}`)) {
      if (id) excludedElementIds.push(id);
      operations.push(operation({ pageNo, rule: 'exclude_standalone_page_number_v1', elementIds: [id], before: normalized, after: '' }));
      return;
    }

    const edge = index === 0 || index === elements.length - 1 || ['header', 'footer'].includes(string(element?.kind).toLowerCase());
    if (edge && repeatedKeys.has(normalizedKey(normalized)) && !isHeading(normalized, element, page)) {
      if (id) excludedElementIds.push(id);
      operations.push(operation({ pageNo, rule: 'classify_repeated_header_footer_v1', elementIds: [id], before: normalized, after: '' }));
      return;
    }

    if (id) includedElementIds.push(id);
    normalized.split('\n').filter(Boolean).forEach((line) => units.push({ text: line, element, elementId: id }));
  });

  const merged = [];
  for (const unit of units) {
    const previous = merged.at(-1);
    if (!shouldMerge(previous, unit, page)) {
      merged.push({ ...unit, elementIds: unit.elementId ? [unit.elementId] : [] });
      continue;
    }
    const before = `${previous.text}\n${unit.text}`;
    const after = `${previous.text}${unit.text}`;
    previous.text = after;
    if (unit.elementId && !previous.elementIds.includes(unit.elementId)) previous.elementIds.push(unit.elementId);
    operations.push(operation({ pageNo, rule: 'merge_broken_lines_v1', elementIds: previous.elementIds, before, after }));
  }

  const cleanedText = merged.map((unit) => unit.text).join('\n').trim();
  return {
    ...page,
    cleanedText,
    includedElementIds,
    excludedElementIds,
    cleaningDecision: cleanedText || !normalizeText(page?.rawText) ? 'pass' : 'review_required',
    operations,
  };
}

export function cleanProductDocumentPages(pages = []) {
  const sourcePages = Array.isArray(pages) ? pages : [];
  const repeatedKeys = repeatedEdgeKeys(sourcePages);
  const pageNumberReferences = pageNumberEvidence(sourcePages);
  const cleaned = sourcePages.map((page) => cleanPage(page, repeatedKeys, pageNumberReferences));
  return {
    pages: cleaned.map(({ operations: _operations, ...page }) => page),
    operations: cleaned.flatMap((page) => page.operations),
    cleaningVersion: CLEANING_VERSION,
  };
}
