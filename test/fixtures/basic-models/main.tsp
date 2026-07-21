@service(#{ title: "BasicModelsService" })
namespace BasicModelsService;

model Item {
  id: string;
  name: string;
  quantity: int32;
  price: float64;
  inStock: boolean;
  createdAt: utcDateTime;
}
