import { expect, test } from "vitest";
import { recomputaTotal, parcelasValidas } from "../src/precos.js";

test("subtotal soma preço do servidor, ignora preço do cliente", () => {
  const r = recomputaTotal([{ id: "tablete", tam: "M", qtd: 2 }], { metodo: "cartao" });
  expect(r.erro).toBeUndefined();
  expect(r.subtotal).toBeGreaterThan(0);
  expect(r.total).toBe(r.subtotal + r.frete - r.desconto);
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

test("item inexistente => erro (não confia no cliente)", () => {
  const r = recomputaTotal([{ id: "hacker", tam: "M", qtd: 1 }], { metodo: "pix" });
  expect(r.erro).toBe("item");
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
