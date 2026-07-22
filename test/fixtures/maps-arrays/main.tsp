import "@typespec/http";
using Http;

@service(#{ title: "MapsArraysService" })
@route("/")
namespace MapsArraysService;

enum ItemStatus {
  active: "active",
  archived: "archived",
}

model Item {
  id: string;
  tags?: string[];
  metadata?: Record<string>;
  children?: Item[];
}

@route("/items")
@get
op listItems(@query status?: ItemStatus, @header xStatus?: ItemStatus): { @body items: Item[] };
