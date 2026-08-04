import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDomainWorkerPlan,
  buildWholeDocumentProductProfile,
  mergeDomainWorkerResults,
  runDomainEvidenceWorkers,
  selectBoundOfficialSourceRecords,
} from '../server/product-document-domain-workers.mjs';

const product = {
  company: '中国平安',
  productName: '平安附加两全保险（万能型）',
};

const fullTerms = [
  '目录 7.3 结算利率 7.4 保证利率 9%',
  '平安附加两全保险（万能型）条款',
  '第三条 保险责任 本附加合同提供生存保险金和身故保险金。',
  '第七条 保单账户',
  '7.3 结算利率 我们每月根据实际投资状况确定结算利率，并公布该利率。',
  '7.4 保证利率 本合同保单账户的最低保证利率为年利率1.75%。',
  '7.5 初始费用 追加保险费的初始费用为追加保险费的2%，转入保险费不收取初始费用。',
  '7.6 部分领取 投保人可以申请部分领取保单账户价值，领取后账户价值不得低于约定金额。',
].join('\n\n');

test('whole-document profile detects every product domain before creating one worker per domain', () => {
  const profile = buildWholeDocumentProductProfile({
    ...product,
    records: [{
      ...product,
      url: 'https://life.pingan.com/clause?planCode=839&versionNo=839-1&attachmentType=1',
      fullText: fullTerms,
    }],
  });
  assert.deepEqual(profile.domains, ['universal_life', 'endowment', 'rider']);
  const plan = buildDomainWorkerPlan(profile);
  assert.deepEqual(plan.map((worker) => worker.domain), profile.domains);
  assert.equal(new Set(plan.map((worker) => worker.role)).size, 3);
});

test('domain detection scans the complete official document instead of only its opening pages', () => {
  const profile = buildWholeDocumentProductProfile({
    company: '示例保险',
    productName: '综合保障计划',
    records: [{
      company: '示例保险',
      productName: '综合保障计划',
      url: 'https://example.test/terms.pdf',
      fullText: `${'普通条款内容。'.repeat(2_500)}\n本产品设立万能账户，保单账户的最低保证利率为年利率1.5%。`,
    }],
  });
  assert.ok(profile.domains.includes('universal_life'));
  assert.match(
    profile.evidencePackets.find((packet) => packet.domain === 'universal_life').evidenceText,
    /最低保证利率为年利率1\.5%/u,
  );
});

test('universal evidence ignores navigation-only rate and keeps substantive articles', () => {
  const profile = buildWholeDocumentProductProfile({
    ...product,
    records: [{
      ...product,
      url: 'https://life.pingan.com/clause?planCode=839&versionNo=839-1&attachmentType=1',
      fullText: fullTerms,
    }],
  });
  const evidence = profile.evidencePackets.find((packet) => packet.domain === 'universal_life').evidenceText;
  assert.match(evidence, /最低保证利率为年利率1\.75%/u);
  assert.match(evidence, /追加保险费的2%/u);
  assert.match(evidence, /部分领取保单账户价值/u);
  assert.doesNotMatch(evidence, /目录[^\n]*9%/u);
});

test('same plan version attachments share a profile while different versions block workers', () => {
  const sameVersion = buildWholeDocumentProductProfile({
    ...product,
    records: [1, 7].map((attachmentType) => ({
      ...product,
      url: `https://life.pingan.com/clause?planCode=839&versionNo=839-1&attachmentType=${attachmentType}`,
      fullText: fullTerms,
    })),
  });
  assert.equal(sameVersion.versionConflict, false);
  assert.equal(buildDomainWorkerPlan(sameVersion).length, 3);

  const conflict = buildWholeDocumentProductProfile({
    ...product,
    records: ['839-1', '839-2'].map((versionNo) => ({
      ...product,
      url: `https://life.pingan.com/clause?planCode=839&versionNo=${versionNo}&attachmentType=1`,
      fullText: fullTerms,
    })),
  });
  assert.equal(conflict.versionConflict, true);
  assert.deepEqual(buildDomainWorkerPlan(conflict), []);
});

test('policy-bound source keeps its exact plan version and excludes historical versions', () => {
  const records = ['1050-3', '1050-4', '1050-5'].flatMap((versionNo) => [1, 7].map((attachmentType) => ({
    url: `https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=1050&versionNo=${versionNo}&attachmentType=${attachmentType}`,
    sourceDigest: `sha256:${versionNo}:${attachmentType}`,
    fullText: fullTerms,
  })));
  const selected = selectBoundOfficialSourceRecords(records, {
    sourceUrl: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=1050&versionNo=1050-4&attachmentType=1',
  });

  assert.equal(selected.length, 2);
  assert.ok(selected.every((record) => record.url.includes('versionNo=1050-4')));
  assert.equal(buildWholeDocumentProductProfile({ ...product, records: selected }).versionConflict, false);
  assert.equal(buildWholeDocumentProductProfile({ ...product, records }).versionConflict, true);
});

test('bound digest never falls through to a different file at the same URL', () => {
  const records = [{
    url: 'https://official.example.test/terms.pdf',
    sourceDigest: 'sha256:new-content',
    fullText: fullTerms,
  }];
  assert.deepEqual(selectBoundOfficialSourceRecords(records, {
    sourceDigest: 'sha256:policy-bound-content',
    sourceUrl: records[0].url,
  }), []);
});

test('domain workers run independently and failed domain does not remove base responsibilities', async () => {
  const profile = buildWholeDocumentProductProfile({
    ...product,
    records: [{ ...product, url: 'https://life.pingan.com/clause?planCode=839&versionNo=839-1&attachmentType=1', fullText: fullTerms }],
  });
  const calls = [];
  const results = await runDomainEvidenceWorkers({
    product,
    plan: buildDomainWorkerPlan(profile),
    generateWorker: async ({ domain }) => {
      calls.push(domain);
      if (domain === 'rider') throw Object.assign(new Error('timeout'), { code: 'timeout' });
      return {
        domain,
        purposeFacts: [`${domain}用途`],
        functionFacts: domain === 'universal_life' ? ['最低保证利率为年利率1.75%'] : [],
        attentionFacts: [],
      };
    },
  });
  assert.deepEqual(calls.sort(), ['endowment', 'rider', 'universal_life']);
  const merged = mergeDomainWorkerResults({
    mainResponsibilities: [{ title: '生存保险金' }, { title: '身故保险金' }],
    contentBlocks: [{ blockKey: 'responsibilities', title: '主要保险责任', order: 2, content: '生存保险金\n身故保险金' }],
  }, results);
  assert.deepEqual(merged.mainResponsibilities.map((item) => item.title), ['生存保险金', '身故保险金']);
  assert.match(merged.contentBlocks.find((block) => block.blockKey === 'productFunctions').content, /1\.75%/u);
  assert.deepEqual(merged.domainWorkerFailures, [{ domain: 'rider', errorCode: 'timeout' }]);
});
