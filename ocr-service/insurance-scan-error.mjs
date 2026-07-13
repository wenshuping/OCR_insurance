export function respondInsurancePolicyScanError(res, err) {
  const code = String(err?.code || err?.message || 'POLICY_SCAN_FAILED');
  if (code === 'POLICY_SCAN_INPUT_REQUIRED') {
    return res.status(400).json({ code, message: '请上传保单图片或提供 OCR 文本' });
  }
  if (code === 'INVALID_DATA_URL') {
    return res.status(400).json({ code, message: '上传文件格式错误' });
  }
  if (code === 'POLICY_SCAN_TYPE_UNSUPPORTED') {
    return res.status(400).json({ code, message: '当前支持图片和文本型 PDF 识别' });
  }
  if (code === 'FILE_TOO_LARGE') {
    return res.status(413).json({ code, message: '图片过大，单文件最大 12MB' });
  }
  if (code === 'POLICY_OCR_EMPTY') {
    return res.status(422).json({ code, message: '未识别到有效保单信息，请重新拍照' });
  }
  if (code === 'POLICY_OCR_TERMS_PAGE') {
    return res.status(422).json({ code, message: '这张图片是保险条款页，请将保单首页上传到“保单基本页”，条款页上传到“补充产品页”' });
  }
  if (code === 'POLICY_PDF_TEXT_EMPTY') {
    return res.status(422).json({ code, message: '这个 PDF 未提取到文字，请上传清晰图片或保单截图' });
  }
  if (code === 'POLICY_OCR_PROVIDER_NOT_READY') {
    return res.status(503).json({ code, message: 'OCR 服务未就绪，请先完成当前识别引擎安装或切换到可用方式' });
  }
  if (code === 'POLICY_OCR_PROVIDER_NOT_CONFIGURED') {
    return res.status(503).json({ code, message: 'OCR 服务未配置，请检查当前识别引擎的环境变量' });
  }
  if (code === 'POLICY_OCR_UPSTREAM_TIMEOUT') {
    return res.status(504).json({ code, message: 'OCR 服务响应超时，请稍后重试' });
  }
  if (code === 'POLICY_OCR_UPSTREAM_UNAVAILABLE') {
    return res.status(502).json({ code, message: 'OCR 服务暂不可用，请检查本地 OCR 服务是否已启动' });
  }
  if (code === 'OCR_SERVICE_UNAUTHORIZED') {
    return res.status(502).json({ code, message: 'OCR 服务鉴权失败，请检查 token 配置' });
  }
  if (code === 'POLICY_OCR_SERVICE_NOT_CONFIGURED') {
    return res.status(503).json({ code, message: 'OCR 服务未配置，请先设置 OCR 服务地址' });
  }
  return res.status(500).json({ code: 'POLICY_SCAN_FAILED', message: '保单识别失败，请稍后重试' });
}
