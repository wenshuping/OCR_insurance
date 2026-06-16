import type { CashflowEntry, PolicyCashflowPlan, ScenarioEntry } from '../../api/contracts/cashflow';
import type { Policy } from '../../api/contracts/policy';
import { fillCashflowYears } from '../../cashflow-engine.mjs';
import { resolvePolicyValidityStatus } from '../../policy-validity.mjs';
import { isWeChatBrowser, isWeChatMiniProgramWebView } from '../../shared/browser-env';
import { formatFileSize } from '../../shared/formatters';

export function normalizePdfFileName(value: string) {
  return String(value || '保单解析报告')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function exportCurrentReportAsPdf(title: string) {
  const previousTitle = document.title;
  document.title = normalizePdfFileName(title);
  window.print();
  window.setTimeout(() => {
    document.title = previousTitle;
  }, 500);
}

type PrintableInfoRow = {
  label: string;
  value: string;
};

type PrintableResponsibilityRow = {
  title: string;
  paragraphs: string[];
};

function normalizePrintableInlineText(value: string) {
  return String(value || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function normalizePrintableBlockText(value: string) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitPrintableParagraphs(value: string) {
  return normalizePrintableBlockText(value)
    .split(/\n{1,}/)
    .map((row) => row.trim())
    .filter(Boolean);
}

function appendUniqueInfoRow(rows: PrintableInfoRow[], label: string, value: string) {
  const normalizedLabel = normalizePrintableInlineText(label).replace(/[：:]\s*$/u, '');
  const normalizedValue = normalizePrintableInlineText(value);
  if (!normalizedLabel || !normalizedValue) return;
  if (rows.some((row) => row.label === normalizedLabel)) return;
  rows.push({ label: normalizedLabel, value: normalizedValue });
}

function extractInfoRowFromParagraph(paragraph: HTMLParagraphElement) {
  const strong = paragraph.querySelector('strong');
  if (!strong) return null;
  const label = normalizePrintableInlineText(strong.textContent || '').replace(/[：:]\s*$/u, '');
  const clone = paragraph.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('strong').forEach((node) => node.remove());
  const value = normalizePrintableInlineText(clone.textContent || '').replace(/^[：:\s]+/u, '');
  if (!label || !value) return null;
  return { label, value };
}

function extractPrintableInfoRows(target: HTMLElement) {
  const rows: PrintableInfoRow[] = [];
  target.querySelectorAll('.print-policy-grid p').forEach((node) => {
    if (!(node instanceof HTMLParagraphElement)) return;
    const row = extractInfoRowFromParagraph(node);
    if (row) appendUniqueInfoRow(rows, row.label, row.value);
  });
  if (rows.length) return rows;

  target.querySelectorAll('section div').forEach((node) => {
    if (!(node instanceof HTMLElement) || node.closest('.no-print')) return;
    const paragraphChildren = Array.from(node.children).filter(
      (child): child is HTMLParagraphElement => child instanceof HTMLParagraphElement,
    );
    if (paragraphChildren.length < 2) return;
    const label = normalizePrintableInlineText(paragraphChildren[0]?.textContent || '');
    const value = normalizePrintableInlineText(paragraphChildren[1]?.textContent || '');
    if (label.length > 14 || value.length > 80) return;
    appendUniqueInfoRow(rows, label, value);
  });
  return rows;
}

function findPrintableInfoValue(rows: PrintableInfoRow[], labels: string[]) {
  return rows.find((row) => labels.includes(row.label))?.value || '';
}

function extractPrintableGeneratedAt(target: HTMLElement) {
  const generatedText = Array.from(target.querySelectorAll('.print-only p'))
    .map((node) => normalizePrintableInlineText(node.textContent || ''))
    .find((text) => /^生成时间[:：]/u.test(text));
  return generatedText?.replace(/^生成时间[:：]\s*/u, '') || new Date().toLocaleString('zh-CN', { hour12: false });
}

function extractPrintableResponsibilities(target: HTMLElement) {
  const matchedSections = Array.from(target.querySelectorAll('section')).filter((section) => {
    if (!(section instanceof HTMLElement) || section.closest('.no-print')) return false;
    const headingText = normalizePrintableInlineText(
      Array.from(section.querySelectorAll('h2,h3'))
        .map((heading) => heading.textContent || '')
        .join(' '),
    );
    return /保险责任|责任解析/u.test(headingText);
  });
  const articles = new Set<HTMLElement>();
  for (const section of matchedSections) {
    section.querySelectorAll('article').forEach((article) => {
      if (article instanceof HTMLElement && !article.closest('.no-print')) articles.add(article);
    });
  }
  if (!articles.size) {
    target.querySelectorAll('article').forEach((article) => {
      if (article instanceof HTMLElement && !article.closest('.no-print')) articles.add(article);
    });
  }

  return Array.from(articles)
    .map((article) => {
      const title = normalizePrintableInlineText(article.querySelector('h4')?.textContent || '保险责任');
      const paragraphs = Array.from(article.querySelectorAll('p'))
        .flatMap((paragraph) => splitPrintableParagraphs(paragraph.textContent || ''))
        .filter((paragraph) => paragraph && paragraph !== title);
      return { title, paragraphs };
    })
    .filter((row) => row.paragraphs.length && !/暂无|正在生成/u.test(row.paragraphs.join(' ')));
}

function createPdfElement<K extends keyof HTMLElementTagNameMap>(tagName: K, style: string, text = '') {
  const element = document.createElement(tagName);
  element.setAttribute('style', style);
  if (text) element.textContent = text;
  return element;
}

function appendPdfSectionTitle(parent: HTMLElement, title: string) {
  const heading = createPdfElement(
    'h2',
    [
      'margin:0 0 14px',
      'font-size:18px',
      'line-height:1.35',
      'font-weight:800',
      'color:#0f172a',
      'letter-spacing:0',
    ].join(';'),
    title,
  );
  parent.appendChild(heading);
}

function appendPrintableInfoGrid(parent: HTMLElement, rows: PrintableInfoRow[]) {
  const grid = createPdfElement(
    'div',
    [
      'display:grid',
      'grid-template-columns:repeat(2,minmax(0,1fr))',
      'border:1px solid #dbe4ef',
      'border-radius:8px',
      'overflow:hidden',
      'background:#ffffff',
    ].join(';'),
  );
  rows.forEach((row, index) => {
    const item = createPdfElement(
      'div',
      [
        'min-height:54px',
        'padding:10px 12px',
        'box-sizing:border-box',
        index % 2 === 0 ? 'border-right:1px solid #e5edf7' : '',
        index < rows.length - 2 ? 'border-bottom:1px solid #e5edf7' : '',
      ]
        .filter(Boolean)
        .join(';'),
    );
    item.appendChild(createPdfElement('p', 'margin:0 0 4px;font-size:11px;line-height:1.4;font-weight:700;color:#64748b', row.label));
    item.appendChild(createPdfElement('p', 'margin:0;font-size:14px;line-height:1.55;font-weight:700;color:#0f172a;word-break:break-word', row.value));
    grid.appendChild(item);
  });
  parent.appendChild(grid);
}

function appendPrintableResponsibilities(parent: HTMLElement, responsibilities: PrintableResponsibilityRow[]) {
  const list = createPdfElement('div', 'display:grid;gap:12px');
  responsibilities.forEach((row, index) => {
    const article = createPdfElement(
      'article',
      [
        'display:grid',
        'grid-template-columns:32px minmax(0,1fr)',
        'gap:12px',
        'border:1px solid #dbe4ef',
        'border-left:4px solid #2563eb',
        'border-radius:8px',
        'background:#ffffff',
        'padding:14px',
        'break-inside:avoid',
      ].join(';'),
    );
    article.appendChild(
      createPdfElement(
        'div',
        [
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'width:28px',
          'height:28px',
          'border-radius:999px',
          'background:#eff6ff',
          'color:#1d4ed8',
          'font-size:13px',
          'font-weight:800',
        ].join(';'),
        String(index + 1),
      ),
    );
    const content = createPdfElement('div', 'min-width:0');
    content.appendChild(
      createPdfElement('h3', 'margin:0 0 8px;font-size:16px;line-height:1.45;font-weight:800;color:#0f172a', row.title || '保险责任'),
    );
    row.paragraphs.forEach((paragraph, paragraphIndex) => {
      content.appendChild(
        createPdfElement(
          'p',
          [
            `margin:${paragraphIndex === 0 ? 0 : 8}px 0 0`,
            'font-size:13px',
            'line-height:1.8',
            'font-weight:500',
            'color:#334155',
            'word-break:break-word',
            'white-space:pre-wrap',
          ].join(';'),
          paragraph,
        ),
      );
    });
    article.appendChild(content);
    list.appendChild(article);
  });
  parent.appendChild(list);
}

function appendPrintableCashflowTable(
  parent: HTMLElement,
  entries: CashflowEntry[],
  plan: { effectiveDate: string; insuredBirthday: string; policyId: number; productName: string },
) {
  if (!entries.length) return;
  const effectiveYear = plan.effectiveDate ? new Date(plan.effectiveDate).getFullYear() : 0;
  const birthYear = plan.insuredBirthday ? new Date(plan.insuredBirthday).getFullYear() : 0;
  const lastEntryYear = entries.length ? entries[entries.length - 1].year : 0;
  const endYear = Math.max(lastEntryYear, effectiveYear + 50, birthYear + 85);
  const allEntries = (effectiveYear && birthYear)
    ? fillCashflowYears(entries, effectiveYear, birthYear, endYear, { policyId: plan.policyId, productName: plan.productName })
    : entries;

  const section = document.createElement('section');
  section.setAttribute('style', 'margin-bottom:20px;break-inside:avoid');

  const title = document.createElement('h2');
  title.setAttribute('style', 'margin:0 0 14px;font-size:18px;line-height:1.35;font-weight:800;color:#0f172a');
  title.textContent = `现金流明细（${allEntries.length}年）`;
  section.appendChild(title);

  const table = document.createElement('table');
  table.setAttribute('style', 'width:100%;border-collapse:collapse;font-size:12px;line-height:1.6');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['年份', '领取金额', '累计领取', '现金价值'].forEach((label) => {
    const th = document.createElement('th');
    th.setAttribute('style', 'background:#2563eb;color:#fff;padding:8px 10px;text-align:left;font-weight:700');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  allEntries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.setAttribute('style', i % 2 === 0 ? '' : 'background:#f8fafc');
    const hasAmount = entry.amount > 0;
    const isLastAndMaturity = hasAmount && /满期/.test(entry.liability);
    if (isLastAndMaturity) tr.setAttribute('style', 'background:#fff7ed;font-weight:800;border-left:4px solid #f97316');

    const cells = [
      `${entry.year}/${entry.age}`,
      hasAmount ? entry.amount.toLocaleString('zh-CN') : '—',
      hasAmount ? entry.cumulative.toLocaleString('zh-CN') : '—',
      entry.cashValue != null ? entry.cashValue.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '—',
    ];
    cells.forEach((text, ci) => {
      const td = document.createElement('td');
      td.setAttribute('style', `padding:6px 10px;border-bottom:1px solid #e2e8f0;${ci > 0 ? 'text-align:right' : ''}`);
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);
  parent.appendChild(section);
}

function appendPrintableScenarioTable(parent: HTMLElement, entries: ScenarioEntry[]) {
  if (!entries.length) return;
  const section = document.createElement('section');
  section.setAttribute('style', 'margin-bottom:20px');

  const title = document.createElement('h2');
  title.setAttribute('style', 'margin:0 0 14px;font-size:18px;line-height:1.35;font-weight:800;color:#0f172a');
  title.textContent = `保障责任明细（${entries.length}项）`;
  section.appendChild(title);

  const table = document.createElement('table');
  table.setAttribute('style', 'width:100%;border-collapse:collapse;font-size:12px;line-height:1.6');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['场景', '计算公式', '金额'].forEach((label) => {
    const th = document.createElement('th');
    th.setAttribute('style', 'background:#2563eb;color:#fff;padding:8px 10px;text-align:left;font-weight:700');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.setAttribute('style', i % 2 === 0 ? '' : 'background:#f8fafc');
    const isBold = entry.amount >= 1000000;

    [
      { text: entry.scenario, style: `${entry.condition ? 'padding-left:24px;' : ''}${isBold ? 'font-weight:800' : ''}` },
      { text: entry.formula, style: 'color:#64748b' },
      { text: entry.amount.toLocaleString('zh-CN'), style: `text-align:right;${isBold ? 'font-weight:800;color:#1e40af' : ''}` },
    ].forEach(({ text, style }) => {
      const td = document.createElement('td');
      td.setAttribute('style', `padding:6px 10px;border-bottom:1px solid #e2e8f0;${style}`);
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);
  parent.appendChild(section);
}

export function createPrintableReportNode(target: HTMLElement, title: string, policy?: Policy) {
  const infoRows = extractPrintableInfoRows(target);
  const responsibilities = extractPrintableResponsibilities(target);
  const generatedAt = extractPrintableGeneratedAt(target);
  const company = findPrintableInfoValue(infoRows, ['保险公司']) || normalizePrintableInlineText(target.querySelector('section p')?.textContent || '');
  const productName = findPrintableInfoValue(infoRows, ['产品名称']) || normalizePrintableInlineText(target.querySelector('section h2')?.textContent || title);
  const insured = findPrintableInfoValue(infoRows, ['被保人', '被保险人']) || '-';
  const amount = findPrintableInfoValue(infoRows, ['保障额度', '保额']) || '-';
  const period = findPrintableInfoValue(infoRows, ['保障期间']) || '-';
  const premium = findPrintableInfoValue(infoRows, ['首期保费', '年度保费']) || '-';

  const report = createPdfElement(
    'main',
    [
      'box-sizing:border-box',
      'width:760px',
      'min-height:1040px',
      'padding:34px 38px',
      'background:#ffffff',
      'color:#0f172a',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif',
      'letter-spacing:0',
      'line-height:1.5',
      'overflow:visible',
    ].join(';'),
  );

  const header = createPdfElement(
    'header',
    [
      'display:flex',
      'align-items:flex-start',
      'justify-content:space-between',
      'gap:24px',
      'border-bottom:3px solid #2563eb',
      'padding-bottom:16px',
      'margin-bottom:22px',
    ].join(';'),
  );
  const headerText = createPdfElement('div', 'min-width:0;flex:1');
  headerText.appendChild(createPdfElement('p', 'margin:0 0 6px;font-size:11px;line-height:1.4;font-weight:800;color:#2563eb', 'POLICY OCR'));
  headerText.appendChild(createPdfElement('h1', 'margin:0;font-size:30px;line-height:1.22;font-weight:900;color:#0f172a', '保单解析报告'));
  header.appendChild(headerText);
  const generated = createPdfElement(
    'div',
    'flex-shrink:0;text-align:right;color:#64748b;font-size:12px;line-height:1.6;font-weight:600',
    `生成时间\n${generatedAt}`,
  );
  generated.setAttribute('style', `${generated.getAttribute('style')};white-space:pre-line`);
  header.appendChild(generated);
  report.appendChild(header);

  const hero = createPdfElement(
    'section',
    [
      'border:1px solid #cfe0f4',
      'border-radius:10px',
      'background:#f8fbff',
      'padding:18px 20px',
      'margin-bottom:18px',
      'break-inside:avoid',
    ].join(';'),
  );
  hero.appendChild(createPdfElement('p', 'margin:0 0 7px;font-size:12px;line-height:1.5;font-weight:800;color:#2563eb', company || '保险公司'));
  hero.appendChild(createPdfElement('h2', 'margin:0;font-size:23px;line-height:1.42;font-weight:900;color:#0f172a;word-break:break-word', productName || title));
  const summaryGrid = createPdfElement(
    'div',
    'display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:15px',
  );
  [
    ['被保人', insured],
    ['保障额度', amount],
    ['保障期间', period],
    ['首期保费', premium],
  ].forEach(([label, value]) => {
    const chip = createPdfElement('div', 'border:1px solid #dbe4ef;border-radius:8px;background:#ffffff;padding:9px 10px;min-width:0');
    chip.appendChild(createPdfElement('p', 'margin:0 0 3px;font-size:10px;line-height:1.3;font-weight:700;color:#64748b', label));
    chip.appendChild(createPdfElement('p', 'margin:0;font-size:13px;line-height:1.45;font-weight:800;color:#0f172a;word-break:break-word', value || '-'));
    summaryGrid.appendChild(chip);
  });
  hero.appendChild(summaryGrid);
  report.appendChild(hero);

  if (infoRows.length) {
    const infoSection = createPdfElement('section', 'margin-bottom:20px;break-inside:avoid');
    appendPdfSectionTitle(infoSection, '保单信息');
    appendPrintableInfoGrid(infoSection, infoRows);
    report.appendChild(infoSection);
  }

  const responsibilitySection = createPdfElement('section', 'margin-bottom:20px');
  appendPdfSectionTitle(responsibilitySection, `保险责任${responsibilities.length ? `（${responsibilities.length}项）` : ''}`);
  if (responsibilities.length) {
    appendPrintableResponsibilities(responsibilitySection, responsibilities);
  } else {
    responsibilitySection.appendChild(
      createPdfElement('p', 'margin:0;border:1px dashed #cbd5e1;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;color:#64748b', '暂无保险责任解析。'),
    );
  }
  report.appendChild(responsibilitySection);

  // 现金流明细（如果有）
  if (policy) {
    const p = policy;
    const cashflowPlans: PolicyCashflowPlan[] = [{
      policyId: p.id,
      productName: p.name || '',
      company: p.company || '',
      insured: p.insured || '',
      insuredBirthday: p.insuredBirthday || '',
      effectiveDate: p.date || '',
      annualEntries: p.cashflowEntries || [],
      scenarioEntries: p.scenarioEntries || [],
      totalDeterministicCashflow: p.totalCashflow ?? 0,
      expired: resolvePolicyValidityStatus(p.coveragePeriod, {
        effectiveDate: p.date,
        insuredBirthday: p.insuredBirthday,
      }).tone === 'expired',
    }];
    for (const plan of cashflowPlans) {
      if (plan.annualEntries.length) {
        appendPrintableCashflowTable(report, plan.annualEntries, {
          effectiveDate: plan.effectiveDate,
          insuredBirthday: plan.insuredBirthday,
          policyId: plan.policyId,
          productName: plan.productName,
        });
      }
      if (plan.scenarioEntries.length) {
        appendPrintableScenarioTable(report, plan.scenarioEntries);
      }
    }
  }

  report.appendChild(
    createPdfElement(
      'footer',
      'border-top:1px solid #e2e8f0;margin-top:22px;padding-top:12px;font-size:11px;line-height:1.7;color:#64748b',
      '本报告依据保单 OCR 识别信息及保险责任解析结果生成，请以保险合同条款和保险公司官方资料为准。',
    ),
  );

  return report;
}

export type ReportExportOptions = { rawTarget?: boolean; preservePageStyle?: boolean; matchScreenStyle?: boolean };

const screenStyleReportWidth = 1180;

function getScreenStyleReportWidth(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  const width = Math.ceil(rect.width || target.offsetWidth || Math.min(target.scrollWidth || 0, window.innerWidth || 0) || screenStyleReportWidth);
  return Math.max(screenStyleReportWidth, width);
}

function getScreenStyleReportBackground(target: HTMLElement) {
  let node: HTMLElement | null = target;
  while (node) {
    const backgroundColor = window.getComputedStyle(node).backgroundColor;
    if (backgroundColor && backgroundColor !== 'transparent' && backgroundColor !== 'rgba(0, 0, 0, 0)') return backgroundColor;
    node = node.parentElement;
  }
  return '#EEF3F7';
}

const canvasColorStyleProperties = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'caret-color',
  'fill',
  'stroke',
];

const canvasCompositeColorStyleProperties = [
  'background-image',
  'box-shadow',
  'text-shadow',
];

function parseOklchNumber(value: string, percentageBase = 1) {
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) return (Number.parseFloat(trimmed) / 100) * percentageBase;
  return Number.parseFloat(trimmed);
}

function convertOklabToRgbCss(lightness: number, a: number, b: number, alpha: number) {
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;

  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;

  const linearR = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const linearG = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const linearB = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const toSrgbChannel = (channel: number) => {
    const corrected = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, corrected)) * 255);
  };

  const red = toSrgbChannel(linearR);
  const green = toSrgbChannel(linearG);
  const blue = toSrgbChannel(linearB);
  if (alpha < 1) return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, alpha))})`;
  return `rgb(${red}, ${green}, ${blue})`;
}

function convertOklchColorToRgb(value: string) {
  const [channelsRaw, alphaRaw] = value.split('/').map((part) => part.trim());
  const channels = channelsRaw.split(/\s+/).filter(Boolean);
  if (channels.length < 3) return `oklch(${value})`;

  const lightness = parseOklchNumber(channels[0]);
  const chroma = parseOklchNumber(channels[1]);
  const hue = channels[2] === 'none' ? 0 : Number.parseFloat(channels[2]);
  const alpha = alphaRaw ? parseOklchNumber(alphaRaw) : 1;
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return `oklch(${value})`;

  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  return convertOklabToRgbCss(lightness, a, b, alpha);
}

function convertOklabColorToRgb(value: string) {
  const [channelsRaw, alphaRaw] = value.split('/').map((part) => part.trim());
  const channels = channelsRaw.split(/\s+/).filter(Boolean);
  if (channels.length < 3) return `oklab(${value})`;

  const lightness = parseOklchNumber(channels[0]);
  const a = parseOklchNumber(channels[1]);
  const b = parseOklchNumber(channels[2]);
  const alpha = alphaRaw ? parseOklchNumber(alphaRaw) : 1;
  if (![lightness, a, b, alpha].every(Number.isFinite)) return `oklab(${value})`;

  return convertOklabToRgbCss(lightness, a, b, alpha);
}

export function convertCssOklchToRgb(value: string) {
  if (!value || (!value.includes('oklch(') && !value.includes('oklab('))) return value;
  return value
    .replace(/oklch\(([^)]*)\)/g, (_, colorValue: string) => convertOklchColorToRgb(colorValue))
    .replace(/oklab\(([^)]*)\)/g, (_, colorValue: string) => convertOklabColorToRgb(colorValue));
}

export function normalizeCanvasColorValues(root: HTMLElement, options: { includeCompositeColors?: boolean } = {}) {
  const properties = options.includeCompositeColors === false
    ? canvasColorStyleProperties
    : [...canvasColorStyleProperties, ...canvasCompositeColorStyleProperties];
  const nodes = [root, ...Array.from(root.querySelectorAll<HTMLElement | SVGElement>('*'))];
  nodes.forEach((node) => {
    const computed = window.getComputedStyle(node);
    properties.forEach((property) => {
      const current = computed.getPropertyValue(property);
      const converted = convertCssOklchToRgb(current);
      if (converted && converted !== current) node.style.setProperty(property, converted);
    });
  });
}

export function createPdfRenderTarget(target: HTMLElement, title: string, policy?: Policy, options?: ReportExportOptions) {
  const wrapper = document.createElement('div');
  const width = options?.matchScreenStyle ? getScreenStyleReportWidth(target) : options?.preservePageStyle ? 1120 : 760;
  const backgroundColor = options?.matchScreenStyle ? getScreenStyleReportBackground(target) : '#ffffff';
  wrapper.setAttribute(
    'style',
    [
      'position:fixed',
      'left:-100000px',
      'top:0',
      `width:${width}px`,
      'min-height:1px',
      `background:${backgroundColor}`,
      'color:#0f172a',
      'z-index:-1',
      'overflow:visible',
      'pointer-events:none',
    ].join(';'),
  );

  const reportNode = options?.rawTarget ? (target.cloneNode(true) as HTMLElement) : createPrintableReportNode(target, title, policy);
  reportNode.classList?.add?.('print-policy-report');
  wrapper.appendChild(reportNode);
  document.body.appendChild(wrapper);

  if (options?.rawTarget && options.matchScreenStyle) {
    prepareScreenStyleReportNode(reportNode, width, backgroundColor);
  } else if (options?.rawTarget && options.preservePageStyle) {
    preparePageStyleReportNode(reportNode, width);
  } else if (options?.rawTarget) {
    reportNode.querySelectorAll<HTMLElement>('[data-pdf-table-wrap]').forEach((node) => {
      node.style.overflow = 'visible';
      node.style.width = 'max-content';
      node.style.maxWidth = 'none';
    });
    const rawTargetWidth = Math.max(width, reportNode.scrollWidth || 0);
    wrapper.style.width = `${rawTargetWidth}px`;
    reportNode.style.width = `${rawTargetWidth}px`;
  }
  const captureWidth = options?.matchScreenStyle || options?.preservePageStyle ? width : getReportCaptureWidth(reportNode, width);
  if (options?.preservePageStyle) wrapper.style.width = `${captureWidth}px`;

  return {
    node: reportNode,
    width,
    captureWidth,
    cleanup() {
      wrapper.remove();
    },
  };
}

function getReportCaptureWidth(reportNode: HTMLElement, fallbackWidth: number) {
  const reportRect = reportNode.getBoundingClientRect();
  let maxRight = reportRect.right;
  reportNode.querySelectorAll<HTMLElement>('[data-pdf-table-wrap], table').forEach((node) => {
    maxRight = Math.max(maxRight, node.getBoundingClientRect().right);
  });
  return Math.max(fallbackWidth, reportNode.scrollWidth || 0, Math.ceil(maxRight - reportRect.left));
}

function prepareScreenStyleReportNode(reportNode: HTMLElement, width: number, backgroundColor: string) {
  reportNode.classList.add('family-report-screen-export-target');
  reportNode.style.display = 'block';
  reportNode.style.boxSizing = 'border-box';
  reportNode.style.width = `${width}px`;
  reportNode.style.maxWidth = 'none';
  reportNode.style.margin = '0';
  reportNode.style.marginLeft = '0';
  reportNode.style.marginRight = '0';
  reportNode.style.minHeight = '1px';
  reportNode.style.overflow = 'visible';
  reportNode.style.background = backgroundColor;
  normalizeCanvasColorValues(reportNode, { includeCompositeColors: false });
}

function preparePageStyleReportNode(reportNode: HTMLElement, width: number) {
  reportNode.classList.add('family-report-pdf-target');
  reportNode.classList.add('html2canvas-safe-export');
  reportNode.style.boxSizing = 'border-box';
  reportNode.style.width = `${width}px`;
  reportNode.style.maxWidth = 'none';
  reportNode.style.minHeight = '1px';
  reportNode.style.overflow = 'visible';
  reportNode.style.background = '#F4F8FC';
  reportNode.style.padding = '24px';

  reportNode.querySelectorAll<HTMLElement>('[data-family-report-raw-note], [data-report-canvas-skip], [data-report-export-table]').forEach((node) => {
    node.remove();
  });
  reportNode.querySelectorAll<HTMLElement>('[data-report-export-cards]').forEach((node) => {
    node.classList.remove('hidden', 'md:hidden');
    node.style.setProperty('display', 'block', 'important');
    node.style.setProperty('width', '100%', 'important');
  });
  reportNode.querySelectorAll<HTMLElement>('.print-only').forEach((node) => {
    node.style.display = 'none';
  });
  preparePageStyleTableWidths(reportNode);
  normalizeCanvasColorValues(reportNode);
}

function preparePageStyleTableWidths(reportNode: HTMLElement) {
  reportNode.querySelectorAll<HTMLElement>('[data-pdf-table-wrap]').forEach((node) => {
    node.style.setProperty('overflow', 'visible', 'important');
    node.style.setProperty('width', '100%', 'important');
    node.style.setProperty('max-width', '100%', 'important');
  });
  reportNode.querySelectorAll<HTMLElement>('table').forEach((table) => {
    table.style.setProperty('width', '100%', 'important');
    table.style.setProperty('min-width', '0', 'important');
    table.style.setProperty('max-width', '100%', 'important');
    table.style.setProperty('table-layout', 'fixed', 'important');
  });
  reportNode.querySelectorAll<HTMLElement>('th,td').forEach((cell) => {
    cell.style.setProperty('min-width', '0', 'important');
    cell.style.setProperty('white-space', 'normal', 'important');
    cell.style.setProperty('word-break', 'break-word', 'important');
    cell.style.setProperty('vertical-align', 'top', 'important');
  });
}

function escapeHtml(value: string) {
  return String(value || '').replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[char] || char;
  });
}

function shouldOpenPdfPreviewWindow() {
  const userAgent = navigator.userAgent || '';
  return (
    isWeChatBrowser() ||
    isWeChatMiniProgramWebView() ||
    /MicroMessenger|Mobi|Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth <= 820)
  );
}

function shouldUseInPageReportExport() {
  const userAgent = navigator.userAgent || '';
  return (
    isWeChatBrowser() ||
    isWeChatMiniProgramWebView() ||
    /MicroMessenger|MiniProgram|miniProgram|Mobi|Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth <= 820)
  );
}

export function getReportExportControlText() {
  return shouldUseInPageReportExport() ? '长图' : 'PDF';
}

export function getReportExportControlTitle() {
  return shouldUseInPageReportExport() ? '生成完整报告长图' : '导出 PDF';
}

function getPdfRenderScale() {
  const deviceScale = window.devicePixelRatio || 1;
  return shouldOpenPdfPreviewWindow() ? Math.min(1.35, deviceScale) : Math.min(1.6, deviceScale);
}

function triggerPdfBlobDownload(pdfBlob: Blob, fileName: string) {
  const pdfUrl = URL.createObjectURL(pdfBlob);
  const link = document.createElement('a');
  link.href = pdfUrl;
  link.download = `${fileName}.pdf`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60 * 1000);
}

function triggerImageBlobDownload(imageBlob: Blob, fileName: string) {
  const imageUrl = URL.createObjectURL(imageBlob);
  const link = document.createElement('a');
  link.href = imageUrl;
  link.download = `${fileName}.jpg`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(imageUrl), 60 * 1000);
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.92) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('REPORT_IMAGE_BLOB_UNAVAILABLE'));
      }
    }, type, quality);
  });
}

export function addCanvasPagesToPdf(pdf: import('jspdf').jsPDF, canvas: HTMLCanvasElement) {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const pageCanvasHeight = Math.max(1, Math.floor((canvas.width * pageHeight) / pageWidth));
  const pageCanvas = document.createElement('canvas');
  const pageContext = pageCanvas.getContext('2d');
  if (!pageContext) throw new Error('PDF_PAGE_CANVAS_CONTEXT_UNAVAILABLE');

  pageCanvas.width = canvas.width;
  for (let sourceY = 0, pageIndex = 0; sourceY < canvas.height; sourceY += pageCanvasHeight, pageIndex += 1) {
    const sliceHeight = Math.min(pageCanvasHeight, canvas.height - sourceY);
    pageCanvas.height = sliceHeight;
    pageContext.fillStyle = '#ffffff';
    pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    pageContext.drawImage(canvas, 0, sourceY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);

    if (pageIndex > 0) pdf.addPage();
    const imageHeight = (sliceHeight * pageWidth) / canvas.width;
    const imageData = pageCanvas.toDataURL('image/jpeg', 0.88);
    pdf.addImage(imageData, 'JPEG', 0, 0, pageWidth, imageHeight, undefined, 'FAST');
  }
}

function fitCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const value = String(text || '').trim();
  if (context.measureText(value).width <= maxWidth) return value;
  let next = '';
  for (const char of Array.from(value)) {
    if (context.measureText(`${next}${char}...`).width > maxWidth) break;
    next += char;
  }
  return `${next || value.slice(0, 8)}...`;
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const rows: string[] = [];
  let current = '';
  for (const char of Array.from(normalized)) {
    const next = `${current}${char}`;
    if (current && context.measureText(next).width > maxWidth) {
      rows.push(current);
      current = char.trimStart();
    } else {
      current = next;
    }
  }
  if (current) rows.push(current);
  return rows;
}

type ReportCanvasBlockKind = 'meta' | 'section' | 'heading' | 'item' | 'body';

type ReportCanvasBlock = {
  kind: ReportCanvasBlockKind;
  text: string;
};

function normalizeReportCanvasText(value: string) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\s*：\s*/g, '：').trim();
}

function truncateReportCanvasText(value: string, maxLength: number) {
  const normalized = normalizeReportCanvasText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactReportCanvasText(kind: ReportCanvasBlockKind, value: string) {
  const normalized = normalizeReportCanvasText(value);
  if (kind === 'section' || kind === 'heading' || kind === 'meta') return normalized;
  return truncateReportCanvasText(normalized, kind === 'item' ? 64 : 78);
}

function shouldSkipReportCanvasText(value: string) {
  return [
    '保单解析报告',
    '阅读确认后保存保单',
    '保存后会进入“我的保单”详情。',
    '以下内容来自本次 OCR 识别和责任解析。',
    '暂无 OCR 原文',
  ].includes(value);
}

function pushReportCanvasBlock(blocks: ReportCanvasBlock[], kind: ReportCanvasBlockKind, text: string) {
  const normalized = compactReportCanvasText(kind, text);
  if (!normalized || shouldSkipReportCanvasText(normalized)) return;
  if (/^生成时间：/.test(normalized)) return;
  const previous = blocks[blocks.length - 1];
  if (previous?.kind === kind && previous.text === normalized) return;
  blocks.push({ kind, text: normalized });
}

function extractReportBlocksForCanvas(target: HTMLElement) {
  const clone = target.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.no-print, script, style, svg, button, input, textarea, select, [data-family-report-raw-note], [data-report-canvas-skip]').forEach((node) => node.remove());
  const blocks: ReportCanvasBlock[] = [
    {
      kind: 'meta',
      text: `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    },
  ];
  const consumed = new WeakSet<Element>();
  const elements = Array.from(clone.querySelectorAll('h1,h2,h3,h4,p,li'));
  for (const element of elements) {
    if (consumed.has(element)) continue;
    const tagName = element.tagName.toLowerCase();
    const text = normalizeReportCanvasText(element.textContent || '');
    if (!text) continue;

    if (tagName === 'p') {
      const parent = element.parentElement;
      const siblingParagraphs = parent
        ? Array.from(parent.children).filter((child) => child.tagName.toLowerCase() === 'p')
        : [];
      if (siblingParagraphs.length === 2 && siblingParagraphs[0] === element) {
        const label = normalizeReportCanvasText(siblingParagraphs[0].textContent || '');
        const value = normalizeReportCanvasText(siblingParagraphs[1].textContent || '');
        consumed.add(siblingParagraphs[1]);
        pushReportCanvasBlock(blocks, 'item', value ? `${label}：${value}` : label);
        continue;
      }
      if (element.querySelector('strong')) {
        pushReportCanvasBlock(blocks, 'item', text);
        continue;
      }
      pushReportCanvasBlock(blocks, 'body', text);
      continue;
    }

    if (tagName === 'li') {
      pushReportCanvasBlock(blocks, 'body', `• ${text}`);
    } else if (tagName === 'h2' || tagName === 'h3') {
      pushReportCanvasBlock(blocks, 'section', text);
    } else if (tagName === 'h4') {
      pushReportCanvasBlock(blocks, 'heading', text);
    }
  }
  return blocks;
}

function drawRoundedCanvasRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

type ReportCanvasBlockStyle = {
  fontSize: number;
  fontWeight: 400 | 600 | 700;
  lineHeight: number;
  before: number;
  after: number;
  color: string;
  indent: number;
};

type PreparedReportCanvasBlock = {
  block: ReportCanvasBlock;
  style: ReportCanvasBlockStyle;
  wrapped: string[];
  verticalPadding: number;
  blockHeight: number;
};

function getReportCanvasBlockStyle(kind: ReportCanvasBlockKind): ReportCanvasBlockStyle {
  if (kind === 'section') {
    return { fontSize: 39, fontWeight: 700, lineHeight: 56, before: 26, after: 16, color: '#1d4ed8', indent: 0 };
  }
  if (kind === 'heading') {
    return { fontSize: 35, fontWeight: 700, lineHeight: 51, before: 20, after: 10, color: '#0f172a', indent: 0 };
  }
  if (kind === 'item') {
    return { fontSize: 33, fontWeight: 600, lineHeight: 50, before: 10, after: 10, color: '#0f172a', indent: 0 };
  }
  if (kind === 'meta') {
    return { fontSize: 31, fontWeight: 400, lineHeight: 46, before: 4, after: 24, color: '#64748b', indent: 0 };
  }
  return { fontSize: 35, fontWeight: 400, lineHeight: 54, before: 10, after: 18, color: '#0f172a', indent: 0 };
}

