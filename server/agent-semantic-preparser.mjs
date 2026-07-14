export function preparseAgentMessage(value) {
  const question = String(value || '').trim().slice(0, 1_000);
  const numericSelection = question.match(/^(?:(?:选择|选)\s*)?(?:第\s*)?(20|1\d|[1-9])(?:\s*(?:个|项|款|号))?$/u);
  const chineseSelection = question.match(/^(?:(?:选择|选)\s*)?第\s*(一|二|三|四|五|六|七|八|九|十)\s*款$/u);
  const chineseIndexes = new Map([
    ['一', 0], ['二', 1], ['三', 2], ['四', 3], ['五', 4],
    ['六', 5], ['七', 6], ['八', 7], ['九', 8], ['十', 9],
  ]);
  const index = numericSelection
    ? Number(numericSelection[1]) - 1
    : chineseIndexes.get(chineseSelection?.[1]) ?? -1;
  const hasUploadSignal = /上传|录入/u.test(question) && /保单|资料/u.test(question);
  const questionWithoutPositiveUpload = question.replace(
    /(?:不得不|不但(?:还)?(?:要|需))\s*(?:上传|录入)/gu,
    '',
  );
  const hasNegatedUploadAction = /(?:暂时别|不需要|不要|请勿|禁止|拒绝|取消|停止|无法|无需|不用|暂不|别|不)[^，。！？\n]{0,8}(?:上传|录入)/u
    .test(questionWithoutPositiveUpload);

  return {
    candidateSelection: index >= 0 && index < 20
      ? { index, rawText: question }
      : null,
    operationHint: hasUploadSignal && !hasNegatedUploadAction
      ? 'upload_link'
      : null,
  };
}
