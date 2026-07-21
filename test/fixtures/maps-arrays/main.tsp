@service(#{ title: "MapsArraysService" })
namespace MapsArraysService;

model Item {
  id: string;
  tags?: string[];
  metadata?: Record<string>;
  children?: Item[];
}
