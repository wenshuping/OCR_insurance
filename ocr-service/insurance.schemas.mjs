import { z } from 'zod';

const policyAnalysisSnapshotSchema = z.object({
  productOverview: z.string().trim().min(1, '产品概述不能为空'),
  coreFeature: z.string().trim().min(1, '核心特点不能为空'),
  coverageTable: z
    .array(
      z.object({
        coverageType: z.string().trim().min(1, '保障类型不能为空'),
        scenario: z.string().trim().min(1, '保障情形不能为空'),
        payout: z.string().trim().min(1, '赔付金额不能为空'),
        note: z.string().trim().min(1, '责任说明不能为空'),
      }),
    )
    .default([]),
  exclusions: z.array(z.string().trim().min(1)).default([]),
  purchaseAdvice: z.string().trim().min(1, '投保建议不能为空'),
  disclaimer: z.string().trim().min(1, '免责声明不能为空'),
  model: z.string().trim().min(1, '模型名称不能为空'),
  generatedAt: z.string().trim().min(1, '生成时间不能为空'),
  cached: z.boolean().optional(),
});

export const createPolicyBodySchema = z.object({
  customerId: z.coerce.number().int().positive().optional(),
  company: z.string().trim().min(1, '保险公司不能为空'),
  name: z.string().trim().min(1, '保单名称不能为空'),
  applicant: z.string().trim().min(1, '投保人不能为空'),
  applicantRelation: z.string().trim().min(1, '请选择投保人与录入人的关系'),
  insured: z.string().trim().min(1, '被保人不能为空'),
  insuredRelation: z.string().trim().min(1, '请选择被保险人与录入人的关系'),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD'),
  paymentPeriod: z.string().trim().min(1, '缴费期不能为空'),
  coveragePeriod: z.string().trim().min(1, '保障期不能为空'),
  amount: z.coerce.number().positive('保额必须大于0'),
  firstPremium: z.coerce.number().positive('首期保费必须大于0'),
  type: z.string().trim().optional(),
  analysis: policyAnalysisSnapshotSchema.optional().nullable(),
});

export const updatePolicyBodySchema = createPolicyBodySchema;

export const scanPolicyBodySchema = z
  .object({
    ocrText: z.string().trim().optional(),
    uploadItem: z
      .object({
        name: z.string().trim().min(1, '文件名不能为空'),
        type: z.string().trim().min(1, '文件类型不能为空'),
        dataUrl: z.string().trim().min(1, '上传内容不能为空'),
      })
      .optional(),
  })
  .refine((value) => Boolean(value.ocrText || value.uploadItem), {
    message: '请上传保单图片或提供 OCR 文本',
    path: ['uploadItem'],
  });

export const policyIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const analysisPolicySnapshotSchema = z.object({
  company: z.string().trim().min(1, '保险公司不能为空'),
  name: z.string().trim().min(1, '保单名称不能为空'),
  date: z.string().trim().optional().default(''),
  amount: z.coerce.number().positive('保额必须大于0').optional(),
  firstPremium: z.coerce.number().positive('年交保费必须大于0').optional(),
});

export const analyzePolicyBodySchema = z
  .object({
    policyId: z.coerce.number().int().positive().optional(),
    policy: analysisPolicySnapshotSchema.optional(),
  })
  .refine((value) => Boolean(value.policyId || value.policy), {
    message: '请提供保单ID或保单内容',
    path: ['policyId'],
  });

const looseRecordSchema = z.record(z.string(), z.unknown());
const looseRecordArraySchema = z.array(looseRecordSchema);

export const generateFamilyPolicyReportBodySchema = z
  .object({
    reportName: z.string().trim().optional(),
    report_name: z.string().trim().optional(),
    reportDate: z.string().trim().optional(),
    report_date: z.string().trim().optional(),
    generatorName: z.string().trim().optional(),
    generator_name: z.string().trim().optional(),
    familyProfile: looseRecordSchema.optional(),
    family_profile: looseRecordSchema.optional(),
    scoreSummary: looseRecordSchema.optional(),
    score_summary: looseRecordSchema.optional(),
    policyFacts: looseRecordArraySchema.optional(),
    policy_facts: looseRecordArraySchema.optional(),
    policies: looseRecordArraySchema.optional(),
    policy: looseRecordSchema.optional(),
    analysisFacts: looseRecordSchema.optional(),
    analysis_facts: looseRecordSchema.optional(),
    memberDiagnosis: looseRecordArraySchema.optional(),
    member_diagnosis: looseRecordArraySchema.optional(),
    members: looseRecordArraySchema.optional(),
    recommendationCandidates: looseRecordArraySchema.optional(),
    recommendation_candidates: looseRecordArraySchema.optional(),
    boundaryNotes: z.array(z.union([z.string(), looseRecordSchema])).optional(),
    boundary_notes: z.array(z.union([z.string(), looseRecordSchema])).optional(),
    ocrText: z.string().trim().optional(),
    ocr_text: z.string().trim().optional(),
    policyText: z.string().trim().optional(),
    policy_text: z.string().trim().optional(),
    detailMode: z.enum(['auto', 'basic', 'partial', 'detailed']).optional(),
    detail_mode: z.enum(['auto', 'basic', 'partial', 'detailed']).optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      Boolean(
        value.policyFacts ||
          value.policy_facts ||
          value.policies ||
          value.policy ||
          value.familyProfile ||
          value.family_profile ||
          value.memberDiagnosis ||
          value.member_diagnosis ||
          value.analysisFacts ||
          value.analysis_facts ||
          value.ocrText ||
          value.ocr_text ||
          value.policyText ||
          value.policy_text,
      ),
    {
      message: '请至少提供家庭信息、保单信息或OCR/责任摘要',
      path: ['policyFacts'],
    },
  );
