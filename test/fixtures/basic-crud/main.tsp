import "@typespec/http";
using Http;

@service(#{ title: "BasicCrudService" })
@route("/")
namespace BasicCrudService;

model Item {
  id: string;
  name: string;
}

model ItemInput {
  name: string;
}

@error
model NotFoundError {
  @statusCode statusCode: 404;
  message: string;
}

@error
model ValidationError {
  @statusCode statusCode: 422;
  message: string;
}

@route("/items/{itemId}")
@get
op getItem(@path itemId: string, @query include?: string, @header ifNoneMatch?: string): { @body item: Item } | NotFoundError;

@route("/items")
@post
op createItem(@body payload: ItemInput): { @statusCode statusCode: 201; @body item: Item } | ValidationError;

@route("/items/{itemId}")
@put
op updateItem(@path itemId: string, @body payload: ItemInput): { @body item: Item } | NotFoundError | ValidationError;

@route("/items/{itemId}")
@delete
op deleteItem(@path itemId: string): { @statusCode statusCode: 204 } | NotFoundError;
