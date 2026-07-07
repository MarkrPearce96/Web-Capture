#!/usr/bin/swift
import AppKit

let outDir = "extension/images"
try FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func cameraPath(in rect: NSRect) -> NSBezierPath {
    let path = NSBezierPath()
    let body = NSRect(
        x: rect.minX + rect.width * 0.08,
        y: rect.minY + rect.height * 0.16,
        width: rect.width * 0.84,
        height: rect.height * 0.56
    )
    path.append(NSBezierPath(roundedRect: body, xRadius: rect.width * 0.08, yRadius: rect.width * 0.08))
    let bump = NSRect(
        x: rect.minX + rect.width * 0.34,
        y: body.maxY - rect.height * 0.02,
        width: rect.width * 0.32,
        height: rect.height * 0.14
    )
    path.append(NSBezierPath(roundedRect: bump, xRadius: rect.width * 0.04, yRadius: rect.width * 0.04))
    return path
}

func lensRect(in rect: NSRect) -> NSRect {
    let d = rect.width * 0.30
    return NSRect(x: rect.midX - d / 2, y: rect.minY + rect.height * 0.29, width: d, height: d)
}

func renderIcon(pixels: Int, toolbar: Bool, to path: String) {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let full = NSRect(x: 0, y: 0, width: CGFloat(pixels), height: CGFloat(pixels))
    if toolbar {
        NSColor.black.setFill()
        cameraPath(in: full).fill()
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        NSBezierPath(ovalIn: lensRect(in: full)).fill()
    } else {
        let bg = NSColor(calibratedRed: 0.13, green: 0.45, blue: 0.95, alpha: 1)
        let inner = full.insetBy(dx: full.width * 0.12, dy: full.height * 0.12)
        bg.setFill()
        NSBezierPath(
            roundedRect: full.insetBy(dx: full.width * 0.04, dy: full.height * 0.04),
            xRadius: full.width * 0.18, yRadius: full.width * 0.18
        ).fill()
        NSColor.white.setFill()
        cameraPath(in: inner).fill()
        bg.setFill()
        NSBezierPath(ovalIn: lensRect(in: inner)).fill()
    }
    NSGraphicsContext.current?.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

for size in [48, 96, 128, 256, 512] {
    renderIcon(pixels: size, toolbar: false, to: "\(outDir)/icon-\(size).png")
}
for size in [16, 32] {
    renderIcon(pixels: size, toolbar: true, to: "\(outDir)/toolbar-\(size).png")
}