function prepareReportCanvasBlocks(
  context: CanvasRenderingContext2D,
  blocks: ReportCanvasBlock[],
  maxTextWidth: number,
): PreparedReportCanvasBlock[] {
  return blocks.map((block) => {
    const style = getReportCanvasBlockStyle(block.kind);
    context.font = `${style.fontWeight} ${style.fontSize}px Arial, sans-serif`;
    const textWidth = block.kind === 'item' ? maxTextWidth - 36 : maxTextWidth - style.indent;
    const wrapped = wrapCanvasText(context, block.text, textWidth);
    const verticalPadding = block.kind === 'item' ? 16 : 0;
    const blockHeight = style.before + wrapped.length * style.lineHeight + verticalPadding * 2 + style.after;
    return { block, style, wrapped, verticalPadding, blockHeight };
  });
}

function drawPreparedReportCanvasBlock(
  context: CanvasRenderingContext2D,
  prepared: PreparedReportCanvasBlock,
  y: number,
  marginX: number,
  maxTextWidth: number,
) {
  const { block, style, wrapped, verticalPadding } = prepared;
  let nextY = y + style.before;

  if (block.kind === 'section') {
    context.fillStyle = '#2563eb';
    drawRoundedCanvasRect(context, marginX, nextY - 27, 8, 30, 4);
    context.fill();
  }

  if (block.kind === 'item') {
    context.fillStyle = '#f8fbff';
    drawRoundedCanvasRect(
      context,
      marginX - 14,
      nextY - 24,
      maxTextWidth + 28,
      wrapped.length * style.lineHeight + verticalPadding * 2,
      14,
    );
    context.fill();
    nextY += verticalPadding;
  }

  context.font = `${style.fontWeight} ${style.fontSize}px Arial, sans-serif`;
  context.fillStyle = style.color;
  for (const row of wrapped) {
    context.fillText(row, marginX + style.indent, nextY);
    nextY += style.lineHeight;
  }
  if (block.kind === 'item') nextY += verticalPadding;
  return nextY + style.after;
}

