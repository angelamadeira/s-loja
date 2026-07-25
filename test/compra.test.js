import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../src/mp.js", () => ({
  criaPagamento: vi.fn(),
  consultaPagamento: vi.fn(),
  consultaPagamentoFull: vi.fn(async () => ({ id: 999, status: "in_process", pix: { qrBase64: "BASE64IMG", copiaECola: "COPIA-COLA" } })),
}));

import worker from "../src/index.js";
import { consultaPagamentoFull } from "../src/mp.js";
import schemaSql from "../schema.sql?raw";

// mesmo padrão de test/pagar.test.js: cria o schema de produção num D1 de teste vazio.
beforeEach(async () => {
  vi.clearAllMocks();
  const statements = schemaSql.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
});

async function seedCompra(ref, status, opts) {
  opts = opts || {};
  await env.DB.prepare(
    "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, parcelas, contato_email, cpf, status, mp_payment_id, consentiu) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), ref, new Date().toISOString(), "[]", 12300, 0, 615, 11685, opts.metodo || "pix", 1, "a@b.com", "12345678909", status, opts.mpId || null, 1)
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

// Tela /pix/<ref> (retornável): compra pendente em Pix reconsulta o MP pra devolver
// o QR/copia-e-cola atuais, em vez de depender do que /api/pagar devolveu na hora.
test("compra pendente em pix inclui QR/copia-e-cola consultado no MP", async () => {
  await seedCompra("SUZU-PIX001", "pendente", { metodo: "pix", mpId: "12345" });
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-PIX001"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.status).toBe("pendente");
  expect(j.pix).toEqual({ qrBase64: "BASE64IMG", copiaECola: "COPIA-COLA" });
  expect(consultaPagamentoFull).toHaveBeenCalledWith(expect.anything(), "12345");
});

test("compra pendente sem mp_payment_id não consulta o MP nem inclui pix", async () => {
  await seedCompra("SUZU-PIX002", "pendente", { metodo: "pix" });
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-PIX002"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("pendente");
  expect(j.pix).toBeUndefined();
  expect(consultaPagamentoFull).not.toHaveBeenCalled();
});

test("compra pendente em cartão não consulta o MP nem inclui pix", async () => {
  await seedCompra("SUZU-CARD01", "pendente", { metodo: "cartao", mpId: "777" });
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-CARD01"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("pendente");
  expect(j.pix).toBeUndefined();
  expect(consultaPagamentoFull).not.toHaveBeenCalled();
});

test("compra aprovada em pix não consulta o MP (não precisa mais de QR)", async () => {
  await seedCompra("SUZU-PIX003", "aprovado", { metodo: "pix", mpId: "888" });
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-PIX003"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("aprovado");
  expect(j.pix).toBeUndefined();
  expect(consultaPagamentoFull).not.toHaveBeenCalled();
});

test("falha do MP ao reconsultar não derruba o endpoint — devolve só o status", async () => {
  consultaPagamentoFull.mockRejectedValueOnce(new Error("MP indisponível"));
  await seedCompra("SUZU-PIX004", "pendente", { metodo: "pix", mpId: "999" });
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-PIX004"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.status).toBe("pendente");
  expect(j.pix).toBeUndefined();
});
