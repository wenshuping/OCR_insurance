import type { ReactNode } from 'react';

type MarkdownBlock =
  | { type: 'heading'; level: 2 | 3 | 4; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'rule' };

function salesReviewDisplayTerm(value: string) {
  const text = String(value || '').trim();
  if (/^duplicatePolicyHints$/iu.test(text)) return '重复保单提示';
  if (/^evidenceWarnings$/iu.test(text)) return '条款证据冲突';
  if (/^canonical:product_[a-z0-9_-]+$/iu.test(text)) return '官方条款证据';
  if (/^plans$/iu.test(text)) return '险种明细';
  if (/^officialEvidence$/iu.test(text)) return '官网条款证据';
  return '';
}

function normalizeSalesReviewMarkdownText(value: string) {
  return String(value || '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/`([^`]+)`/gu, (match, token) => salesReviewDisplayTerm(String(token || '')) || match)
    .replace(/\bduplicatePolicyHints\b/giu, '重复保单提示')
    .replace(/\bevidenceWarnings\b/giu, '条款证据冲突')
    .replace(/\bcanonical:product_[a-z0-9_-]+\b/giu, '官方条款证据')
    .replace(/\bofficialEvidence\b/giu, '官网条款证据')
    .replace(/\bplans\b/giu, '险种明细')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

function displayMarkdownText(value: string) {
  return normalizeSalesReviewMarkdownText(value)
    .replace(/^#{1,6}\s*/u, '')
    .replace(/^[-*+]\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/^\[[ xX]\]\s*/u, '')
    .trim();
}

function plainMarkdownText(value: string) {
  return displayMarkdownText(value)
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/__([^_]+)__/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .trim();
}

function isPlaceholderLine(value: string) {
  const normalized = plainMarkdownText(value).normalize('NFKC').replace(/\s+/gu, '');
  return !normalized || /^[•·\-_*—–]+$/u.test(normalized) || /^(暂无明确结论|暂无|无|待补充)$/u.test(normalized);
}

function splitTableRow(value: string) {
  return String(value || '')
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => displayMarkdownText(cell.replace(/\\\|/gu, '|')));
}

function isTableSeparator(value: string) {
  const cells = splitTableRow(value);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()));
}

function isHeading(value: string) {
  return /^#{2,4}\s+\S/u.test(value.trim());
}

function isRule(value: string) {
  return /^(-{3,}|\*{3,}|_{3,})$/u.test(value.trim());
}

function isUnorderedItem(value: string) {
  return /^\s*[-*+]\s+\S/u.test(value);
}

function isOrderedItem(value: string) {
  return /^\s*\d+[.)]\s+\S/u.test(value);
}

function isBlockStart(lines: string[], index: number) {
  const line = lines[index]?.trim() || '';
  if (!line) return true;
  return isHeading(line)
    || isRule(line)
    || isUnorderedItem(lines[index] || '')
    || isOrderedItem(lines[index] || '')
    || line.startsWith('>')
    || (line.includes('|') && isTableSeparator(lines[index + 1] || ''));
}

function parseListItem(value: string) {
  return displayMarkdownText(value.replace(/^\s*([-*+]|\d+[.)])\s+/u, ''));
}

export function parseFamilySalesReviewMarkdown(content = ''): MarkdownBlock[] {
  const lines = String(content || '').replace(/\r/gu, '').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index] || '';
    const line = rawLine.trim();
    if (!line) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{2,4})\s+(.+)$/u);
    if (headingMatch) {
      const text = displayMarkdownText(headingMatch[2]);
      if (text) {
        const level = Math.min(4, Math.max(2, headingMatch[1].length)) as 2 | 3 | 4;
        blocks.push({ type: 'heading', level, text });
      }
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1] || '')) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] || '').includes('|') && (lines[index] || '').trim()) {
        const row = splitTableRow(lines[index]);
        if (row.some((cell) => !isPlaceholderLine(cell))) rows.push(row);
        index += 1;
      }
      if (headers.length && rows.length) blocks.push({ type: 'table', headers, rows });
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] || '').trim().startsWith('>')) {
        const quote = displayMarkdownText((lines[index] || '').replace(/^\s*>\s?/u, ''));
        if (!isPlaceholderLine(quote)) quoteLines.push(quote);
        index += 1;
      }
      if (quoteLines.length) blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    if (isUnorderedItem(rawLine) || isOrderedItem(rawLine)) {
      const ordered = isOrderedItem(rawLine);
      const items: string[] = [];
      while (index < lines.length && (ordered ? isOrderedItem(lines[index] || '') : isUnorderedItem(lines[index] || ''))) {
        const item = parseListItem(lines[index] || '');
        if (!isPlaceholderLine(item)) items.push(item);
        index += 1;
      }
      if (items.length) blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isBlockStart(lines, index)) {
      const paragraphLine = displayMarkdownText(lines[index] || '');
      if (!isPlaceholderLine(paragraphLine)) paragraphLines.push(paragraphLine);
      index += 1;
    }
    if (paragraphLines.length) blocks.push({ type: 'paragraph', text: paragraphLines.join('\n') });
  }

  return blocks.length ? blocks : [{ type: 'paragraph', text: '暂无专家研判内容' }];
}

function renderInlineMarkdown(value: string, keyPrefix: string) {
  const text = normalizeSalesReviewMarkdownText(value);
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`)/gu;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={`${keyPrefix}-code-${match.index}`}>{token.slice(1, -1)}</code>);
    } else {
      parts.push(<strong key={`${keyPrefix}-strong-${match.index}`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : text;
}

function renderParagraphText(value: string, keyPrefix: string) {
  return value.split('\n').map((line, index) => (
    <span key={`${keyPrefix}-line-${index}`}>
      {index > 0 ? <br /> : null}
      {renderInlineMarkdown(line, `${keyPrefix}-${index}`)}
    </span>
  ));
}

export function FamilySalesReviewMarkdown({ content }: { content: string }) {
  const blocks = parseFamilySalesReviewMarkdown(content);

  return (
    <div className="family-sales-review-markdown">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === 'heading') {
          const HeadingTag = block.level === 2 ? 'h2' : block.level === 3 ? 'h3' : 'h4';
          return <HeadingTag key={key}>{renderInlineMarkdown(block.text, key)}</HeadingTag>;
        }
        if (block.type === 'paragraph') {
          return <p key={key}>{renderParagraphText(block.text, key)}</p>;
        }
        if (block.type === 'quote') {
          return <blockquote key={key}>{renderParagraphText(block.text, key)}</blockquote>;
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>{renderInlineMarkdown(item, `${key}-${itemIndex}`)}</li>
              ))}
            </ListTag>
          );
        }
        if (block.type === 'table') {
          return (
            <div key={key} className="family-sales-review-table-wrap" data-pdf-table-wrap>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`${key}-header-${headerIndex}`}>{renderInlineMarkdown(header, `${key}-header-${headerIndex}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${key}-row-${rowIndex}`}>
                      {block.headers.map((_header, cellIndex) => (
                        <td key={`${key}-row-${rowIndex}-cell-${cellIndex}`}>
                          {renderParagraphText(row[cellIndex] || '', `${key}-row-${rowIndex}-cell-${cellIndex}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <hr key={key} />;
      })}
    </div>
  );
}
