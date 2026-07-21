@service(#{ title: "UnionsService" })
namespace UnionsService;

enum ItemStatus {
  active: "active",
  archived: "archived",
  pending: "pending",
}

union Content {
  text: string,
  number: float64,
  nested: Item,
}

model Item {
  id: string;
  status?: ItemStatus;
  content?: Content;
  /// Recursive: an item can reference child items (tree).
  children?: Item[];
}

@error
model NotFoundError {
  message: string;
}