export function renderReportToLongImage(target: HTMLElement, fileName: string) {
  const pageWidth = 900;
  const marginX = 58;
  const headerHeight = 74;
  const contentTopPadding = 34;
  const footerHeight = 58;
  const maxTextWidth = pageWidth - marginX * 2;
  const blocks = extractReportBlocksForCanvas(target);
  const measureCanvas = document.createElement('canvas');
  const measureContext = measureCanvas.getContext('2d');
  if (!measureContext) throw new Error('REPORT_CANVAS_CONTEXT_UNAVAILABLE');
  const preparedBlocks = prepareReportCanvasBlocks(measureContext, blocks, maxTextWidth);
  const contentHeight = preparedBlocks.reduce((sum, block) => sum + block.blockHeight, 0);
  const canvasHeight = Math.max(420, Math.ceil(headerHeight + contentTopPadding + contentHeight + footerHeight));
  const canvas = document.createElement('canvas');
  canvas.width = pageWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('REPORT_CANVAS_CONTEXT_UNAVAILABLE');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pageWidth, canvasHeight);
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, pageWidth, headerHeight);
  context.fillStyle = '#0f172a';
  context.font = '700 24px Arial, sans-serif';
  context.fillText(fitCanvasText(context, fileName, pageWidth - marginX * 2), marginX, 46);

  let y = headerHeight + contentTopPadding;
  for (const block of preparedBlocks) {
    y = drawPreparedReportCanvasBlock(context, block, y, marginX, maxTextWidth);
  }

  context.fillStyle = '#94a3b8';
  context.font = '400 20px Arial, sans-serif';
  context.fillText('完整报告长图', marginX, canvasHeight - 24);
  return canvas.toDataURL('image/jpeg', 0.9);
}

