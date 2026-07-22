import "@typespec/http";
using Http;

@service(#{ title: "MultipartService" })
@route("/")
namespace MultipartService;

model UploadResult {
  id: string;
}

// Exercises: plain required part, plain required multi part, and a file
// part (Http.File) with dynamic filename + content type -> has a file part,
// so this op gets uploadProgress and writes to a temp file.
@route("/profile")
@post
op uploadProfile(
  @multipartBody body: {
    name: HttpPart<string>;
    tags: HttpPart<string>[];
    avatar: HttpPart<File>;
  }
): UploadResult;

// Exercises: a bare HttpPart<bytes> (not wrapped in File) -> still binary
// (isBinary via resolved Swift type "Data"), with no dynamic filename/content
// type property, but a single static contentType baked in as a literal.
@route("/raw")
@post
op uploadRaw(
  @multipartBody body: {
    raw: HttpPart<bytes>;
  }
): UploadResult;

// Exercises: only plain (non-binary) parts, one of them optional -> no file
// part at all, so this op uses the in-memory encode() path and has no
// uploadProgress parameter.
@route("/metadata")
@post
op uploadMetadata(
  @multipartBody body: {
    name: HttpPart<string>;
    description?: HttpPart<string>;
  }
): UploadResult;
