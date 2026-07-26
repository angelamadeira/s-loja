// Fonte de preços do servidor + recomputação do total.
//
// Núcleo de segurança da Fase 4a: o valor cobrado nasce AQUI, no servidor —
// nunca no cliente. `recomputaTotal` ignora qualquer preço vindo do carrinho
// enviado pelo front; ele só lê {id,tam,qtd} e busca o preço em PRECOS.
//
// Espelha o catálogo de `index.html` (array PRODUCTS ~L222, SIZES ~L219):
// preço por tamanho = (base + SIZES[tam].add), com sale% aplicado quando o
// produto tem `sale` (mesma semântica de `priceNow` no cliente), em CENTAVOS.
// Só os `sizes` listados por produto são combinações válidas.
//
// ⚠️ PROMOÇÃO GERAL (SALE do index.html) NÃO está espelhada aqui: este arquivo só
// conhece o `sale` POR PRODUTO (ex.: cubo:20). Se a promoção geral do site for
// ligada no front (SALE.active=true) sem ser espelhada aqui, o front mostra o
// desconto mas recomputaTotal cobra o preço CHEIO → cobrança a mais. Espelhar o
// SALE aqui antes de usar a promoção geral (ver aviso no index.html ~L247).

const SIZES = { P: 0, M: 34, G: 82 };

const PRODUCTS = [
  { id: "tablete", base: 89, sizes: ["M", "G"] },
  { id: "coracao", base: 68, sizes: ["P", "M"] },
  { id: "concha", base: 71, sizes: ["P", "M"] },
  { id: "cubo", base: 82, sale: 20, sizes: ["M", "G"] },
  { id: "esfera", base: 74, sizes: ["P", "M", "G"] },
  { id: "macaron", base: 79, sizes: ["P", "M"] },
];

function precoCents(base, add, salePct) {
  const reais = base + add;
  const cents = reais * 100;
  return salePct ? Math.round(cents * (1 - salePct / 100)) : cents;
}

export const PRECOS = PRODUCTS.reduce((acc, p) => {
  acc[p.id] = p.sizes.reduce((tams, tam) => {
    tams[tam] = precoCents(p.base, SIZES[tam], p.sale);
    return tams;
  }, {});
  return acc;
}, {});

export const CUPONS = { PRIMEIRA10: 10, SUZU15: 15 };

export const PIX_DESCONTO_PCT = 5;
export const PARCELA_MIN_CENTS = 5000;
export const MAX_PARCELAS_SEM_JUROS = 3;
export const MAX_PARCELAS = 6;

export function recomputaTotal(itens, opts) {
  const { metodo, cupom, freteCents } = opts || {};
  const frete = Number.isFinite(freteCents) ? freteCents : 0;

  let subtotal = 0;
  const linhas = [];
  for (const item of itens || []) {
    const { id, tam, qtd } = item || {};
    const precoTam = PRECOS[id] && PRECOS[id][tam];
    if (precoTam === undefined) return { erro: "item" };
    // teto por linha: peça autoral em tiragem limitada; 99 é folga de sobra e
    // fecha o buraco de inflar o total com uma qtd absurda (o MP acabaria
    // rejeitando por limite de valor, mas não devemos depender disso).
    if (!Number.isInteger(qtd) || qtd <= 0 || qtd > 99) return { erro: "qtd" };
    subtotal += precoTam * qtd;
    linhas.push({ id, tam, qtd, preco_unit: precoTam });
  }

  // Pix e cupom empilham (aditivo): os dois descontos se somam sobre o
  // subtotal quando ambos se aplicam. Regra de negócio CONFIRMADA com a
  // fundadora (aditivo) — ver "Pix e cupom empilham (aditivo)" em precos.test.js.
  let desconto = 0;
  if (metodo === "pix") {
    desconto += Math.round(subtotal * (PIX_DESCONTO_PCT / 100));
  }
  if (cupom && CUPONS[cupom]) {
    desconto += Math.round(subtotal * (CUPONS[cupom] / 100));
  }

  const total = Math.max(0, subtotal + frete - desconto);

  return { subtotal, desconto, frete, total, linhas };
}

export function parcelasValidas(totalCents) {
  const maxParcelas = Math.max(
    1,
    Math.min(MAX_PARCELAS, Math.floor(totalCents / PARCELA_MIN_CENTS))
  );
  const semJurosAte = Math.min(MAX_PARCELAS_SEM_JUROS, maxParcelas);
  return { maxParcelas, semJurosAte };
}
