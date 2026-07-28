import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../src/mp.js", () => ({
  criaPagamento: vi.fn(async () => ({ id: 999, status: "approved", statusDetail: "accredited" })),
  consultaPagamento: vi.fn(async () => ({ id: 999, status: "approved" })),
}));

import worker from "../src/index.js";
import { criaPagamento } from "../src/mp.js";
import schemaSql from "../schema.sql?raw";

// O D1 de teste começa vazio (sem tabelas) — cria o schema (mesmo schema.sql
// de produção) antes de cada teste. Feito aqui, e não num setupFile de
// vitest.config.mjs, porque um setupFile que importa de "cloudflare:test"
// quebra o vi.mock() acima (ver issue 10201 do cloudflare/workers-sdk).
beforeEach(async () => {
  const statements = schemaSql.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await env.DB.prepare(stmt).run();
  }
});

const post = (body) => new Request("https://x/api/pagar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("cobra o valor do servidor, não o do cliente", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true, precoFalso: 1 }), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.ok).toBe(true);
  expect(j.status).toBe("aprovado");
  const row = await env.DB.prepare("SELECT total, status FROM compras WHERE ref=?").bind(j.ref).first();
  // tablete/M = 12300; pix -5% = 615 desconto; frete econômico R$12,90 (região 0) => total 12975
  expect(row.total).toBe(12300 - 615 + 1290);
  expect(row.status).toBe("aprovado");
});

test("cliente não dita o frete — freteCents do payload é ignorado (recomputado do CEP)", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true, freteCents: -1000000 }), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT total FROM compras WHERE ref=?").bind(j.ref).first();
  // freteCents:-1000000 é ignorado; frete vem do CEP (econômico R$12,90) => total 12975
  expect(row.total).toBe(12300 - 615 + 1290);
});

test("grava itens com preco_unit efetivamente cobrado (registro financeiro)", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 2, preco: 1 }], metodo: "cartao", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true}), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT itens FROM compras WHERE ref=?").bind(j.ref).first();
  expect(JSON.parse(row.itens)).toEqual([{ id: "tablete", tam: "M", qtd: 2, preco_unit: 12300 }]);
});

test("parcelas do cliente são clampadas ao máximo permitido pro total", async () => {
  const ctx = createExecutionContext();
  // tablete/M cartão = 12300 => parcelasValidas(12300).maxParcelas = 2 (12300/5000 = 2.46 -> 2)
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "cartao", parcelas: 99, email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true}), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  const row = await env.DB.prepare("SELECT parcelas FROM compras WHERE ref=?").bind(j.ref).first();
  expect(row.parcelas).toBe(2);
});

test("carrinho vazio => 400", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [], metodo: "pix", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true}), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(400);
});

test("item inexistente => 400", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "hacker", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true}), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(400);
});

test("sem consentimento => 400", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", consentiu: false }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(400);
});

test("erro do MP (status='error', ex.: cartão recusado) => compra fica 'recusado', nunca 'pendente' com mp_payment_id nulo", async () => {
  criaPagamento.mockResolvedValueOnce({ status: "error", statusDetail: "invalid token" });
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "cartao", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true}), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.status).toBe("recusado");
  const row = await env.DB.prepare("SELECT status, mp_payment_id FROM compras WHERE ref=?").bind(j.ref).first();
  expect(row.status).toBe("recusado");
  expect(row.mp_payment_id).toBeNull();
});

test("Pix pendente: mapeia in_process => pendente e repassa o QR", async () => {
  criaPagamento.mockResolvedValueOnce({
    id: 1001,
    status: "in_process",
    statusDetail: "pending_waiting_transfer",
    pix: { qrBase64: "IMG", copiaECola: "COPIA" },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true}), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("pendente");
  expect(j.pix).toEqual({ qrBase64: "IMG", copiaECola: "COPIA" });
  const row = await env.DB.prepare("SELECT status, mp_payment_id FROM compras WHERE ref=?").bind(j.ref).first();
  expect(row.status).toBe("pendente");
  expect(row.mp_payment_id).toBe("1001");
});
