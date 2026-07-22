import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// The default, zero-dependency `HTTPTransport` backed by `URLSession`.
///
/// Design notes (and a real URLSession constraint worth recording):
/// - Buffered and streaming requests use the modern async `URLSession` APIs
///   (`upload(for:fromFile:)`, `bytes(for:)`), which keep the code fully
///   async/await + `AsyncSequence` and Sendable-clean.
/// - Uploads stream from a file on disk (`.file`), so large bodies
///   never fully buffer in memory. Progress is reported via a per-task delegate.
/// - Background sessions are exposed via `init(configuration:)`, BUT the async
///   convenience APIs are not supported on a background `URLSessionConfiguration`
///   — background transfers must use delegate-based `downloadTask`/`uploadTask`
///   that complete out-of-process. That path is documented as a known limitation
///   rather than faked here.
public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(configuration: URLSessionConfiguration = .default) {
        self.session = URLSession(configuration: configuration)
    }

    public init(session: URLSession) {
        self.session = session
    }

    public func send(_ request: HTTPRequest, uploadProgress: ProgressHandler?) async throws
        -> HTTPResponse
    {
        let urlRequest = try Self.makeURLRequest(request)
        let delegate = uploadProgress.map { ProgressDelegate(onProgress: $0) }

        let data: Data
        let response: URLResponse
        do {
            switch request.body {
            case nil:
                (data, response) = try await session.data(for: urlRequest, delegate: delegate)
            case .data(let payload):
                (data, response) = try await session.upload(
                    for: urlRequest, from: payload, delegate: delegate)
            case .file(let fileURL):
                (data, response) = try await session.upload(
                    for: urlRequest, fromFile: fileURL, delegate: delegate)
            }
        } catch {
            throw HTTPError.transport(error)
        }
        return HTTPResponse(head: Self.makeHead(response), body: data)
    }

    public func stream(_ request: HTTPRequest) async throws -> HTTPResponseStream {
        let urlRequest = try Self.makeURLRequest(request)
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: urlRequest)
        } catch {
            throw HTTPError.transport(error)
        }

        let iterator = UncheckedBox(wrappedValue: bytes.makeAsyncIterator())
        let body = AsyncThrowingStream<UInt8, any Error> {
            try await iterator.wrappedValue.next()
        }
        return HTTPResponseStream(head: Self.makeHead(response), body: body)
    }

    // MARK: - Helpers

    private static func makeURLRequest(_ request: HTTPRequest) throws -> URLRequest {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method.rawValue
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        if case .data(let payload) = request.body {
            urlRequest.httpBody = payload
        }
        return urlRequest
    }

    private static func makeHead(_ response: URLResponse) -> HTTPResponseHead {
        guard let http = response as? HTTPURLResponse else {
            return HTTPResponseHead(status: 0, headers: [:])
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String {
                headers[key] = value
            }
        }
        return HTTPResponseHead(status: http.statusCode, headers: headers)
    }
}

/// Per-task delegate that forwards upload progress. Isolated state is guarded by
/// a lock so it is safe under Swift 6 strict concurrency.
private final class ProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let onProgress: ProgressHandler

    init(onProgress: @escaping ProgressHandler) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        let total = totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : nil
        onProgress(TransferProgress(completed: totalBytesSent, total: total))
    }
}

final class UncheckedBox<Value>: @unchecked Sendable {
    var wrappedValue: Value
    init(wrappedValue: Value) {
        self.wrappedValue = wrappedValue
    }
}