export function createInPageReportExportPanel(fileName: string) {
  document.getElementById('pdf-inpage-export')?.remove();
  const previousOverflow = document.body.style.overflow;
  const objectUrls: string[] = [];
  const overlay = document.createElement('div');
  overlay.id = 'pdf-inpage-export';
  overlay.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'z-index:10000',
      'background:#f8fafc',
      'color:#0f172a',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'overflow:auto',
      '-webkit-overflow-scrolling:touch',
      'box-sizing:border-box',
    ].join(';'),
  );
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  function close() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    document.body.style.overflow = previousOverflow;
    overlay.remove();
  }

  function setHtml(html: string) {
    overlay.innerHTML = html;
  }

  overlay.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.dataset.action === 'close') close();
  });

  setHtml(`
    <main style="min-height:100%;box-sizing:border-box;padding:24px 16px 36px">
      <section style="margin:0 auto;max-width:520px;border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:22px;text-align:center;box-sizing:border-box">
        <h1 style="margin:0 0 8px;font-size:20px;line-height:1.35">正在生成报告</h1>
        <p style="margin:0;color:#64748b;font-size:14px;line-height:1.8">微信里不再跳转新窗口，请停留在当前页面。</p>
      </section>
    </main>
  `);

  return {
    close,
    update(message: string, detail = '请稍候，报告较长时需要几秒钟。') {
      setHtml(`
        <main style="min-height:100%;box-sizing:border-box;padding:24px 16px 36px">
          <section style="margin:0 auto;max-width:520px;border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:22px;text-align:center;box-sizing:border-box">
            <h1 style="margin:0 0 8px;font-size:20px;line-height:1.35">${escapeHtml(message)}</h1>
            <p style="margin:0;color:#64748b;font-size:14px;line-height:1.8">${escapeHtml(detail)}</p>
          </section>
        </main>
      `);
    },
    showResult(reportImage: string, downloadHref = reportImage) {
      const safeFileName = escapeHtml(fileName);
      const safeReportImage = escapeHtml(reportImage);
      const safeDownloadHref = escapeHtml(downloadHref);
      const useLongPressSave = isWeChatBrowser() || isWeChatMiniProgramWebView();
      const primaryAction = useLongPressSave
        ? '<span style="flex:1;border:0;border-radius:12px;background:#2563eb;color:#fff;padding:12px;text-align:center;font-size:15px;font-weight:800">长按图片保存</span>'
        : `<a href="${safeDownloadHref}" download="${safeFileName}.jpg" style="flex:1;border:0;border-radius:12px;background:#2563eb;color:#fff;padding:12px;text-align:center;font-size:15px;font-weight:800;text-decoration:none">下载长图</a>`;
      const saveHint = useLongPressSave ? '下面是一张包含整份报告的长图，长按下面图片保存到相册。' : '下面是一张包含整份报告的长图，点击“下载长图”保存。';
      setHtml(`
        <main style="box-sizing:border-box;padding:16px 14px 32px">
          <section style="position:sticky;top:0;z-index:1;margin:0 auto 14px;max-width:520px;border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:18px;box-shadow:0 12px 30px rgba(15,23,42,.08);box-sizing:border-box">
            <h1 style="margin:0;font-size:20px;line-height:1.35">完整报告长图已生成</h1>
            <p style="margin:6px 0 0;color:#64748b;font-size:13px;line-height:1.7">${safeFileName}</p>
            <div style="display:flex;gap:10px;margin-top:14px">
              ${primaryAction}
              <button data-action="close" type="button" style="flex:1;border:0;border-radius:12px;background:#eef2ff;color:#1d4ed8;padding:12px;text-align:center;font-size:15px;font-weight:800">返回报告</button>
            </div>
            <p style="margin:10px 0 0;color:#64748b;font-size:12px;line-height:1.7">${saveHint}</p>
          </section>
          <section style="margin:0 auto;max-width:min(1180px,calc(100vw - 28px))">
            <figure style="margin:14px 0 0">
              <img src="${safeReportImage}" alt="完整报告长图" style="display:block;width:100%;border:1px solid #dbe4ef;border-radius:12px;background:#fff;box-sizing:border-box" />
              <figcaption style="margin-top:6px;color:#64748b;font-size:12px;text-align:center">完整报告长图预览</figcaption>
            </figure>
          </section>
        </main>
      `);
    },
    showBlobResult(imageBlob: Blob) {
      const imageUrl = URL.createObjectURL(imageBlob);
      objectUrls.push(imageUrl);
      this.showResult(imageUrl, imageUrl);
      return imageUrl;
    },
    showError(message = '报告生成失败') {
      setHtml(`
        <main style="min-height:100%;box-sizing:border-box;padding:24px 16px 36px">
          <section style="margin:0 auto;max-width:520px;border:1px solid #fee2e2;border-radius:18px;background:#fff;padding:22px;text-align:center;box-sizing:border-box">
            <h1 style="margin:0 0 8px;font-size:20px;line-height:1.35;color:#dc2626">${escapeHtml(message)}</h1>
            <p style="margin:0;color:#64748b;font-size:14px;line-height:1.8">请返回原页面后使用手机截图保存当前报告。</p>
            <button data-action="close" type="button" style="margin-top:16px;border:0;border-radius:12px;background:#2563eb;color:#fff;padding:12px 18px;font-size:15px;font-weight:800">返回报告</button>
          </section>
        </main>
      `);
    },
  };
}

