import AppKit
import Foundation
import Vision

guard CommandLine.arguments.count >= 2 else {
  fputs("POLICY_OCR_EMPTY\n", stderr)
  exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageUrl = URL(fileURLWithPath: imagePath)

guard
  let image = NSImage(contentsOf: imageUrl),
  let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
  fputs("POLICY_OCR_EMPTY\n", stderr)
  exit(1)
}

var recognizedLines: [String] = []
let request = VNRecognizeTextRequest { request, error in
  if error != nil {
    return
  }
  let observations = request.results as? [VNRecognizedTextObservation] ?? []
  recognizedLines = observations.compactMap { observation in
    observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines)
  }.filter { !$0.isEmpty }
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

do {
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  try handler.perform([request])
  let output = recognizedLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  if output.isEmpty {
    fputs("POLICY_OCR_EMPTY\n", stderr)
    exit(1)
  }
  print(output)
} catch {
  fputs("POLICY_OCR_FAILED\n", stderr)
  exit(1)
}
