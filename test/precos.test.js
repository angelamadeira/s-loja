import { expect, test } from "vitest";
import { recomputaTotal, parcelasValidas, freteQuoteCents } from "../src/precos.js";

// CEP de teste: região 0 (1º dígito) => base R$12,90 => Econômico 1290¢ (abaixo de R$150).
const CEP = "01310100";
const OPTS = { metodo: "cartao", cep: CEP, freteOpcao: "economico" };

test("subtotal soma preço do servidor, ignora preço do cliente", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 2 }], OPTS);
  expect(r.erro).toBeUndefined();
  expect(r.subtotal).toBeGreaterThan(0);
  expect(r.total).toBe(r.subtotal + r.frete - r.desconto);
});

test("ignora preço enviado pelo cliente (usa só o do servidor)", () => {
  const limpo = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], OPTS);
  const adulterado = recomputaTotal(
    [{ id: "tablete", tam: "M", qtd: 1, preco: 1, precoCents: 1 }],
    OPTS
  );
  expect(adulterado.subtotal).toBe(limpo.subtotal);
  expect(adulterado.subtotal).toBe(12300);
});

test("Pix aplica -5% sobre o subtotal", () => {
  const cartao = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], OPTS);
  const pix = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { ...OPTS, metodo: "pix" });
  expect(pix.desconto).toBe(Math.round(cartao.subtotal * 0.05));
});

test("cupom inválido não desconta", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { ...OPTS, cupom: "XXX" });
  expect(r.desconto).toBe(0);
});

test("linhas carrega o preco_unit cobrado por item (registro financeiro)", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 2 }], OPTS);
  expect(r.linhas).toEqual([{ id: "tablete", tam: "M", qtd: 2, preco_unit: 12300 }]);
});

test("item inexistente => erro (não confia no cliente)", () => {
  const r = recomputaTotal([{ id: "hacker", tam: "M", qtd: 1 }], { ...OPTS, metodo: "pix" });
  expect(r.erro).toBe("item");
});

test("qtd inválida (0, negativa, fracionária, acima do teto) => erro qtd", () => {
  for (const q of [0, -2, 1.5, 100, 9999]) {
    expect(recomputaTotal([{ id: "tablete", tam: "M", qtd: q }], { ...OPTS, metodo: "pix" }).erro).toBe("qtd");
  }
  // 99 (o teto por linha) ainda passa
  expect(recomputaTotal([{ id: "tablete", tam: "M", qtd: 99 }], { ...OPTS, metodo: "pix" }).erro).toBeUndefined();
});

test("acima do teto de LINHAS (MAX_ITENS) => erro itens", () => {
  const muitas = Array.from({ length: 51 }, () => ({ id: "tablete", tam: "M", qtd: 1 }));
  expect(recomputaTotal(muitas, OPTS).erro).toBe("itens");
});

test("Pix e cupom empilham (aditivo) — regra a confirmar", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { ...OPTS, metodo: "pix", cupom: "PRIMEIRA10" });
  // subtotal 12300; pix 5% = 615; cupom 10% = 1230; desconto = 1845; frete econômico 1290 (região 0)
  expect(r.desconto).toBe(615 + 1230);
  expect(r.frete).toBe(1290);
  expect(r.total).toBe(12300 + 1290 - 1845);
});

// ── frete recomputado no servidor (nunca confia no cliente) ──────────────────
test("frete entra no total mas não no desconto de Pix", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { ...OPTS, metodo: "pix" });
  expect(r.frete).toBe(1290); // econômico, região 0, subtotal < R$150
  expect(r.total).toBe(r.subtotal + r.frete - r.desconto);
});

test("frete grátis (econômico) acima de R$150 de subtotal", () => {
  // 2× tablete M = R$246 (>150) => econômico grátis
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 2 }], OPTS);
  expect(r.frete).toBe(0);
});

test("Expresso nunca é grátis e custa base + R$16", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 2 }], { ...OPTS, freteOpcao: "expresso" });
  expect(r.frete).toBe(2890); // (12,90 + 16) * 100
});

test("CEP inválido com itens a enviar => erro cep", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { metodo: "cartao", cep: "123", freteOpcao: "economico" });
  expect(r.erro).toBe("cep");
});

test("freteQuoteCents: região do CEP muda a base; CEP inválido => null", () => {
  expect(freteQuoteCents("01310100", 1000, "economico")).toBe(1290); // região 0
  expect(freteQuoteCents("80000000", 1000, "economico")).toBe(2570); // região 8: 12,90 + 8×1,60 = 25,70
  expect(freteQuoteCents("01310100", 20000, "economico")).toBe(0);   // grátis acima de R$150
  expect(freteQuoteCents("123", 1000, "economico")).toBe(null);      // CEP inválido
});

test("parcelas respeitam mínimo por parcela e teto", () => {
  expect(parcelasValidas(30000)).toEqual({ maxParcelas: 6, semJurosAte: 3 });
  expect(parcelasValidas(12000).maxParcelas).toBe(2); // 12000/5000 = 2.4 -> 2
});

test("total abaixo do mínimo por parcela => só à vista (1x)", () => {
  expect(parcelasValidas(4000).maxParcelas).toBe(1); // R$40 < R$50 mínimo
});
