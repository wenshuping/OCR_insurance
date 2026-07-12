import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePolicyBasicInfoFromLayoutBoxes } from '../ocr-service/policy-basic-info-layout-parser.mjs';

const box = (text, x1, y1, x2, y2) => ({ text, box: [x1, y1, x2, y2], confidence: 0.98 });

test('parsePolicyBasicInfoFromLayoutBoxes extracts right-side basic information fields', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('NCI 新华保险', 60, 30, 220, 55),
    box('保险合同号', 70, 120, 170, 145),
    box('990171228067', 240, 120, 390, 145),
    box('投保人', 70, 165, 140, 190),
    box('冯力', 240, 165, 290, 190),
    box('被保险人', 70, 205, 160, 230),
    box('温舒萍', 240, 205, 320, 230),
    box('证件号码', 70, 245, 160, 270),
    box('330106198712072413', 240, 245, 430, 270),
    box('合同生效日期', 70, 285, 190, 310),
    box('2024年09月30日', 240, 285, 420, 310),
    box('身故保险金受益人', 70, 325, 210, 350),
    box('法定继承人', 240, 325, 340, 350),
  ]);

  assert.equal(result.fields.company, '新华保险');
  assert.equal(result.fields.policyNumber, '990171228067');
  assert.equal(result.fields.applicant, '冯力');
  assert.equal(result.fields.insured, '温舒萍');
  assert.equal(result.fields.insuredIdNumber, '330106198712072413');
  assert.equal(result.fields.insuredBirthday, '1987-12-07');
  assert.equal(result.fields.date, '2024-09-30');
  assert.equal(result.fields.beneficiary, '法定');
  assert.equal(result.fieldConfidence.company, 'high');
  assert.equal(result.fieldConfidence.applicant, 'high');
  assert.equal(result.evidence.company.region, 'header');
});

test('parsePolicyBasicInfoFromLayoutBoxes tolerates common OCR mistakes in person labels', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('NCI 新华保险', 60, 30, 220, 55),
    box('设保人', 70, 165, 140, 190),
    box('冯力', 240, 165, 290, 190),
    box('披保险人', 70, 205, 160, 230),
    box('冯力', 240, 205, 290, 230),
    box('证件号码', 70, 245, 160, 270),
    box('330106198712072413', 240, 245, 430, 270),
  ]);

  assert.equal(result.fields.company, '新华保险');
  assert.equal(result.fields.applicant, '冯力');
  assert.equal(result.fields.insured, '冯力');
  assert.equal(result.fields.insuredBirthday, '1987-12-07');
});

test('parsePolicyBasicInfoFromLayoutBoxes refuses to source core fields from rider table', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人', 70, 120, 140, 145),
    box('张三', 240, 120, 290, 145),
    box('被保险人', 70, 160, 160, 185),
    box('李四', 240, 160, 290, 185),
    box('保险利益表', 70, 260, 180, 285),
    box('险种名称', 70, 300, 160, 325),
    box('保险期间', 260, 300, 350, 325),
    box('附加住院医疗保险', 70, 340, 220, 365),
    box('至2026年12月23日', 260, 340, 430, 365),
    box('附加投保人豁免保险', 70, 380, 240, 405),
  ]);

  assert.equal(result.fields.applicant, '张三');
  assert.equal(result.fields.insured, '李四');
  assert.equal(result.fields.date, '');
  assert.ok(result.ocrWarnings.some((warning) => warning.includes('附加险')));
});

test('parsePolicyBasicInfoFromLayoutBoxes does not treat beneficiary value text as insured label', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人', 70, 120, 140, 145),
    box('张三', 240, 120, 290, 145),
    box('身故保险金受益人', 70, 165, 210, 190),
    box('被保险人的法定继承人', 240, 165, 420, 190),
  ]);

  assert.equal(result.fields.applicant, '张三');
  assert.equal(result.fields.insured, '');
  assert.equal(result.fields.beneficiary, '法定');
});

test('parsePolicyBasicInfoFromLayoutBoxes extracts multiple label value pairs from the same row', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人', 70, 120, 140, 145),
    box('张三', 160, 120, 210, 145),
    box('被保险人', 260, 120, 350, 145),
    box('李四', 370, 120, 420, 145),
  ]);

  assert.equal(result.fields.applicant, '张三');
  assert.equal(result.fields.insured, '李四');
});

