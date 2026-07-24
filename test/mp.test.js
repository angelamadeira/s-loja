import { expect, test, vi } from "vitest";
import { criaPagamento, consultaPagamento } from "../src/mp.js";

test("criaPagamento manda valor em reais e Bearer token", async () => {
  const calls = [];
  const fake = vi.fn(async (url, opts) => { calls.push({ url, opts });
    return new Response(JSON.stringify({ id: 111, status: "approved", status_detail: "accredited" }), { status: 201 }); });
  const env = { MP_ACCESS_TOKEN: "TEST-x" };
  const r = await criaPagamento(env, { totalCents: 12000, metodo: "pix", email: "a@b.com", cpf: "12345678909", ref: "SUZU-AB12CD", descricao: "Pedido" }, fake);
  expect(calls[0].url).toContain("/v1/payments");
  expect(calls[0].opts.headers.Authorization).toBe("Bearer TEST-x");
  const body = JSON.parse(calls[0].opts.body);
  expect(body.transaction_amount).toBe(120); // reais, não centavos
  expect(r.status).toBe("approved");
});

test("criaPagamento manda X-Idempotency-Key com o ref e payment_method_id pix", async () => {
  const calls = [];
  const fake = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    return new Response(JSON.stringify({ id: 222, status: "approved", status_detail: "accredited" }), { status: 201 });
  });
  const env = { MP_ACCESS_TOKEN: "TEST-x" };
  await criaPagamento(env, { totalCents: 5000, metodo: "pix", email: "a@b.com", cpf: "12345678909", ref: "SUZU-XYZ", descricao: "Pedido" }, fake);
  expect(calls[0].opts.headers["X-Idempotency-Key"]).toBe("SUZU-XYZ");
  const body = JSON.parse(calls[0].opts.body);
  expect(body.payment_method_id).toBe("pix");
  expect(body.token).toBeUndefined();
});

test("Pix: retorna qrBase64 e copiaECola extraídos de point_of_interaction", async () => {
  const fake = vi.fn(async () =>
    new Response(
      JSON.stringify({
        id: 333,
        status: "in_process",
        status_detail: "pending_waiting_transfer",
        point_of_interaction: {
          transaction_data: { qr_code_base64: "BASE64IMG", qr_code: "COPIA-E-COLA" },
        },
      }),
      { status: 201 }
    )
  );
  const env = { MP_ACCESS_TOKEN: "TEST-x" };
  const r = await criaPagamento(env, { totalCents: 12000, metodo: "pix", email: "a@b.com", cpf: "12345678909", ref: "SUZU-QR1", descricao: "Pedido" }, fake);
  expect(r.pix).toEqual({ qrBase64: "BASE64IMG", copiaECola: "COPIA-E-COLA" });
});

test("cartão: não inclui campo pix na resposta", async () => {
  const fake = vi.fn(async () =>
    new Response(JSON.stringify({ id: 444, status: "approved", status_detail: "accredited" }), { status: 201 })
  );
  const env = { MP_ACCESS_TOKEN: "TEST-x" };
  const r = await criaPagamento(env, { totalCents: 12000, metodo: "cartao", token: "card-tok-abc", parcelas: 3, email: "a@b.com", cpf: "12345678909", ref: "SUZU-CC1", descricao: "Pedido" }, fake);
  expect(r.pix).toBeUndefined();
});

test("cartão envia o payment_method_id e o token do Brick", async () => {
  const calls = [];
  const fake = async (url, opts) => { calls.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: 7, status: "approved" }), { status: 201 }); };
  await criaPagamento({ MP_ACCESS_TOKEN: "TEST-x" }, { totalCents: 12000, metodo: "cartao", paymentMethodId: "master", issuerId: "25", installments: 3, parcelas: 3, token: "tok_abc", email: "a@b.com", cpf: "12345678909", ref: "SUZU-CARD01", descricao: "Pedido" }, fake);
  expect(calls[0].payment_method_id).toBe("master");
  expect(calls[0].issuer_id).toBe("25");
  expect(calls[0].token).toBe("tok_abc");
  expect(calls[0].installments).toBe(3);
});

test("consultaPagamento faz GET em /v1/payments/{id} com Bearer token", async () => {
  const calls = [];
  const fake = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    return new Response(JSON.stringify({ id: 555, status: "approved" }), { status: 200 });
  });
  const env = { MP_ACCESS_TOKEN: "TEST-y" };
  const r = await consultaPagamento(env, 555, fake);
  expect(calls[0].url).toContain("/v1/payments/555");
  expect(calls[0].opts.headers.Authorization).toBe("Bearer TEST-y");
  expect(r).toEqual({ id: 555, status: "approved" });
});
