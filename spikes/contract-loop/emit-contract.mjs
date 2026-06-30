// Spike A: the Nizhal server's `GET /nizhal/contract` would derive this from the
// schema (row shapes) + Zod mutator inputs. Here we do it by hand to prove the loop.
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { writeFileSync } from "node:fs";

// row shape (would come from the Drizzle/whatever schema, server-side)
const Customer = z.object({
  id: z.string(),
  shopId: z.string(),
  name: z.string(),
  phone: z.string(),
});

// mutator input (the real Zod validator on the server mutator)
const RecordCreditInput = z.object({
  customerId: z.string(),
  amount: z.number(),
  dueDate: z.number().optional(),
});

const toSchema = (s) => zodToJsonSchema(s, { target: "openApi3" });

const contract = {
  openapi: "3.1.0",
  info: { title: "echo-contract", version: "0" },
  paths: {
    "/sync/push": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RecordCreditInput" },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    schemas: {
      Customer: toSchema(Customer),
      RecordCreditInput: toSchema(RecordCreditInput),
    },
  },
};

writeFileSync("contract.json", JSON.stringify(contract, null, 2));
console.log("OK: emitted contract.json (Zod -> OpenAPI/JSON-Schema)");
