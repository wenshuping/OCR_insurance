const INACTIVE_STATUSES = new Set(['archived', 'deleted', 'disabled', 'inactive']);
const MAX_CANDIDATES = 10;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFamilyName(value) {
  return clean(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/家庭$/u, '');
}

function familyId(row) {
  const value = Number(row?.familyId ?? row?.id);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function displayName(row) {
  return clean(row?.displayName ?? row?.familyName ?? row?.name);
}

function authorizedFamilies(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const families = [];
  for (const row of value) {
    const id = familyId(row);
    const name = displayName(row);
    const status = clean(row?.status).toLowerCase();
    if (!id || !name || INACTIVE_STATUSES.has(status) || seen.has(id)) continue;
    seen.add(id);
    families.push({ familyId: id, displayName: name, normalizedName: normalizeFamilyName(name) });
  }
  return families.filter((family) => family.normalizedName);
}

function publicEntity(family, matchType, confidence) {
  return {
    familyId: family.familyId,
    displayName: family.displayName,
    matchType,
    confidence,
  };
}

function empty(status) {
  return { status, entity: null, candidates: [] };
}

function familyMention(mentions) {
  const mention = (Array.isArray(mentions) ? mentions : [])
    .find((item) => item?.type === 'family');
  return clean(mention?.rawText);
}

export function createAgentFamilyEntityResolver({ listAuthorizedFamilies } = {}) {
  if (typeof listAuthorizedFamilies !== 'function') {
    throw new TypeError('listAuthorizedFamilies is required');
  }

  return {
    async resolve({ internalUserId, mentions = [], activeFamily = null } = {}) {
      const userId = Number(internalUserId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new TypeError('internalUserId must be a positive integer');
      }

      const families = authorizedFamilies(await listAuthorizedFamilies({ internalUserId: userId }));
      const rawMention = familyMention(mentions);
      if (!rawMention) {
        const activeFamilyId = familyId(activeFamily);
        if (!activeFamilyId) return empty('missing');
        const family = families.find((item) => item.familyId === activeFamilyId);
        return family
          ? { status: 'resolved', entity: publicEntity(family, 'contextual', 1), candidates: [] }
          : empty('missing');
      }

      const requestedName = normalizeFamilyName(rawMention);
      if (!requestedName) return empty('missing');

      const exact = families.filter((family) => family.normalizedName === requestedName);
      if (exact.length === 1) {
        return { status: 'resolved', entity: publicEntity(exact[0], 'exact', 1), candidates: [] };
      }
      if (exact.length > 1) {
        return {
          status: 'ambiguous',
          entity: null,
          candidates: exact.slice(0, MAX_CANDIDATES).map((family) => publicEntity(family, 'exact', 1)),
        };
      }

      const recalled = families.filter((family) => (
        requestedName.length >= 2
        && (family.normalizedName.startsWith(requestedName)
          || requestedName.startsWith(family.normalizedName)
          || family.normalizedName.endsWith(requestedName)
          || requestedName.endsWith(family.normalizedName))
      ));
      if (recalled.length === 0) return empty('not_found');
      return {
        status: 'ambiguous',
        entity: null,
        candidates: recalled.slice(0, MAX_CANDIDATES)
          .map((family) => publicEntity(family, 'prefix', 0.8)),
      };
    },
  };
}
