import { expect, test } from "vitest";
import { recomputaTotal, parcelasValidas } from "../src/precos.js";

test("subtotal soma preço do servidor, ignora preço do cliente", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 2 }], { metodo: "cartao" });
  expect(r.erro).toBeUndefined();
  expect(r.subtotal).toBeGreaterThan(0);
  expect(r.total).toBe(r.subtotal + r.frete - r.desconto);
});

test("ignora preço enviado pelo cliente (usa só o do servidor)", () => {
  const limpo = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { metodo: "cartao" });
  const adulterado = recomputaTotal(
    [{ id: "tablete", tam: "M", qtd: 1, preco: 1, precoCents: 1 }],
    { metodo: "cartao" }
  );
  expect(adulterado.subtotal).toBe(limpo.subtotal);
  expect(adulterado.subtotal).toBe(12300);
});

test("Pix aplica -5% sobre o subtotal", () => {
  const cartao = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { metodo: "cartao" });
  const pix = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { metodo: "pix" });
  expect(pix.desconto).toBe(Math.round(cartao.subtotal * 0.05));
});

test("cupom inválido não desconta", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { metodo: "cartao", cupom: "XXX" });
  expect(r.desconto).toBe(0);
});

test("linhas carrega o preco_unit cobrado por item (registro financeiro)", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 2 }], { metodo: "cartao" });
  expect(r.linhas).toEqual([{ id: "tablete", tam: "M", qtd: 2, preco_unit: 12300 }]);
});

test("item inexistente => erro (não confia no cliente)", () => {
  const r = recomputaTotal([{ id: "hacker", tam: "M", qtd: 1 }], { metodo: "pix" });
  expect(r.erro).toBe("item");
});

test("qtd inválida (0, negativa, fracionária, acima do teto) => erro qtd", () => {
  for (const q of [0, -2, 1.5, 100, 9999]) {
    expect(recomputaTotal([{ id: "tablete", tam: "M", qtd: q }], { metodo: "pix" }).erro).toBe("qtd");
  }
  // 99 (o teto) ainda passa
  expect(recomputaTotal([{ id: "tablete", tam: "M", qtd: 99 }], { metodo: "pix" }).erro).toBeUndefined();
});

test("Pix e cupom empilham (aditivo) — regra a confirmar", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { metodo: "pix", cupom: "PRIMEIRA10" });
  // subtotal 12300; pix 5% = 615; cupom 10% = 1230; desconto = 1845
  expect(r.desconto).toBe(615 + 1230);
  expect(r.total).toBe(12300 - 1845);
});

test("frete entra no total mas não no desconto de Pix", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 1 }], { metodo: "pix", freteCents: 1990 });
  expect(r.frete).toBe(1990);
  expect(r.total).toBe(r.subtotal + 1990 - r.desconto);
});

test("parcelas respeitam mínimo por parcela e teto", () => {
  expect(parcelasValidas(30000)).toEqual({ maxParcelas: 6, semJurosAte: 3 });
  expect(parcelasValidas(12000).maxParcelas).toBe(2); // 12000/5000 = 2.4 -> 2
});

test("total abaixo do mínimo por parcela => só à vista (1x)", () => {
  expect(parcelasValidas(4000).maxParcelas).toBe(1); // R$40 < R$50 mínimo
});