async function exportReportInCurrentPage(target: HTMLElement, fileName: string) {
  const panel = createInPageReportExportPanel(fileName);
  let reportImage = '';
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    panel.update('正在生成完整报告长图', '微信里不再打开浏览器，生成完成后会在本页显示一张完整长图。');
    reportImage = renderReportToLongImage(target, fileName);
    panel.showResult(reportImage);
  } catch (error) {
    console.error('[policy-ocr-app] in-page report image export failed', error);
    if (reportImage) {
      panel.showResult(reportImage);
    } else {
      panel.showError();
    }
  }
}

async function exportScreenStyledReportImageInCurrentPage(target: HTMLElement, fileName: string, options?: ReportExportOptions) {
  const panel = createInPageReportExportPanel(fileName);
  let reportImage = '';
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    panel.update('正在生成完整报告长图', '生成完成后会在本页显示一张与当前报告样式一致的长图。');
    const canvas = await captureReportImageCanvas(target, fileName, options);
    const imageBlob = await canvasToBlob(canvas);
    reportImage = panel.showBlobResult(imageBlob);
  } catch (error) {
    console.error('[policy-ocr-app] in-page styled report image export failed', error);
    if (reportImage) {
      panel.showResult(reportImage);
    } else {
      panel.showError();
    }
  }
}

