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
export const FRETE_GRATIS_MIN_CENTS = 15000; // R$150 — casa com o subNow>=150 do cliente
export const MAX_ITENS = 50; // teto de LINHAS por pedido (anti-abuso; a qtd por linha já é ≤99)

// Frete recomputado NO SERVIDOR a partir do CEP + opção escolhida — o cliente
// nunca dita o valor do frete (só escolhe a opção). Mesma fórmula do shipQuote()
// de index.html: base = 12,90 + (1ª casa do CEP)×1,60; Econômico grátis acima de
// R$150; Expresso = base + 16 (nunca grátis). Devolve CENTAVOS, ou null se o CEP
// for inválido (≠ 8 dígitos).
export function freteQuoteCents(cep, subtotalCents, opcao) {
  const d = String(cep || "").replace(/\D/g, "");
  if (d.length !== 8) return null;
  const region = parseInt(d[0], 10) || 0;
  const base = Math.round((12.9 + region * 1.6) * 100) / 100; // reais, 2 casas
  if (opcao === "expresso") return Math.round((base + 16) * 100);
  return subtotalCents >= FRETE_GRATIS_MIN_CENTS ? 0 : Math.round(base * 100); // econômico (default)
}

export function recomputaTotal(itens, opts) {
  const { metodo, cupom, cep, freteOpcao } = opts || {};

  const lista = Array.isArray(itens) ? itens : [];
  if (lista.length > MAX_ITENS) return { erro: "itens" };

  let subtotal = 0;
  const linhas = [];
  for (const item of lista) {
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

  // Frete: recomputado do CEP AQUI (nunca confia no cliente). Só há frete quando
  // há subtotal a enviar; com itens a enviar e CEP inválido => erro "cep".
  let frete = 0;
  if (subtotal > 0) {
    const f = freteQuoteCents(cep, subtotal, freteOpcao);
    if (f === null) return { erro: "cep" };
    frete = f;
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
