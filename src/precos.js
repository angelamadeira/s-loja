// Fonte de preços do servidor + recomputação do total.
//
// Núcleo de segurança da Fase 4a: o valor cobrado nasce AQUI, no servidor —
// nunca no cliente. `recomputaTotal` ignora qualquer preço vindo do carrinho
// enviado pelo front; ele só lê {id,tam,qtd} e busca o preço no BANCO.
//
// ── POR QUE O BANCO, E NÃO UMA TABELA AQUI ────────────────────────────────────
// Antes este arquivo tinha uma CÓPIA dos preços, espelhando à mão o array
// PRODUCTS do index.html. Duas verdades sobre o mesmo preço é uma bomba-relógio:
// bastava a fundadora mudar o preço num lugar pra loja MOSTRAR um valor e o
// servidor COBRAR outro — o que, além de quebrar a confiança, é problema de CDC
// (o preço anunciado é o que vale). Agora existe uma fonte só: cat_variantes.
// A mesma linha que a vitrine lê pra mostrar é a que o servidor lê pra cobrar.
//
// Se o banco não responder, aqui NÃO se chuta preço: a compra falha. É melhor a
// cliente ver "tente de novo" do que ser cobrada por um valor que ninguém viu.

import { tamDaVariante } from "./catalogo.js";

// Preço a cobrar de uma variante: o promocional quando existe (é o que a loja
// mostra em destaque), senão o cheio.
function precoDeVenda(v) {
  return v.preco_promo != null && v.preco_promo > 0 && v.preco_promo < v.preco ? v.preco_promo : v.preco;
}

// Busca no banco os preços das variantes dos produtos pedidos, já indexados por
// {id do produto}{código do tamanho}. Uma consulta só, mesmo com vários itens.
export async function precosDoBanco(env, ids) {
  const unicos = [...new Set((ids || []).map((s) => String(s || "")).filter(Boolean))];
  if (!unicos.length) return {};
  const marcas = unicos.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    "SELECT v.id, v.produto_id, v.combinacao, v.preco, v.preco_promo, v.estoque, v.vender_sem_estoque " +
      "FROM cat_variantes v JOIN cat_produtos p ON p.id = v.produto_id " +
      "WHERE v.ativo = 1 AND p.status = 'ativo' AND v.produto_id IN (" + marcas + ")"
  )
    .bind(...unicos)
    .all();
  const mapa = {};
  for (const v of results || []) {
    let comb = {};
    try {
      comb = JSON.parse(v.combinacao || "{}");
    } catch (_) {
      comb = {};
    }
    const tam = tamDaVariante(comb);
    if (!tam) continue;
    (mapa[v.produto_id] = mapa[v.produto_id] || {})[tam] = {
      varId: v.id,
      preco: precoDeVenda(v),
      estoque: Number(v.estoque) || 0,
      semEstoque: !!v.vender_sem_estoque,
    };
  }
  return mapa;
}

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

export async function recomputaTotal(env, itens, opts) {
  const { metodo, cupom, cep, freteOpcao } = opts || {};

  const lista = Array.isArray(itens) ? itens : [];
  if (lista.length > MAX_ITENS) return { erro: "itens" };

  // Preços do BANCO — a mesma linha que a loja mostrou. Se a leitura falhar,
  // a compra para aqui (nunca cobramos por um preço adivinhado).
  let precos;
  try {
    precos = await precosDoBanco(env, lista.map((i) => i && i.id));
  } catch (e) {
    console.error("precos: leitura do catálogo falhou", e);
    return { erro: "catalogo" };
  }

  let subtotal = 0;
  const linhas = [];
  for (const item of lista) {
    const { id, tam, qtd } = item || {};
    const v = precos[id] && precos[id][tam];
    if (v === undefined) return { erro: "item" };
    const precoTam = v.preco;
    // teto por linha: peça autoral em tiragem limitada; 99 é folga de sobra e
    // fecha o buraco de inflar o total com uma qtd absurda (o MP acabaria
    // rejeitando por limite de valor, mas não devemos depender disso).
    if (!Number.isInteger(qtd) || qtd <= 0 || qtd > 99) return { erro: "qtd" };
    // ESTOQUE: não se vende o que não existe. "Continuar vendendo quando
    // esgotar", marcado no admin, é a exceção consciente dela — só aí passa
    // com estoque insuficiente.
    if (!v.semEstoque && qtd > v.estoque) return { erro: "estoque", id, tam, disponivel: v.estoque };
    subtotal += precoTam * qtd;
    // var_id na linha: é o endereço exato do que foi vendido. Sem ele, a baixa
    // de estoque teria de adivinhar a variante pelo nome do tamanho depois.
    linhas.push({ id, tam, qtd, preco_unit: precoTam, var_id: v.varId });
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
