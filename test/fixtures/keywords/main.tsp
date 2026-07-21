@service(#{ title: "KeywordsService" })
namespace KeywordsService;

model Item {
  id: string;
  `protocol`?: string;
  `class`?: string;
  `self`?: string;
  `default`?: boolean;
}
