import AppKit
import Foundation
import PDFKit
import Vision

func fail(_ message: String) -> Never {
  fputs("\(message)\n", stderr)
  exit(1)
}

func jsonString(_ value: Any) -> String {
  guard
    let data = try? JSONSerialization.data(withJSONObject: value, options: []),
    let text = String(data: data, encoding: .utf8)
  else {
    fail("PDF_VISION_JSON_FAILED")
  }
  return text
}

func ocrLines(from image: NSImage) -> [String] {
  guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    return []
  }
  var recognizedLines: [String] = []
  let request = VNRecognizeTextRequest { request, _ in
    let observations = request.results as? [VNRecognizedTextObservation] ?? []
    recognizedLines = observations.compactMap { observation in
      observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
    }.filter { !$0.isEmpty }
  }
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  do {
    try handler.perform([request])
  } catch {
    return []
  }
  return recognizedLines
}

let args = Array(CommandLine.arguments.dropFirst())
guard let pdfPath = args.first, !pdfPath.isEmpty else {
  fail("PDF_PATH_REQUIRED")
}

let maxPages = args.dropFirst().compactMap { Int($0) }.first ?? 0
let pdfUrl = URL(fileURLWithPath: pdfPath)
guard let document = PDFDocument(url: pdfUrl) else {
  fail("PDF_OPEN_FAILED")
}

let pageCount = document.pageCount
let limit = maxPages > 0 ? min(maxPages, pageCount) : pageCount
var pageResults: [[String: Any]] = []

for index in 0..<limit {
  guard let page = document.page(at: index) else {
    continue
  }
  let bounds = page.bounds(for: .mediaBox)
  let maxDimension: CGFloat = 2400
  let scale = maxDimension / max(bounds.width, bounds.height)
  let targetSize = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
  let image = page.thumbnail(of: targetSize, for: .mediaBox)
  let lines = ocrLines(from: image)
  pageResults.append([
    "page": index + 1,
    "text": lines.joined(separator: "\n"),
    "lineCount": lines.count,
  ])
}

let fullText = pageResults.compactMap { $0["text"] as? String }.joined(separator: "\n")
print(jsonString([
  "ok": !fullText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
  "pages": pageCount,
  "processedPages": limit,
  "text": fullText,
  "pageTexts": pageResults,
]))
