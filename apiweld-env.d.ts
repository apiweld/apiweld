import "apiweld";

declare module "apiweld" {
  interface ApiOperationMap {
    "stripe": "GET /v1/refunds" | "GET /v1/refunds/{refund}" | "POST /v1/refunds" | "POST /v1/refunds/{refund}" | "POST /v1/refunds/{refund}/cancel";
  }
}