export function openPdfPreviewWindow(fileName: string) {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) return null;
  const safeFileName = escapeHtml(fileName);
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeFileName}</title>
    <style>
      body{margin:0;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px;text-align:center;box-sizing:border-box}
      h1{margin:0 0 10px;font-size:20px;line-height:1.35}
      p{margin:0;color:#64748b;font-size:14px;line-height:1.8}
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>正在生成 PDF</h1>
        <p>请保持这个页面打开，生成完成后会显示保存入口。</p>
      </section>
    </main>
  </body>
</html>`);
  previewWindow.document.close();
  return previewWindow;
}

export function showPdfExportFeedback(message = '正在生成 PDF') {
  const existing = document.getElementById('pdf-export-feedback');
  existing?.remove();
  const node = document.createElement('div');
  node.id = 'pdf-export-feedback';
  node.setAttribute(
    'style',
    [
      'position:fixed',
      'inset:0',
      'z-index:9999',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:24px',
      'background:rgba(15,23,42,0.36)',
      'box-sizing:border-box',
    ].join(';'),
  );
  const content = document.createElement('div');
  content.setAttribute(
    'style',
    [
      'width:min(320px,100%)',
      'border-radius:18px',
      'background:#ffffff',
      'padding:22px',
      'text-align:center',
      'box-shadow:0 24px 60px rgba(15,23,42,0.22)',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    ].join(';'),
  );
  content.innerHTML = `<h2 style="margin:0 0 8px;font-size:18px;line-height:1.4;color:#0f172a">${escapeHtml(message)}</h2><p style="margin:0;font-size:13px;line-height:1.7;color:#64748b">请稍候，报告较长时需要几秒钟。</p>`;
  node.appendChild(content);
  document.body.appendChild(node);
  return {
    close(delay = 0) {
      window.setTimeout(() => node.remove(), delay);
    },
    update(nextMessage: string, detail = '请按页面提示保存或预览报告。') {
      content.innerHTML = `<h2 style="margin:0 0 8px;font-size:18px;line-height:1.4;color:#0f172a">${escapeHtml(nextMessage)}</h2><p style="margin:0;font-size:13px;line-height:1.7;color:#64748b">${escapeHtml(detail)}</p>`;
    },
  };
}

export function writePdfPreviewWindow(previewWindow: Window, pdfUrl: string, fileName: string, fileSize = '') {
  const safePdfUrl = escapeHtml(pdfUrl);
  const safeFileName = escapeHtml(fileName);
  const safeFileSize = escapeHtml(fileSize);
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeFileName}</title>
    <style>
      html,body{min-height:100%;margin:0;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      body{display:flex;align-items:center;justify-content:center;padding:28px;box-sizing:border-box}
      main{width:min(420px,100%);border:1px solid #e2e8f0;border-radius:18px;background:#fff;padding:22px;box-shadow:0 20px 45px rgba(15,23,42,.08);box-sizing:border-box}
      h1{margin:0;font-size:20px;line-height:1.35}
      p{margin:8px 0 0;color:#64748b;font-size:13px;line-height:1.7}
      .meta{margin-top:12px;border-radius:12px;background:#f8fafc;padding:10px 12px;color:#334155;font-size:12px;line-height:1.6}
      .actions{display:flex;flex-direction:column;gap:10px;margin-top:18px}
      a{border-radius:12px;padding:12px;text-align:center;text-decoration:none;font-size:15px;font-weight:800}
      .primary{background:#2563eb;color:#fff}
      .secondary{background:#eff6ff;color:#1d4ed8}
    </style>
  </head>
  <body>
    <main>
      <h1>PDF 已生成</h1>
      <p>${safeFileName}</p>
      ${safeFileSize ? `<div class="meta">文件大小：${safeFileSize}</div>` : ''}
      <div class="actions">
        <a class="primary" href="${safePdfUrl}" download="${safeFileName}.pdf">保存 PDF</a>
        <a class="secondary" href="${safePdfUrl}" target="_blank" rel="noopener">备用打开</a>
      </div>
      <p>微信里优先点“保存 PDF”。如果备用打开一直转圈，请返回本页重新点保存，或用右上角在浏览器打开。</p>
    </main>
  </body>
</html>`);
  previewWindow.document.close();
}

