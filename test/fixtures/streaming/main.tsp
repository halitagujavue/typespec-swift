import "@typespec/http";
import "@typespec/streams";
import "@typespec/sse";
import "@typespec/events";

using Http;
using TypeSpec.Streams;
using TypeSpec.Events;
using TypeSpec.SSE;

@service(#{ title: "StreamingService" })
@route("/")
namespace StreamingService;

model UploadResult {
  key: string;
  size: int64;
}

@error
model ValidationError {
  @statusCode statusCode: 422;
  message: string;
}

model MessageEvent {
  delta: string;
}

model DoneEvent {
  total: int32;
}

@events
union FunctionEvent {
  message: MessageEvent,
  done: DoneEvent,
}

@route("/storage/{bucket}")
@post
op uploadFile(@path bucket: string, @header contentType?: string, @bodyRoot body: bytes): {
  @body result: UploadResult;
} | ValidationError;

@route("/storage/{bucket}")
@get
op downloadFile(@path bucket: string): {
  @bodyRoot body: bytes;
};

@route("/functions/{name}")
@post
op invokeFunction(@path name: string): SSEStream<FunctionEvent> | ValidationError;
