import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../src/mp.js", () => ({
  criaPagamento: vi.fn(async () => ({ id: 999, status: "approved", statusDetail: "accredited" })),
  consultaPagamento: vi.fn(async () => ({ id: 999, status: "approved" })),
}));

import worker from "../src/index.js";
import { criaPagamento } from "../src/mp.js";
import schemaSql from "../schema.sql?raw";
import catalogoSql from "../schema-catalogo.sql?raw";
import migraSql from "../migra-catalogo.sql?raw";

// O D1 de teste começa vazio (sem tabelas) — cria o schema (mesmo schema.sql
// de produção) antes de cada teste. Feito aqui, e não num setupFile de
// vitest.config.mjs, porque um setupFile que importa de "cloudflare:test"
// quebra o vi.mock() acima (ver issue 10201 do cloudflare/workers-sdk).
//
// O CATÁLOGO entra junto porque o preço cobrado passou a nascer de cat_variantes
// (ver src/precos.js): sem catálogo no banco não existe compra, e é assim que
// tem de ser — servidor sem preço não inventa preço.
function statements(sql) {
  // comentários primeiro: vários deles contêm ";" e partiriam o SQL no meio
  return sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
}
beforeEach(async () => {
  vi.clearAllMocks(); // zera contadores de chamada entre testes (idempotência checa nº de cobranças)
  for (const sql of [schemaSql, catalogoSql, migraSql]) {
    for (const stmt of statements(sql)) await env.DB.prepare(stmt).run();
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

test("idempotência: mesmo checkoutId não cobra 2× — o retry devolve a mesma compra", async () => {
  const cid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const payload = { itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", checkoutId: cid, consentiu: true };

  const ctx1 = createExecutionContext();
  const r1 = await worker.fetch(post(payload), env, ctx1);
  await waitOnExecutionContext(ctx1);
  const j1 = await r1.json();
  expect(j1.status).toBe("aprovado");
  expect(criaPagamento).toHaveBeenCalledTimes(1);

  // retry (duplo-clique / timeout): MESMO checkoutId
  const ctx2 = createExecutionContext();
  const r2 = await worker.fetch(post(payload), env, ctx2);
  await waitOnExecutionContext(ctx2);
  const j2 = await r2.json();
  expect(j2.ref).toBe(j1.ref); // mesma compra
  expect(j2.status).toBe("aprovado");
  expect(criaPagamento).toHaveBeenCalledTimes(1); // NÃO cobrou de novo

  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM compras WHERE id = ?").bind(cid).first();
  expect(cnt.n).toBe(1); // uma única linha
});

test("resposta traz o token assinado (t) — e só ele libera os dados do pedido no /api/compra", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true }), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("aprovado");
  expect(typeof j.t).toBe("string");
  expect(j.t.length).toBeGreaterThan(0);

  // COM o token: order liberado
  const c2 = createExecutionContext();
  const r2 = await worker.fetch(new Request("https://x/api/compra?ref=" + j.ref + "&t=" + encodeURIComponent(j.t)), env, c2);
  await waitOnExecutionContext(c2);
  expect((await r2.json()).order).toBeTruthy();

  // SEM o token: só status, sem PII
  const c3 = createExecutionContext();
  const r3 = await worker.fetch(new Request("https://x/api/compra?ref=" + j.ref), env, c3);
  await waitOnExecutionContext(c3);
  const j3 = await r3.json();
  expect(j3.status).toBe("aprovado");
  expect(j3.order).toBeUndefined();
});

test("trava de servidor: /api/pagar no domínio de produção => 403 (checkout OFF até o MEI)", async () => {
  const ctx = createExecutionContext();
  const req = new Request("https://studiosuzu.com.br/api/pagar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", endereco: { cep: "01310100" }, freteOpcao: "economico", consentiu: true }) });
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(403);
  expect(criaPagamento).not.toHaveBeenCalled(); // nem chegou a cobrar
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
