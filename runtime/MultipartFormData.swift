import Foundation

/// Builds a `multipart/form-data` body. Two encoding strategies are
/// available: `encode()` builds the whole body in memory (for bodies with no
/// large file-sourced parts), and `writeToTemporaryFile()` streams parts onto
/// a temporary file so large file parts never load fully into memory (the
/// resulting file is then uploaded with `URLSession.upload(for:fromFile:)`).
/// Generated client code picks between the two based on whether any part of
/// a given operation is binary (see the emitter's `multipartHasFilePart`
/// check) and is responsible for deleting any temporary file it creates.
public struct MultipartFormData: Sendable {
    public struct Part: Sendable {
        public var name: String
        public var filename: String?
        public var contentType: String?
        public var source: HTTPBody

        public init(name: String, filename: String? = nil, contentType: String? = nil, source: HTTPBody) {
            self.name = name
            self.filename = filename
            self.contentType = contentType
            self.source = source
        }
    }

    public let boundary: String
    public private(set) var parts: [Part]

    public init(boundary: String = "Boundary-\(UUID().uuidString)", parts: [Part] = []) {
        self.boundary = boundary
        self.parts = parts
    }

    public mutating func append(_ part: Part) {
        parts.append(part)
    }

    public var contentType: String {
        "multipart/form-data; boundary=\(boundary)"
    }

    /// Builds the `Content-Disposition`/`Content-Type` header block (plus the
    /// blank line separating headers from the part body) for a single part.
    private func partHeader(for part: Part) -> Data {
        var disposition = "Content-Disposition: form-data; name=\"\(part.name)\""
        if let filename = part.filename {
            disposition += "; filename=\"\(filename)\""
        }
        var header = "--\(boundary)\r\n" + disposition + "\r\n"
        if let contentType = part.contentType {
            header += "Content-Type: \(contentType)\r\n"
        }
        header += "\r\n"
        return Data(header.utf8)
    }

    /// Encodes the entire body in memory. Suitable when no part sources a
    /// large file.
    public func encode() throws -> Data {
        var data = Data()
        for part in parts {
            data.append(partHeader(for: part))
            switch part.source {
            case .data(let payload):
                data.append(payload)
            case .file(let fileURL):
                data.append(try Data(contentsOf: fileURL))
            }
            data.append(Data("\r\n".utf8))
        }
        data.append(Data("--\(boundary)--\r\n".utf8))
        return data
    }

    /// Streams all parts to a temporary file and returns its URL. The caller is
    /// responsible for deleting the file after the upload completes.
    public func writeToTemporaryFile() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("multipart-\(UUID().uuidString).tmp")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }

        for part in parts {
            try handle.write(contentsOf: partHeader(for: part))
            switch part.source {
            case .data(let payload):
                try handle.write(contentsOf: payload)
            case .file(let fileURL):
                let reader = try FileHandle(forReadingFrom: fileURL)
                defer { try? reader.close() }
                // Copy in bounded chunks so a large file never fully buffers.
                while case let chunk = reader.readData(ofLength: 64 * 1024), !chunk.isEmpty {
                    try handle.write(contentsOf: chunk)
                }
            }
            try handle.write(contentsOf: Data("\r\n".utf8))
        }
        try handle.write(contentsOf: Data("--\(boundary)--\r\n".utf8))
        return url
    }
}
