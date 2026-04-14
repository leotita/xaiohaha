import AppKit
import Foundation

struct Payload: Encodable {
  let ok: Bool
  let mimeType: String
  let pixelWidth: Int
  let pixelHeight: Int
  let byteLength: Int
  let base64: String
}

enum ClipboardImageError: Error {
  case noImage
  case pngEncodeFailed
}

func pngDataFromPasteboard() throws -> Data {
  let pasteboard = NSPasteboard.general

  if let pngData = pasteboard.data(forType: NSPasteboard.PasteboardType("public.png")) {
    return pngData
  }

  guard let image = NSImage(pasteboard: pasteboard) else {
    throw ClipboardImageError.noImage
  }

  let tiffData = image.tiffRepresentation ?? Data()
  guard
    let bitmap = NSBitmapImageRep(data: tiffData),
    let pngData = bitmap.representation(using: .png, properties: [:])
  else {
    throw ClipboardImageError.pngEncodeFailed
  }

  return pngData
}

do {
  let pngData = try pngDataFromPasteboard()
  guard let image = NSImage(data: pngData) else {
    throw ClipboardImageError.pngEncodeFailed
  }

  let rep = image.representations.first
  let payload = Payload(
    ok: true,
    mimeType: "image/png",
    pixelWidth: rep?.pixelsWide ?? Int(image.size.width),
    pixelHeight: rep?.pixelsHigh ?? Int(image.size.height),
    byteLength: pngData.count,
    base64: pngData.base64EncodedString()
  )

  let encoder = JSONEncoder()
  let data = try encoder.encode(payload)
  FileHandle.standardOutput.write(data)
} catch {
  let message = String(describing: error)
  FileHandle.standardError.write(Data(message.utf8))
  exit(1)
}
