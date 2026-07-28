import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../src/mp.js", () => ({
  criaPagamento: vi.fn(),
  consultaPagamento: vi.fn(),
  consultaPagamentoFull: vi.fn(async () => ({ id: 999, status: "in_process", pix: { qrBase64: "BASE64IMG", copiaECola: "COPIA-COLA" } })),
}));

import worker, { tokenPedido } from "../src/index.js";
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
    "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, parcelas, contato_email, contato_whats, cpf, endereco, status, mp_payment_id, consentiu) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      crypto.randomUUID(),
      ref,
      new Date().toISOString(),
      opts.itens || "[]",
      12300,
      opts.frete != null ? opts.frete : 0,
      615,
      11685,
      opts.metodo || "pix",
      opts.parcelas || 1,
      "a@b.com",
      opts.whats || null,
      "12345678909",
      opts.endereco || null,
      status,
      opts.mpId || null,
      1
    )
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
  expect(j.total).toBe(11685);
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

// Se o MP já avançou (aprovou o Pix) mas o webhook ainda não chegou, o próprio
// GET /api/compra persiste o novo status e devolve o `order` — a tela /pix
// confirma sozinha, sem depender só do webhook.
test("compra pendente em pix que o MP já aprovou: persiste 'aprovado' e devolve order", async () => {
  consultaPagamentoFull.mockResolvedValueOnce({ id: 42, status: "approved" }); // sem QR: já aprovou
  const itens = JSON.stringify([{ id: "tablete", tam: "M", qtd: 1, preco_unit: 12300 }]);
  await seedCompra("SUZU-PIX9", "pendente", { metodo: "pix", mpId: "42", itens });
  const t = await tokenPedido("SUZU-PIX9", env);
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-PIX9&t=" + encodeURIComponent(t)), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("aprovado");
  expect(j.order).toBeTruthy();
  expect(j.order.itens).toEqual([{ id: "tablete", tam: "M", qtd: 1, preco_unit: 12300 }]);
  expect(j.pix).toBeUndefined(); // aprovado não precisa mais de QR
  const row = await env.DB.prepare("SELECT status FROM compras WHERE ref='SUZU-PIX9'").first();
  expect(row.status).toBe("aprovado"); // persistido
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

// Tela /pix/<ref> aprovada (retornável, sem CO em memória): o front precisa do
// `order` completo pra montar o mesmo recap de /pedido (confirmView, index.html).
test("compra aprovada em pix inclui order com itens/total e NÃO expõe cpf nem mp_payment_id", async () => {
  const itens = JSON.stringify([{ id: "tablete", tam: "M", qtd: 2, preco_unit: 12300 }]);
  const endereco = JSON.stringify({ rua: "Rua das Flores", numero: "10", complemento: "", bairro: "Centro", cidade: "São Paulo", cep: "01000-000" });
  await seedCompra("SUZU-OK0001", "aprovado", {
    metodo: "pix",
    mpId: "555",
    itens,
    endereco,
    frete: 1500,
    whats: "11999999999",
  });
  const t = await tokenPedido("SUZU-OK0001", env);
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-OK0001&t=" + encodeURIComponent(t)), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.status).toBe("aprovado");
  expect(j.order).toBeTruthy();
  expect(j.order.ref).toBe("SUZU-OK0001");
  expect(j.order.itens).toEqual([{ id: "tablete", tam: "M", qtd: 2, preco_unit: 12300 }]);
  expect(j.order.total).toBe(11685);
  expect(j.order.frete).toBe(1500);
  expect(j.order.metodo).toBe("pix");
  expect(j.order.endereco).toEqual({ rua: "Rua das Flores", numero: "10", complemento: "", bairro: "Centro", cidade: "São Paulo", cep: "01000-000" });
  expect(j.order.contato_email).toBe("a@b.com");
  expect(j.order.contato_whats).toBe("11999999999");
  expect(j.order.cpf).toBeUndefined();
  expect(j.order.mp_payment_id).toBeUndefined();
  expect(JSON.stringify(j.order)).not.toContain("12345678909"); // cpf usado no seed, nunca deve vazar
});

// Privacidade: sem o token assinado (?t=), uma compra aprovada NÃO expõe os dados
// pessoais (order) — só o status. Fecha a coleta de PII por varredura de refs.
test("aprovada SEM token => devolve status mas NÃO o order (sem PII)", async () => {
  await seedCompra("SUZU-NOAUTH", "aprovado", { metodo: "pix", mpId: "321", endereco: JSON.stringify({ rua: "Rua X", cep: "01000-000" }) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-NOAUTH"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.status).toBe("aprovado");
  expect(j.order).toBeUndefined(); // dados do pedido ficam protegidos
});

test("aprovada com token ERRADO => também não expõe o order", async () => {
  await seedCompra("SUZU-BADTOK", "aprovado", { metodo: "pix", mpId: "322", endereco: JSON.stringify({ rua: "Rua Y", cep: "01000-000" }) });
  const ctx = createExecutionContext();
  const res = await worker.fetch(get("?ref=SUZU-BADTOK&t=nao-e-o-token-certo"), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("aprovado");
  expect(j.order).toBeUndefined();
});