test('parsePolicyBasicInfoFromLayoutBoxes does not use the next same-row label as a value', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人', 70, 120, 140, 145),
    box('被保险人', 260, 120, 350, 145),
    box('李四', 370, 120, 420, 145),
  ]);

  assert.equal(result.fields.applicant, '');
  assert.equal(result.fields.insured, '李四');
});

test('parsePolicyBasicInfoFromLayoutBoxes reads policy number before premium due date', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人：', 160, 141, 245, 173),
    box('杜金坤', 298, 136, 377, 169),
    box('No.', 840, 141, 900, 173),
    box('3212010000014897', 920, 141, 1160, 173),
    box('保单号码：', 451, 149, 579, 181),
    box('HP12010000087018', 560, 146, 790, 180),
    box('保费缴至日：2003年02月08日', 805, 165, 1128, 197),
  ]);

  assert.equal(result.fields.applicant, '杜金坤');
  assert.equal(result.fields.policyNumber, 'HP12010000087018');
});

test('parsePolicyBasicInfoFromLayoutBoxes does not use adjacent general labels as person values', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人', 70, 120, 140, 145),
    box('性别', 180, 120, 230, 145),
    box('男', 260, 120, 290, 145),
  ]);

  assert.equal(result.fields.applicant, '');
});

test('parsePolicyBasicInfoFromLayoutBoxes bounds merged inline label values', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人张三被保险人李四', 70, 120, 360, 145),
  ]);

  assert.equal(result.fields.applicant, '张三');
  assert.equal(result.fields.insured, '李四');
});

test('parsePolicyBasicInfoFromLayoutBoxes extracts name-suffixed China Life labels before same-row dates', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('保险资料', 70, 100, 150, 125),
    box('产品名称:国寿鑫颐宝两全保险（2024版）', 70, 140, 460, 165),
    box('投保人姓名:翟卿', 70, 180, 210, 205),
    box('合同成立日期:2024年12月05日', 480, 180, 730, 205),
    box('主险明细', 70, 230, 150, 255),
    box('险种名称:国寿鑫颐宝两全保险（2024版）', 70, 270, 460, 295),
    box('保单号:2024330133SCW500032558', 70, 310, 360, 335),
    box('保单生效日:2024年12月06日', 480, 310, 730, 335),
    box('被保险人姓名:翟卿', 480, 350, 650, 375),
  ]);

  assert.equal(result.fields.applicant, '翟卿');
  assert.equal(result.fields.insured, '翟卿');
  assert.equal(result.fields.date, '2024-12-05');
  assert.equal(result.fields.policyNumber, '2024330133SCW500032558');
  assert.notEqual(result.fields.applicant, '合同成立日期');
  assert.notEqual(result.fields.insured, '姓名');
  assert.equal(result.evidence.applicant.relation, 'inline');
  assert.equal(result.evidence.applicant.labelText, '投保人姓名:翟卿');
  assert.match(result.evidence.applicant.rowText, /合同成立日期/u);
  assert.equal(result.evidence.policyNumber.relation, 'inline');
  assert.equal(result.evidence.insured.rawValue, '翟卿');
});

