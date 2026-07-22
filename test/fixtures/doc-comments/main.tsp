import "@typespec/http";
using Http;

@service(#{ title: "DocCommentsService" })
@route("/")
namespace DocCommentsService;

/** An item in the catalog. */
model Item {
  /** The item's unique identifier. */
  id: string;
  name: string;
}

/** The lifecycle status of an item. */
enum ItemStatus {
  /** The item is active and visible. */
  Active,
  Archived,
}

/** A polymorphic content block. */
union Content {
  /** Plain text content. */
  text: string,
  nested: Item,
}

/** Fetches an item by its identifier. */
@route("/items/{itemId}")
@get
op getItem(
  /** The item's unique identifier. */
  @path itemId: string
): Item;
