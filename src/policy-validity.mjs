function makeLocalDate(year, month, day, endOfDay) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  else date.setHours(0, 0, 0, 0);
  return date;
}

function parseDateFromText(value, endOfDay) {
  const text = String(value || '').trim();
  if (!text) return null;
  const dateMatch =
    text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/u) ||
    text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u);
  if (!dateMatch) return null;
  return makeLocalDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]), endOfDay);
}

function endOfCoverageDateText(value) {
  if (/零时|0时|00:00|凌晨/u.test(value)) return false;
  return true;
}

export function parseCoveragePeriodEndDate(coveragePeriod, context = {}) {
  const text = String(coveragePeriod || '').trim();
  if (!text || /终身|长期|至身故|身故/u.test(text)) return null;

  const explicitEndDate = parseDateFromText(text, endOfCoverageDateText(text));
  if (explicitEndDate) return explicitEndDate;

  const effectiveDate = parseDateFromText(context.effectiveDate, false);
  if (effectiveDate) {
    const compact = text.replace(/\s+/gu, '');
    const durationMatch = compact.match(/^(?:保险期间|保障期间)?(\d{1,3})年(?:期)?$/u);
    if (durationMatch) {
      const endDate = new Date(effectiveDate);
      endDate.setFullYear(endDate.getFullYear() + Number(durationMatch[1]));
      endDate.setDate(endDate.getDate() - 1);
      endDate.setHours(23, 59, 59, 999);
      return endDate;
    }
  }

  const insuredBirthday = parseDateFromText(context.insuredBirthday, false);
  const ageMatch = text.replace(/\s+/gu, '').match(/(?:至|保至)(\d{1,3})(?:周岁|岁)/u);
  if (insuredBirthday && ageMatch) {
    const endDate = new Date(insuredBirthday);
    endDate.setFullYear(endDate.getFullYear() + Number(ageMatch[1]));
    endDate.setHours(23, 59, 59, 999);
    return endDate;
  }

  return null;
}

export function resolvePolicyValidityStatus(coveragePeriod, context = {}) {
  const expiresAt = parseCoveragePeriodEndDate(coveragePeriod, context);
  const now = context.now || new Date();
  if (expiresAt && expiresAt.getTime() < now.getTime()) {
    return { label: '失效', tone: 'expired', expiresAt };
  }
  return { label: '有效', tone: 'active', expiresAt };
}

export function policyValidityClassName(tone) {
  if (tone === 'expired') return 'bg-rose-50 text-rose-600 ring-rose-100';
  return 'bg-[#EBFBF1] text-[#16A34A] ring-[#CFF3DA]';
}
