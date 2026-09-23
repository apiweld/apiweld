import { defineConfig } from "apiweld";

export default defineConfig({
  output: "examples/src/api",
  generator: {
    name: "hey-api",
    client: "fetch",
    validators: "zod",
  },
  verify: {
    typecheck: true,
  },
  apis: {
    stripe: {
      source: "https://raw.githubusercontent.com/stripe/openapi/master/latest/openapi.spec3.json",

      operations: [
        "GET /v1/refunds",
        "GET /v1/refunds/{refund}",
        "POST /v1/refunds",
        "POST /v1/refunds/{refund}",
        "POST /v1/refunds/{refund}/cancel"
      ],

      policy: {
        autoRegenerate: "safe"
      }
    }
  },
});