test('parsePolicyBasicInfoFromLayoutBoxes reads Xinhua student policy by visual table structure', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('NCI新华保险', 705, 35, 1192, 134),
    box('保险合同号：66240173400401', 760, 247, 1036, 279),
    box('合同成立日期：2024年08月09日', 155, 316, 485, 347),
    box('合同生效日期：2024年08月16日', 801, 315, 1133, 344),
    box('投保人姓名：楼媛媛', 152, 347, 356, 376),
    box('证件号码：330725198207272328', 801, 346, 1116, 373),
    box('被保险人姓名：王後曦', 153, 377, 377, 404),
    box('证件号码：330104200906083556', 802, 378, 1117, 401),
    box('残疾保险金、意外医疗保险金受益人', 150, 433, 507, 467),
    box('证件号码', 591, 435, 683, 463),
    box('受益顺序', 796, 437, 889, 462),
    box('受益份额', 943, 433, 1036, 464),
    box('被保险人本人', 151, 467, 284, 495),
    box('身故保险金受益人', 152, 498, 329, 522),
    box('证件号码', 592, 495, 683, 523),
    box('受益顺序', 797, 497, 890, 522),
    box('受益份额', 945, 497, 1039, 522),
    box('被保险人的法定继承人', 149, 525, 374, 555),
    box('保险利益表', 582, 572, 749, 602),
    box('险种名称', 149, 600, 242, 628),
    box('保险责任名称', 474, 603, 609, 627),
    box('金额/份数', 750, 604, 853, 629),
    box('给付标准', 889, 603, 982, 628),
    box('免赔额', 1025, 602, 1097, 627),
    box('赔付比例', 1111, 600, 1205, 631),
    box('学生平安意外伤害保险', 148, 633, 354, 660),
    box('意外伤害身故和残疾保险金', 473, 634, 718, 661),
    box('80000.00元', 740, 636, 860, 661),
    box('附加学生平安A款定期寿险', 147, 663, 382, 689),
    box('疾病身故或全残保险金', 471, 665, 678, 693),
    box('80000.00元', 741, 669, 861, 693),
    box('附加学生平安A款疾病住院医疗保险疾病住院医疗保险金', 142, 735, 657, 769),
    box('800000.00元', 735, 739, 867, 768),
    box('附加学生平安A1款意外伤害医疗保意外伤害医疗费用保险金', 142, 861, 697, 893),
    box('20000.00元', 741, 866, 861, 891),
    box('险', 142, 891, 166, 916),
    box('附加学生平安A款住院津贴医疗保险住院津贴保险金', 126, 1163, 616, 1193),
    box('6份', 783, 1166, 828, 1194),
    box('保险期间：2024年08月16日零时起至2025年08月15日二十四时止，一年交费方式：一次交清', 122, 1194, 1105, 1228),
    box('保险费合计：（大写）贰佰玖拾捌元整', 121, 1228, 522, 1256),
    box('￥298.00', 890, 1232, 987, 1257),
  ]);

  assert.equal(result.fields.date, '2024-08-16');
  assert.equal(result.fields.insuredIdNumber, '330104200906083556');
  assert.equal(result.fields.insuredBirthday, '2009-06-08');
  assert.equal(result.fields.beneficiary, '法定');
  assert.equal(result.fields.name, '学生平安意外伤害保险');
  assert.equal(result.fields.amount, '80000');
  assert.equal(result.fields.coveragePeriod, '至2025年08月15日');
  assert.equal(result.fields.paymentPeriod, '趸交');
  assert.equal(result.fields.firstPremium, '298');
  assert.deepEqual(
    result.fields.plans.map((plan) => ({
      role: plan.role,
      name: plan.name,
      amount: plan.amount,
      premium: plan.premium,
      premiumText: plan.premiumText,
    })),
    [
      { role: 'main', name: '学生平安意外伤害保险', amount: '80000', premium: '', premiumText: '整单合计保费：298；保单未列逐险种保费' },
      { role: 'rider', name: '附加学生平安A款定期寿险', amount: '80000', premium: '', premiumText: '整单合计保费：298；保单未列逐险种保费' },
      { role: 'rider', name: '附加学生平安A款疾病住院医疗保险', amount: '800000', premium: '', premiumText: '整单合计保费：298；保单未列逐险种保费' },
      { role: 'rider', name: '附加学生平安A1款意外伤害医疗保险', amount: '20000', premium: '', premiumText: '整单合计保费：298；保单未列逐险种保费' },
      { role: 'rider', name: '附加学生平安A款住院津贴医疗保险', amount: '6', premium: '', premiumText: '整单合计保费：298；保单未列逐险种保费' },
    ],
  );
  assert.equal(result.fieldConfidence.name, 'visual-table');
  assert.equal(result.evidence.name.source, 'benefit-table-layout');
});

