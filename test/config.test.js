import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test } from "vitest";

import worker from "../src/index.js";

const get = () => new Request("https://x/api/config", { method: "GET" });

test("GET /api/config retorna a chave pública do Mercado Pago", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(get(), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.mpKey).toBe("TEST-07522a08-a791-40ff-8069-6c187bc12bac");
});

test("POST /api/config => 405", async () => {
  const ctx = createExecutionContext();
  const req = new Request("https://x/api/config", { method: "POST" });
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(405);
});
