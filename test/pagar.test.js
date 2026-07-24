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
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", consentiu: true, precoFalso: 1 }), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.ok).toBe(true);
  expect(j.status).toBe("aprovado");
  const row = await env.DB.prepare("SELECT total, status FROM compras WHERE ref=?").bind(j.ref).first();
  expect(row.total).toBeGreaterThan(1); // ignorou precoFalso
  expect(row.status).toBe("aprovado");
});

test("item inexistente => 400", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "hacker", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", consentiu: true }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(400);
});

test("sem consentimento => 400", async () => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", consentiu: false }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(400);
});

test("Pix pendente: mapeia in_process => pendente e repassa o QR", async () => {
  criaPagamento.mockResolvedValueOnce({
    id: 1001,
    status: "in_process",
    statusDetail: "pending_waiting_transfer",
    pix: { qrBase64: "IMG", copiaECola: "COPIA" },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(post({ itens: [{ id: "tablete", tam: "M", qtd: 1 }], metodo: "pix", email: "a@b.com", cpf: "12345678909", consentiu: true }), env, ctx);
  await waitOnExecutionContext(ctx);
  const j = await res.json();
  expect(j.status).toBe("pendente");
  expect(j.pix).toEqual({ qrBase64: "IMG", copiaECola: "COPIA" });
  const row = await env.DB.prepare("SELECT status, mp_payment_id FROM compras WHERE ref=?").bind(j.ref).first();
  expect(row.status).toBe("pendente");
  expect(row.mp_payment_id).toBe("1001");
});