test('parsePolicyBasicInfoFromLayoutBoxes reads legacy China Life table with vertical labels', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('本公司根据投保人申请，同意按下列条件承保。', 359, 322, 1826, 429),
    box('保险单号码', 361, 469, 849, 575),
    box('投保日期', 1918, 463, 2289, 562),
    box('1999年03月12日', 2546, 475, 3029, 567),
    box('3301001000000899', 1027, 496, 1603, 580),
    box('投保人姓名', 360, 607, 847, 701),
    box('性别', 1309, 600, 1553, 693),
    box('出生日期', 1925, 594, 2297, 687),
    box('1970年01月06日', 2552, 596, 3035, 693),
    box('秦国英', 963, 619, 1170, 718),
    box('被保险人', 352, 724, 449, 1051),
    box('姓名', 580, 733, 890, 839),
    box('性别', 1304, 721, 1703, 827),
    box('出生日期', 1929, 720, 2304, 816),
    box('1970年01月06日', 2561, 731, 3037, 823),
    box('秦国英', 963, 752, 1169, 847),
    box('与投保人关系', 1369, 884, 1977, 981),
    box('本人', 2243, 868, 2389, 951),
    box('投保时年龄', 580, 898, 1080, 997),
    box('与被保险人关系', 1311, 1045, 2030, 1142),
    box('受益顺序', 2129, 1035, 2438, 1133),
    box('受益份额', 2657, 1026, 3053, 1125),
    box('受益人姓名', 345, 1064, 858, 1161),
    box('性别', 977, 1055, 1254, 1151),
    box('本人', 1592, 1198, 1751, 1284),
    box('1', 2243, 1194, 2295, 1263),
    box('1/1', 2736, 1182, 2884, 1258),
    box('秦国英', 455, 1215, 671, 1310),
    box('1999年03月13日零时起', 1984, 1554, 2671, 1678),
    box('保险责任开始时间', 354, 1585, 1143, 1691),
    box('利差领取方式', 2141, 1671, 2597, 1784),
    box('储存生息', 2790, 1679, 3066, 1768),
    box('保险金额伍万元整', 350, 1718, 1151, 1834),
    box('（? 50000.00', 1429, 1731, 1833, 1816),
    box('缴费日期', 2304, 1799, 2693, 1908),
    box('1999,03.', 2794, 1803, 3056, 1895),
    box('缴费方式', 352, 1853, 747, 1953),
    box('缴费标准', 1346, 1842, 1744, 1938),
    box('1785.00元', 1823, 1849, 2145, 1938),
  ]);

  assert.equal(result.fields.policyNumber, '3301001000000899');
  assert.equal(result.fields.applicant, '秦国英');
  assert.equal(result.fields.insured, '秦国英');
  assert.equal(result.fields.beneficiary, '秦国英');
  assert.equal(result.fields.insuredBirthday, '1970-01-06');
  assert.equal(result.fields.date, '1999-03-13');
  assert.equal(result.fields.amount, '50000');
  assert.equal(result.fields.firstPremium, '1785');
  assert.equal(result.fieldConfidence.amount, 'visual-table');
  assert.equal(result.fieldConfidence.firstPremium, 'visual-table');
});

test('parsePolicyBasicInfoFromLayoutBoxes classifies universal account table rows as linked accounts', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('NCI 新华保险', 1500, 80, 2100, 190),
    box('保险合同号:990163781859', 1600, 430, 2050, 470),
    box('合同成立日期：2024年06月06日', 180, 560, 610, 610),
    box('合同生效日期：2024年06月07日', 1620, 650, 2050, 700),
    box('投保人：冯力', 180, 650, 390, 700),
    box('被保险人：冯力', 180, 720, 430, 770),
    box('保险利益表', 1180, 980, 1400, 1030),
    box('险种名称', 350, 1080, 520, 1130),
    box('基本保险金额/保险金额/保障计划/份数', 780, 1080, 1160, 1160),
    box('保险期间', 1350, 1080, 1520, 1130),
    box('交费方式/交费期间', 1710, 1080, 1960, 1160),
    box('保险费', 2380, 1080, 2520, 1130),
    box('荣耀鑫享赢家版终身寿险', 330, 1260, 680, 1360),
    box('165020.00元', 820, 1260, 1100, 1320),
    box('终身', 1390, 1260, 1490, 1320),
    box('年交/10年', 1740, 1260, 1880, 1360),
    box('每年20000.00元', 2300, 1260, 2580, 1320),
    box('金利瑞享终身寿险（万能型）', 330, 1440, 780, 1540),
    box('--', 900, 1440, 960, 1490),
    box('终身', 1390, 1440, 1490, 1490),
    box('一次交清', 1700, 1440, 1880, 1490),
    box('10.00元', 2370, 1440, 2520, 1490),
    box('首期保险费合计：￥20010.00', 1200, 1840, 2050, 1900),
  ]);

  assert.equal(result.fields.plans.length, 2);
  assert.equal(result.fields.plans[0].role, 'main');
  assert.equal(result.fields.plans[0].name, '荣耀鑫享赢家版终身寿险');
  assert.equal(result.fields.plans[1].role, 'linked_account');
  assert.equal(result.fields.plans[1].name, '金利瑞享终身寿险（万能型）');
  assert.equal(result.fields.plans[1].productType, '万能账户');
});
