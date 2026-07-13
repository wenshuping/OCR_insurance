export function preparseAgentMessage(value) {
  const question = String(value || '').trim().slice(0, 1_000);
  const selection = question.match(/^(?:选择|选|第)?\s*(\d{1,2})(?:\s*(?:个|项|款|号))?$/u);
  const index = selection ? Number(selection[1]) - 1 : -1;

  return {
    candidateSelection: index >= 0 && index < 20
      ? { index, rawText: question }
      : null,
    operationHint: /上传|录入/u.test(question) && /保单|资料/u.test(question)
      ? 'upload_link'
      : null,
  };
}
