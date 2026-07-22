import "@typespec/http";
using Http;

@service(#{ title: "ShopService" })
@route("/")
namespace ShopService;

model Item {
  id: string;
}

// Same operation name ("list") in two different interfaces — the exact
// collision that's currently broken (duplicate `func list()` declarations).
@route("/users")
interface Users {
  @get list(): Item[];
}

@route("/orders")
interface Orders {
  @get list(): Item[];
}

// A bare, non-interface operation — must stay flat on the top-level client.
@route("/health")
@get
op health(): void;

// Two same-named interfaces in different nested namespaces — exercises the
// collision-safe qualified naming fallback (both would default to "Items").
namespace A {
  @route("/a/items")
  interface Items {
    @get list(): Item[];
  }
}

namespace B {
  @route("/b/items")
  interface Items {
    @get list(): Item[];
  }
}
