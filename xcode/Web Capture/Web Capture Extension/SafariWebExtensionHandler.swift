//
//  SafariWebExtensionHandler.swift
//  Web Capture Extension
//
//  Created by Mark Pearce on 2026/7/7.
//

import SafariServices
import Vision
import CoreGraphics
import ImageIO
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        // The one message type we handle specially: OCR. Everything else
        // falls through to the echo behaviour the template shipped with, so
        // existing round-trip checks keep working.
        if #available(macOS 10.15, *),
           let dict = message as? [String: Any],
           dict["type"] as? String == "ocr",
           let base64 = dict["image"] as? String {
            handleOcr(base64: base64, context: context)
            return
        }

        complete(context: context, payload: ["echo": message ?? NSNull()])
    }

    // Decodes the base64 image, runs Vision text recognition off the main
    // thread, and returns word-level bounding boxes in PIXEL coordinates of
    // the supplied image, top-left origin — the coordinate space the
    // extension's annotation layer already works in, so no flipping is
    // needed on the JavaScript side.
    @available(macOS 10.15, *)
    private func handleOcr(base64: String, context: NSExtensionContext) {
        guard let data = Data(base64Encoded: base64),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            complete(context: context, payload: ["ok": false, "error": "decode failed"])
            return
        }

        let width = CGFloat(cgImage.width)
        let height = CGFloat(cgImage.height)

        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true

            var words: [[String: Any]] = []
            do {
                let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
                try handler.perform([request])

                let observations = request.results ?? []
                for observation in observations {
                    guard let candidate = observation.topCandidates(1).first else { continue }
                    let string = candidate.string
                    // Split the recognised line into whitespace-delimited
                    // words and ask Vision for each word's own box, so a
                    // highlight can snap to individual words, not whole lines.
                    var searchStart = string.startIndex
                    while searchStart < string.endIndex {
                        // Skip leading whitespace.
                        while searchStart < string.endIndex,
                              string[searchStart].isWhitespace {
                            searchStart = string.index(after: searchStart)
                        }
                        if searchStart >= string.endIndex { break }
                        var wordEnd = searchStart
                        while wordEnd < string.endIndex,
                              !string[wordEnd].isWhitespace {
                            wordEnd = string.index(after: wordEnd)
                        }
                        let wordRange = searchStart..<wordEnd
                        if let box = try? candidate.boundingBox(for: wordRange),
                           let rect = self.pixelRect(box, width: width, height: height) {
                            words.append(rect)
                        }
                        searchStart = wordEnd
                    }
                }
            } catch {
                self.complete(context: context, payload: ["ok": false, "error": "\(error)"])
                return
            }

            self.complete(context: context, payload: [
                "ok": true,
                "words": words,
                "imageWidth": Int(width),
                "imageHeight": Int(height),
            ])
        }
    }

    // Converts a Vision rectangle observation (normalised, bottom-left
    // origin) to a pixel-space, top-left-origin {x,y,w,h} dictionary.
    @available(macOS 10.15, *)
    private func pixelRect(_ observation: VNRectangleObservation, width: CGFloat, height: CGFloat) -> [String: Any]? {
        let bb = observation.boundingBox
        guard bb.width > 0, bb.height > 0 else { return nil }
        return [
            "x": Double(bb.minX * width),
            "y": Double((1 - bb.maxY) * height),
            "w": Double(bb.width * width),
            "h": Double(bb.height * height),
        ]
    }

    private func complete(context: NSExtensionContext, payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