export function writePdfPreviewError(previewWindow: Window, fileName: string) {
  const safeFileName = escapeHtml(fileName);
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeFileName}</title>
    <style>
      body{margin:0;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      main{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px;text-align:center;box-sizing:border-box}
      h1{margin:0 0 10px;font-size:20px;line-height:1.35}
      p{margin:0;color:#64748b;font-size:14px;line-height:1.8}
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>PDF 生成失败</h1>
        <p>请返回原页面后重试，或使用手机系统截图/分享保存当前报告。</p>
      </section>
    </main>
  </body>
</html>`);
  previewWindow.document.close();
}

function resolveImageCaptureOptions(options?: ReportExportOptions): ReportExportOptions {
  return { rawTarget: true, ...options, preservePageStyle: false, matchScreenStyle: true };
}

async function captureReportImageCanvas(target: HTMLElement, _title: string, _options?: ReportExportOptions) {
  const { toCanvas } = await import('html-to-image');
  const renderOptions = resolveImageCaptureOptions(_options);
  const backgroundColor = renderOptions.preservePageStyle ? '#F4F8FC' : getScreenStyleReportBackground(target);
  const previousScrollX = window.scrollX;
  const previousScrollY = window.scrollY;
  let renderTarget: ReturnType<typeof createPdfRenderTarget> | null = null;

  window.scrollTo(0, 0);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    renderTarget = createPdfRenderTarget(target, _title, undefined, renderOptions);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const renderWidth = renderTarget.captureWidth || (renderOptions.matchScreenStyle ? getScreenStyleReportWidth(target) : renderTarget.width);
    const renderHeight = Math.ceil(renderTarget.node.scrollHeight || renderTarget.node.offsetHeight || renderTarget.node.getBoundingClientRect().height || 1);
    return await toCanvas(renderTarget.node, {
      backgroundColor,
      width: renderWidth,
      height: renderHeight,
      canvasWidth: renderWidth,
      canvasHeight: renderHeight,
      pixelRatio: getPdfRenderScale(),
      skipFonts: true,
      skipAutoScale: true,
      cacheBust: true,
      includeQueryParams: true,
      style: {
        display: 'block',
        width: `${renderWidth}px`,
        maxWidth: 'none',
        margin: '0',
        marginLeft: '0',
        marginRight: '0',
        minHeight: `${renderHeight}px`,
        overflow: 'visible',
        background: backgroundColor,
        backgroundColor,
      },
    });
  } finally {
    renderTarget?.cleanup();
    window.scrollTo(previousScrollX, previousScrollY);
  }
}

export async function downloadReportPdf(target: HTMLElement | null, title: string, policy?: Policy, options?: ReportExportOptions) {
  if (!target) {
    exportCurrentReportAsPdf(title);
    return;
  }
  const fileName = normalizePdfFileName(title);
  if (shouldUseInPageReportExport()) {
    await exportReportInCurrentPage(target, fileName);
    return;
  }
  const previousTitle = document.title;
  const shouldUsePreviewWindow = shouldOpenPdfPreviewWindow();
  const previewWindow = shouldUsePreviewWindow ? openPdfPreviewWindow(fileName) : null;
  const feedback = shouldUsePreviewWindow ? showPdfExportFeedback() : null;
  let renderTarget: ReturnType<typeof createPdfRenderTarget> | null = null;
  try {
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
    document.title = fileName;
    document.body.classList.add(options?.preservePageStyle ? 'pdf-page-style-export-mode' : 'pdf-export-mode');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderTarget = createPdfRenderTarget(target, fileName, policy, options);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const renderWidth = renderTarget.captureWidth || renderTarget.node.scrollWidth || renderTarget.width;
    const renderHeight = renderTarget.node.scrollHeight || renderTarget.node.offsetHeight;
    const canvas = await html2canvas(renderTarget.node, {
      backgroundColor: '#ffffff',
      scale: getPdfRenderScale(),
      useCORS: false,
      width: renderWidth,
      height: renderHeight,
      windowWidth: renderWidth,
      windowHeight: renderHeight,
    });
    renderTarget.cleanup();
    renderTarget = null;
    const pdf = new jsPDF(options?.preservePageStyle ? 'l' : 'p', 'mm', 'a4');
    addCanvasPagesToPdf(pdf, canvas);
    if (shouldUsePreviewWindow) {
      const pdfBlob = pdf.output('blob');
      const pdfUrl = URL.createObjectURL(pdfBlob);
      window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 5 * 60 * 1000);
      if (previewWindow && !previewWindow.closed) {
        writePdfPreviewWindow(previewWindow, pdfUrl, fileName, formatFileSize(pdfBlob.size));
        feedback?.update('PDF 已生成', '请在刚打开的页面里点“保存 PDF”。');
        feedback?.close(900);
      } else {
        triggerPdfBlobDownload(pdfBlob, fileName);
        feedback?.update('PDF 已生成', '已尝试调起系统保存。');
        feedback?.close(1200);
      }
      return;
    }
    pdf.save(`${fileName}.pdf`);
  } catch (error) {
    console.error('[policy-ocr-app] PDF export failed', error);
    if (previewWindow && !previewWindow.closed) {
      writePdfPreviewError(previewWindow, fileName);
    }
    feedback?.update('PDF 生成失败', '正在尝试调用系统打印功能。');
    feedback?.close(1200);
    exportCurrentReportAsPdf(fileName);
  } finally {
    renderTarget?.cleanup();
    if (!shouldUsePreviewWindow) feedback?.close();
    document.body.classList.remove('pdf-export-mode');
    document.body.classList.remove('pdf-page-style-export-mode');
    document.title = previousTitle;
  }
}

export async function downloadReportImage(target: HTMLElement | null, title: string, options?: ReportExportOptions) {
  const imageTarget = target || document.querySelector<HTMLElement>('.print-policy-report');
  if (!imageTarget) {
    const feedback = showPdfExportFeedback('图片生成失败');
    feedback.update('图片生成失败', '没有找到可导出的报告内容，请刷新后重试。');
    feedback.close(1600);
    return;
  }
  const fileName = normalizePdfFileName(title);
  if (shouldUseInPageReportExport()) {
    await exportScreenStyledReportImageInCurrentPage(imageTarget, fileName, { rawTarget: true, ...options });
    return;
  }

  const previousTitle = document.title;
  const feedback = showPdfExportFeedback('正在生成图片');
  try {
    document.title = fileName;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const canvas = await captureReportImageCanvas(imageTarget, fileName, { rawTarget: true, ...options });
    const imageBlob = await canvasToBlob(canvas);
    triggerImageBlobDownload(imageBlob, fileName);
    feedback.update('图片已生成', '已下载为 JPG 长图。');
    feedback.close(900);
  } catch (error) {
    console.error('[policy-ocr-app] report image export failed', error);
    feedback.update('图片生成失败', '请刷新报告页后重试。');
    feedback.close(1800);
  } finally {
    document.title = previousTitle;
  }
}
