import "@typespec/http";
using Http;

@service(#{ title: "GreedyPathService" })
@route("/")
namespace GreedyPathService;

model UploadResult {
  key: string;
}

@error
model NotFoundError {
  @statusCode statusCode: 404;
  message: string;
}

@route("/storage/{bucket}/{+path}")
@post
op uploadFile(@path bucket: string, @path path: string, @bodyRoot body: bytes): {
  @body result: UploadResult;
} | NotFoundError;

@route("/storage/{bucket}/{+path}")
@get
op downloadFile(@path bucket: string, @path path: string): {
  @bodyRoot body: bytes;
} | NotFoundError;
