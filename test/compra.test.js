import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, beforeEach } from "vitest";

import worker from "../src/index.js";
import schemaSql from "../schema.sql?raw";

// mesmo padrão de test/pagar.test.js: cria o schema de produção num D1 de teste vazio.
beforeEach(async () => {
  const statements = schemaSql.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
});

async function seedCompra(ref, status) {
  await env.DB.prepare(
    "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, parcelas, contato_email, cpf, status, consentiu) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), ref, new Date().toISOString(), "[]", 12300, 0, 615, 11685, "pix", 1, "a@b.com", "12345678909", status, 1)
    .run();
}

const get = (qs) => new Request("https://x/api/compra" + qs);

test("retorna o status da compra pelo ref", async () => {
  await seedCompra("SUZU-ABC123", "pendente");
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-ABC123"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.status).toBe("pendente");
});

test("reflete o status atualizado (ex.: aprovado depois do webhook)", async () => {
  await seedCompra("SUZU-XYZ789", "aprovado");
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-XYZ789"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("aprovado");
});

test("ref inexistente => nao_encontrado", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-NADA00"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.status).toBe("nao_encontrado");
});

test("sem ref => nao_encontrado", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(get(""), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("nao_encontrado");
});

test("método diferente de GET => 405", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://x/api/compra?ref=SUZU-ABC123", { method: "POST" }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(405);
});
