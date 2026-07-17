const VALIDATION_SKILL = 'evidence_validation';

function text(value, limit = 240) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeStrings(value, limit = 20) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => text(item)).filter(Boolean))].slice(0, limit);
}

function validatePlan(plan, allowedSkills, maxRounds) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('insurance expert plan is required');
  }
  const skills = normalizeStrings(plan.skills, 20);
  if (!skills.length || !skills.includes(VALIDATION_SKILL)) {
    throw new TypeError('insurance expert plan must include evidence_validation');
  }
  if (skills.some((skill) => !allowedSkills.has(skill))) {
    throw new TypeError('insurance expert plan contains an unauthorized skill');
  }
  const rounds = Number(plan.maxRetrievalRounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > maxRounds) {
    throw new TypeError('insurance expert plan maxRetrievalRounds is invalid');
  }
  return Object.freeze({
    skills: Object.freeze(skills),
    queryAspects: Object.freeze(normalizeStrings(plan.queryAspects)),
    evidenceGoals: Object.freeze(normalizeStrings(plan.evidenceGoals)),
    maxRetrievalRounds: rounds,
    reason: text(plan.reason, 200),
  });
}

function normalizeValidation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.complete !== 'boolean') {
    throw new TypeError('evidence_validation returned an invalid result');
  }
  return Object.freeze({
    complete: value.complete,
    missingEvidence: Object.freeze(normalizeStrings(value.missingEvidence)),
  });
}

export function createInsuranceExpertAgentLoop({
  allowedSkills,
  executeSkill,
  composeAnswer,
  maxRounds = 2,
} = {}) {
  const allowed = new Set(Array.isArray(allowedSkills) || allowedSkills instanceof Set
    ? allowedSkills : []);
  if (!allowed.size || !allowed.has(VALIDATION_SKILL)) {
    throw new TypeError('insurance expert allowedSkills must include evidence_validation');
  }
  if (typeof executeSkill !== 'function') {
    throw new TypeError('insurance expert executeSkill is required');
  }
  if (typeof composeAnswer !== 'function') {
    throw new TypeError('insurance expert composeAnswer is required');
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 8) {
    throw new TypeError('insurance expert maxRounds is invalid');
  }

  async function run({ context, plan } = {}) {
    const trustedPlan = validatePlan(plan, allowed, maxRounds);
    const evidence = [];
    const executedSkills = trustedPlan.skills.filter((skill) => skill !== VALIDATION_SKILL);
    let missingEvidence = [];
    let validation = Object.freeze({ complete: false, missingEvidence: Object.freeze([]) });
    let completedRounds = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
      completedRounds = round;
      for (const skill of executedSkills) {
        const result = await executeSkill({
          skill,
          context,
          plan: trustedPlan,
          round,
          evidence: Object.freeze([...evidence]),
          missingEvidence: Object.freeze([...missingEvidence]),
        });
        evidence.push(Object.freeze({ skill, round, result }));
      }

      validation = normalizeValidation(await executeSkill({
        skill: VALIDATION_SKILL,
        context,
        plan: trustedPlan,
        round,
        evidence: Object.freeze([...evidence]),
        missingEvidence: Object.freeze([...missingEvidence]),
      }));
      if (validation.complete) break;
      missingEvidence = [...validation.missingEvidence];
    }

    return composeAnswer({
      context,
      plan: trustedPlan,
      evidence: Object.freeze([...evidence]),
      validation,
      rounds: completedRounds,
    });
  }

  return Object.freeze({ run });
}
