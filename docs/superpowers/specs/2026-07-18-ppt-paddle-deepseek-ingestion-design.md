# PPT 上传后 PaddleOCR-VL 1.6 + DeepSeek 自动处理设计

主规则：PPTX 原生解析 → 逐页渲染 → PaddleOCR-VL 1.6 视觉识别 → DeepSeek V4 读取原生与 OCR 结构做语义重建 → 服务端事实与完整度校验 → 语义切片 → 人工审核 → 新候选发布。

DeepSeek 不直接识别图片，也不使用 DeepSeek-OCR；它只整理 PPTX 原生证据和 PaddleOCR-VL 1.6 结果。任一页面缺少 Paddle 或 DeepSeek 结果时，整份 PPT 不生成可发布候选切片。完整设计见主工作区同名文件。
