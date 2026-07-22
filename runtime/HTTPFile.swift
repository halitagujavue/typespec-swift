import Foundation
#if canImport(UniformTypeIdentifiers)
    import UniformTypeIdentifiers
#endif

/// A file to be sent as part of a multipart/form-data request. Distinct from
/// `HTTPBody`: while structurally similar (`.data`/`.file`), `Contents`
/// represents a file's payload specifically, together with its filename and
/// content type, whereas `HTTPBody` represents an entire request body.
public struct HTTPFile: Sendable {
    public enum Contents: Sendable {
        case data(Data)
        case file(URL)
    }

    public var contents: Contents
    public var filename: String?
    public var contentType: String?

    public init(contents: Contents, filename: String? = nil, contentType: String? = nil) {
        self.contents = contents
        self.filename = filename
        self.contentType = contentType
    }

    /// Converts `contents` to the `HTTPBody` that `MultipartFormData.Part`
    /// requires.
    public func asHTTPBody() -> HTTPBody {
        switch contents {
        case .data(let data):
            return .data(data)
        case .file(let url):
            return .file(url)
        }
    }

    /// Resolves the filename to use for this file in a multipart part's
    /// `Content-Disposition` header: the caller's explicit `filename` takes
    /// precedence; otherwise, a `.file`-backed value is derived from the
    /// file URL's last path component; a `.data`-backed value with no
    /// explicit filename has none.
    public func resolvedFilename() -> String? {
        if let filename { return filename }
        if case .file(let url) = contents { return url.lastPathComponent }
        return nil
    }

    /// Resolves the Content-Type to use for this file in a multipart part:
    /// the caller's explicit `contentType` takes precedence; otherwise, a
    /// `.file`-backed value is inferred from the file URL's path extension
    /// (falling back to `application/octet-stream` if unrecognized); a
    /// `.data`-backed value with no explicit content type uses `fallback`.
    public func resolvedContentType(fallback: String? = nil) -> String? {
        if let contentType { return contentType }
        switch contents {
        case .file(let url):
            return MimeType.forPathExtension(url.pathExtension)
        case .data:
            return fallback
        }
    }
}

/// Best-effort MIME type lookup from a file extension, used only by
/// `HTTPFile.resolvedContentType`.
enum MimeType {
    static func forPathExtension(_ pathExtension: String) -> String {
        #if canImport(UniformTypeIdentifiers)
            return UTType(filenameExtension: pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        #else
            return "application/octet-stream"
        #endif
    }
}
