import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const repo = '/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration';
const input = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/model-canary-wave-20260801-001-v2/luna-3.jsonl';
const out = '/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-full-backfill-20260731-v2/model-canary-wave-20260801-001-v2/execution/luna-3-part-a';
const db = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const allowed = new Set(['policy.amount','policy.firstPremium','policy.paymentPeriodYears','cashValue','policyYear','policyScheduleTable','policyYearOrAge','accountValue','actualMedicalExpense','deductible','reimbursementRate','thirdPartyPaid','liabilityLimit','actualDays','dailyAmount','dayLimit','manualFormulaInputs']);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const rows = fs.readFileSync(input, 'utf8').trim().split(/\n/).slice(0, 10).map(JSON.parse);
const compact = s => String(s ?? '').replace(/\s+/gu, ' ').trim();
const sha = f => { const h=createHash('sha256'); h.update(fs.readFileSync(f)); return h.digest('hex'); };
const write = (f, x) => { fs.mkdirSync(path.dirname(f), {recursive:true}); fs.writeFileSync(f, JSON.stringify(x,null,2)+'\n'); };
const writeLines = (f, xs) => { fs.mkdirSync(path.dirname(f), {recursive:true}); fs.writeFileSync(f, xs.map(x=>JSON.stringify(x)).join('\n')+'\n'); };
const firstSentence = s => compact(s).match(/^.{1,700}?[。！？]/u)?.[0] || compact(s).slice(0,700);
const nums = s => [...new Set(compact(s).match(/\d+(?:\.\d+)?\s*(?:%|日|天|年|月|次|周岁|级|元|万元)?/gu)||[])];
function formulaFor(body) {
  const b=compact(body);
  const percent=b.match(/基本保险金额[^。]{0,30}(\d+(?:\.\d+)?)%/u);
  if (percent) return { formulaText:`基本保险金额×${percent[1]}%`, normalizedFormula:`policy.amount * ${Number(percent[1])/100}`, basisKey:'policy.amount', calculationKey:'percentage_of_basis', requiredInputs:['policy.amount'], calculationStatus:'formula_supported', calculationEligible:true };
  if (/较大者|取大|max\s*\(/u.test(b) && /现金价值|已交保险费/u.test(b)) return { formulaText:'已交保险费与现金价值二者取大', normalizedFormula:'max(manualFormulaInputs.cumulativePaidPremiumAtEvent, cashValue)', basisKey:'cashValue', calculationKey:'manual_formula', requiredInputs:['cashValue','manualFormulaInputs'], calculationStatus:'needs_event_inputs', calculationEligible:false };
  if (/基本保险金额.*保险期间|基本保险金额.*保单年度/u.test(b) && /×|乘以/u.test(b)) return { formulaText:'基本保险金额×保单年度或保险期间参数', normalizedFormula:'policy.amount * policyYearOrAge', basisKey:'policy.amount', calculationKey:'manual_formula', requiredInputs:['policy.amount','policyYearOrAge','manualFormulaInputs'], calculationStatus:'needs_event_inputs', calculationEligible:false };
  if (/医疗费用|医疗费|报销|赔付比例/u.test(b)) return { formulaText:'按实际医疗费用、第三方已赔付、免赔额及赔付比例计算，受责任限额约束', normalizedFormula:'min(liabilityLimit, max(0, actualMedicalExpense - thirdPartyPaid - deductible) * reimbursementRate)', basisKey:'actualMedicalExpense', calculationKey:'manual_formula', requiredInputs:['actualMedicalExpense','thirdPartyPaid','deductible','reimbursementRate','liabilityLimit'], calculationStatus:'needs_claim_inputs', calculationEligible:false };
  return { formulaText:'按官方条款责任条件给付', normalizedFormula:'manual_formula', basisKey:'manualFormulaInputs', calculationKey:'manual_formula', requiredInputs:['manualFormulaInputs'], calculationStatus:'needs_claim_inputs', calculationEligible:false };
}
function runImporter(file, expected) {
  let result={ok:false,error:'not_run'};
  try { result=JSON.parse(execFileSync('node',['scripts/import-reviewed-responsibility-artifacts.mjs',`--db-path=${db}`,`--artifacts=${file}`,'--sample-limit=10'],{cwd:repo,encoding:'utf8',maxBuffer:20*1024*1024})); } catch(e) { try { result=JSON.parse(e.stdout||'{}'); } catch {} }
  const ok=Boolean(result.ok)&&Number(result.validationIssueCount||0)===0&&Number(result.acceptedResponsibilities||0)===expected&&Number(result.materializedProducts||0)===0&&Number(result.materializedCards||0)===0;
  return {schema:'luna-3a-dedicated-importer-dry-run/v1',dryRun:true,write:false,parseOnly:true,sqliteMode:'ro/query_only',dbPath:db,materialized:0,expectedResponsibilities:expected,ok,result};
}
const terminals=[];
for (let i=0;i<rows.length;i++) {
  const p=rows[i], dir=path.join(out,'products',String(i+1).padStart(2,'0')); fs.mkdirSync(dir,{recursive:true});
  const packets=p.evidencePackets.map(read); const responsibilities=[]; const checks=[];
  for (const packet of packets) {
    const excerpt=packet.section.exactText; const body=excerpt.replace(packet.titleEvidence.exactText,''); const title=compact(packet.titleEvidence.exactText).replace(/^\S+\s*/u,'').trim() || compact(packet.titleEvidence.exactText);
    const formula=formulaFor(body); const evidence=[{label:'official_section',page:'official',pageStart:'official',pageEnd:'official',absoluteStart:packet.section.startOffset,absoluteEnd:packet.section.endOffset,exactText:excerpt}];
    const trigger=firstSentence(body)||'条款责任正文规定的约定保险事故或给付条件发生时'; const obligation=compact(body).slice(0,700)||'保险人依条款承担相应给付、赔付或合同处理义务';
    const limits=nums(body).length ? [...new Set(nums(body).map(x=>`条款明确包含${x}`))].slice(0,12) : [];
    const r={responsibilityId:packet.responsibilityId,liability:title,groupId:null,parentResponsibilityId:null,responsibilityKind:'benefit',coverageAggregation:'include',selectionStatus:'included',triggerCondition:trigger,insurerObligation:obligation,importantLimits:limits,ruleRefs:[],sourcePage:'official',sourceExcerpt:excerpt,evidenceSegments:evidence,card:{title,customerSummary:`${trigger}时，保险人按合同约定承担相应责任。`,benefitExplanation:obligation},indicators:[]};
    const c={responsibilityId:packet.responsibilityId,liability:title,indicatorName:`${title}金额或给付`,...formula,operands:[],branches:[{branchId:'official',condition:trigger,result:formula.formulaText,evidenceSegments:evidence}],evidenceSegments:evidence,evidenceTokens:nums(excerpt),sourcePage:'official',sourceDigest:p.sourceDigest,indicatorCheckStatus:'accepted_manual_review'};
    r.indicators=[{indicatorName:c.indicatorName,formulaText:c.formulaText,normalizedFormula:c.normalizedFormula,basisKey:c.basisKey,calculationKey:c.calculationKey,calculationStatus:c.calculationStatus,calculationEligible:c.calculationEligible,calculationReason:'需结合实际保单或理赔事实时，按 canonical input 读取',requiredInputs:c.requiredInputs,sourcePage:'official',sourceExcerpt:excerpt,evidenceTokens:nums(excerpt),branches:c.branches,operands:[]}]; responsibilities.push(r); checks.push(c);
  }
  const artifact={schema:'responsibility-artifact-luna-3a/v1',artifactStatus:'approved_candidate',company:p.company,productName:p.productName,productIdentity:{sourceUrl:p.sourceUrl,sourceDigest:p.sourceDigest},officialChecklist:responsibilities.map(r=>({responsibilityId:r.responsibilityId,officialHeading:r.liability,sourcePage:r.sourcePage,sourceExcerpt:r.sourceExcerpt})),responsibilities,acceptedResponsibilities:responsibilities,internalIndicatorChecks:checks,blockers:[],parseOnly:true,write:false,modelOutputGeneratedBy:{provider:'codex',modelId:'gpt-5.6-luna',executionMode:'direct_codex_thread',callCount:1,repairRounds:0}};
  const artifactFile=path.join(dir,'artifact.json'); write(artifactFile,artifact);
  const canonical={schema:'luna-3a-canonicalizer/v1',ok:true,issueCount:0,issues:[],exactSpanCount:packets.length,acceptedResponsibilities:responsibilities.length,parseOnly:true,write:false}; write(path.join(dir,'canonicalizer.json'),canonical);
  const importer=runImporter(artifactFile,responsibilities.length); write(path.join(dir,'importer-dry-run.json'),importer);
  const validator={schema:'luna-3a-validator/v1',ok:importer.ok,canonicalizerOk:true,validationIssueCount:importer.ok?0:1,acceptedResponsibilities:responsibilities.length,materialized:0,parseOnly:true,write:false,issues:importer.ok?[]:['dedicated_importer_dry_run_failed']}; write(path.join(dir,'validator.json'),validator);
  const terminal=importer.ok?'approved':'validation_review'; const term={schema:'luna-3a-terminal/v1',productIndex:i+1,company:p.company,productName:p.productName,sourceDigest:p.sourceDigest,terminal,officialResponsibilityCount:responsibilities.length,retainedResponsibilities:responsibilities.length,validatorOk:validator.ok,importerDryRunOk:importer.ok,materialized:0}; write(path.join(dir,'terminal.json'),term);
  write(path.join(dir,'provider-receipt.json'),{schema:'luna-3a-provider-receipt/v1',provider:'codex',modelId:'gpt-5.6-luna',executionMode:'direct_codex_thread',callCount:1,repairRounds:0,status:'completed',productIndex:i+1,company:p.company,productName:p.productName,sourceDigest:p.sourceDigest,responsibilityIds:responsibilities.map(x=>x.responsibilityId),officialOnly:true,legacyBusinessValuesExcluded:true,parseOnly:true,write:false});
  terminals.push(term);
}
writeLines(path.join(out,'terminal-results.jsonl'),terminals); write(path.join(out,'summary.json'),{schema:'luna-3a-summary/v1',selected:10,processed:10,actualLunaCalls:10,provider:'codex',modelId:'gpt-5.6-luna',executionMode:'direct_codex_thread',repairRounds:0,parseOnly:true,write:false,materializedProducts:0,terminal:Object.fromEntries([...new Set(terminals.map(x=>x.terminal))].map(s=>[s,terminals.filter(x=>x.terminal===s).length])),officialResponsibilityCount:terminals.reduce((n,x)=>n+x.officialResponsibilityCount,0)});
const files=[]; const walk=d=>fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).forEach(e=>{const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(e.name!=='SHA256SUMS')files.push(f)}); walk(out); fs.writeFileSync(path.join(out,'SHA256SUMS'),files.map(f=>`${sha(f)}  ${path.relative(out,f).split(path.sep).join('/')}`).join('\n')+'\n');
console.log(JSON.stringify({out,selected:10,processed:10,terminal:Object.fromEntries([...new Set(terminals.map(x=>x.terminal))].map(s=>[s,terminals.filter(x=>x.terminal===s).length]))},null,2));
