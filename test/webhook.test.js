import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../src/mp.js", () => ({
  criaPagamento: vi.fn(),
  consultaPagamento: vi.fn(async () => ({ id: 999, status: "approved" })),
}));

import worker from "../src/index.js";
import { consultaPagamento } from "../src/mp.js";
import schemaSql from "../schema.sql?raw";

// O D1 de teste começa vazio (sem tabelas) — cria o schema (mesmo schema.sql
// de produção) antes de cada teste. Feito aqui, e não num setupFile de
// vitest.config.mjs, porque um setupFile que importa de "cloudflare:test"
// quebra o vi.mock() acima (ver issue 10201 do cloudflare/workers-sdk).
beforeEach(async () => {
  vi.clearAllMocks();
  const statements = schemaSql.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
});

const hook = (body) =>
  new Request("https://x/api/mp-webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("webhook atualiza status e é idempotente", async () => {
  await env.DB.prepare(
    "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, contato_email, status, mp_payment_id, consentiu) VALUES ('u1','SUZU-W1','2026-07-24T00:00:00Z','[]',12000,0,0,12000,'pix','a@b.com','pendente','999',1)"
  ).run();

  for (let i = 0; i < 2; i++) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(hook({ type: "payment", data: { id: "999" } }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  }

  const row = await env.DB.prepare("SELECT status FROM compras WHERE mp_payment_id='999'").first();
  expect(row.status).toBe("aprovado");
});

test("evento sem mp_payment_id correspondente não erra e responde 200", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(hook({ type: "payment", data: { id: "sem-match-000" } }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
});

test("tipo de evento desconhecido é ignorado e responde 200", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(hook({ type: "merchant_order", data: { id: "999" } }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  expect(consultaPagamento).not.toHaveBeenCalled();
});

test("status MP desconhecido não sobrescreve o status atual da compra", async () => {
  consultaPagamento.mockResolvedValueOnce({ id: 999, status: "authorized" }); // não mapeado
  await env.DB.prepare(
    "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, contato_email, status, mp_payment_id, consentiu) VALUES ('u2','SUZU-W2','2026-07-24T00:00:00Z','[]',12000,0,0,12000,'pix','a@b.com','pendente','888',1)"
  ).run();
  const ctx = createExecutionContext();
  const res = await worker.fetch(hook({ type: "payment", data: { id: "888" } }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT status FROM compras WHERE mp_payment_id='888'").first();
  expect(row.status).toBe("pendente");
});

test("corpo inválido não derruba a rota — responde 200", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://x/api/mp-webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
});
