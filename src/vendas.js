// Vendas no Admin — leitura de COMPRAS (menu "Pedidos") e de PEDIDOS de
// orçamento (menu "Orçamentos"; a tabela chama `pedidos` por razão histórica).
//
// REGRAS DE PRIVACIDADE deste módulo (dado de cliente mora aqui):
// - toda query é parametrizada (.bind) — nunca concatenar valor em SQL;
// - a LISTA devolve o mínimo pra reconhecer a linha; o dado completo (CPF,
//   endereço, brief) só sai no DETALHE, buscado por UUID;
// - PII NUNCA vai pra log: em erro, registra-se só o id/ref da linha;
// - anexo de orçamento sai por link ASSINADO (mesmo HMAC do e-mail — quem tem
//   o link certo já podia abrir; aqui não se cria porta nova);
// - quem chama (src/admin.js) já garantiu a sessão — este módulo não expõe rota.

const STATUS_ORCAMENTO = ["novo", "respondido", "orcado", "fechado", "perdido"];

// ── COMPRAS (vendas da loja) ────────────────────────────────────────────────

// Lista enxuta: o suficiente pra varrer o dia. `filtro` é um dos status da
// tabela ou "todos" (que mesmo assim esconde 'iniciado' — checkout abandonado
// não é pedido; ele terá a própria tela, como no Shopify).
export async function listaCompras(env, filtro) {
  const f = String(filtro || "").trim();
  const validos = ["iniciado", "pendente", "aprovado", "recusado", "cancelado"];
  let sql =
    "SELECT id, ref, criado_em, total, metodo, parcelas, status, contato_email, itens FROM compras ";
  let stmt;
  if (validos.includes(f)) {
    stmt = env.DB.prepare(sql + "WHERE status = ? ORDER BY criado_em DESC LIMIT 200").bind(f);
  } else {
    stmt = env.DB.prepare(sql + "WHERE status != 'iniciado' ORDER BY criado_em DESC LIMIT 200");
  }
  const { results } = await stmt.all();
  return (results || []).map((r) => ({
    id: r.id,
    ref: r.ref,
    criado_em: r.criado_em,
    total: r.total,
    metodo: r.metodo,
    parcelas: r.parcelas,
    status: r.status,
    contato_email: r.contato_email,
    qtd_itens: contaItens(r.itens),
  }));
}

// Detalhe completo — inclui o que a lista omite (CPF, endereço, itens com nome
// de produto). Buscado por UUID; id errado = null (o chamador devolve 404).
export async function pegaCompra(env, id) {
  const compra = await env.DB.prepare("SELECT * FROM compras WHERE id = ?").bind(String(id || "")).first();
  if (!compra) return null;

  let itens = [];
  try {
    itens = JSON.parse(compra.itens || "[]");
  } catch (_) {
    itens = [];
  }
  // nomes dos produtos (a linha guarda só o id — o nome de hoje vem do catálogo)
  const ids = [...new Set(itens.map((i) => String((i && i.id) || "")).filter(Boolean))];
  const nomes = {};
  if (ids.length) {
    const marcas = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      "SELECT id, nome FROM cat_produtos WHERE id IN (" + marcas + ")"
    )
      .bind(...ids)
      .all();
    for (const p of results || []) nomes[p.id] = p.nome;
  }

  let endereco = null;
  try {
    endereco = compra.endereco ? JSON.parse(compra.endereco) : null;
  } catch (_) {
    endereco = null;
  }

  return {
    id: compra.id,
    ref: compra.ref,
    criado_em: compra.criado_em,
    status: compra.status,
    metodo: compra.metodo,
    parcelas: compra.parcelas,
    subtotal: compra.subtotal,
    frete: compra.frete,
    desconto: compra.desconto,
    total: compra.total,
    mp_payment_id: compra.mp_payment_id,
    estoque_baixado: !!compra.estoque_baixado,
    consentiu: !!compra.consentiu,
    contato_email: compra.contato_email,
    contato_whats: compra.contato_whats,
    cpf: compra.cpf,
    endereco,
    itens: itens.map((i) => ({
      id: i.id,
      nome: nomes[i.id] || null,
      tam: i.tam,
      qtd: i.qtd,
      preco_unit: i.preco_unit,
    })),
  };
}

// ── ORÇAMENTOS (Projeto Exclusivo — tabela `pedidos`) ───────────────────────

export async function listaOrcamentos(env, filtro) {
  const f = String(filtro || "").trim();
  let stmt;
  const sql = "SELECT id, ref, criado_em, respondido_em, nome, contato, status, anexos FROM pedidos ";
  if (STATUS_ORCAMENTO.includes(f)) {
    stmt = env.DB.prepare(sql + "WHERE status = ? ORDER BY criado_em DESC LIMIT 200").bind(f);
  } else {
    stmt = env.DB.prepare(sql + "ORDER BY criado_em DESC LIMIT 200");
  }
  const { results } = await stmt.all();
  return (results || []).map((r) => ({
    id: r.id,
    ref: r.ref,
    criado_em: r.criado_em,
    respondido_em: r.respondido_em,
    nome: r.nome,
    contato: r.contato,
    status: r.status,
    qtd_anexos: contaItens(r.anexos),
  }));
}

export async function pegaOrcamento(env, id) {
  const p = await env.DB.prepare("SELECT * FROM pedidos WHERE id = ?").bind(String(id || "")).first();
  if (!p) return null;
  let anexos = [];
  try {
    anexos = JSON.parse(p.anexos || "[]");
  } catch (_) {
    anexos = [];
  }
  // link assinado por anexo — o MESMO formato do e-mail de aviso (serveAnexo
  // confere o HMAC da key com TURNSTILE_SECRET; sem segredo não há link válido)
  const comLink = [];
  for (const a of anexos) {
    if (!a || !a.key) continue;
    // um anexo sem assinatura possível (ex.: segredo ausente num ambiente
    // novo) NÃO derruba o orçamento inteiro — sai com url nula e a tela
    // mostra "link indisponível"; briefing e contato continuam acessíveis
    let url = null;
    try {
      url = "/api/anexo?k=" + encodeURIComponent(a.key) + "&t=" + (await assina(a.key, env.TURNSTILE_SECRET));
    } catch (e) {
      console.error("anexo sem assinatura", p.ref);
    }
    comLink.push({ name: a.name, size: a.size, type: a.type, url });
  }
  return {
    id: p.id,
    ref: p.ref,
    criado_em: p.criado_em,
    respondido_em: p.respondido_em,
    nome: p.nome,
    contato: p.contato,
    brief: p.brief,
    origem: p.origem,
    status: p.status,
    consentiu: !!p.consentiu,
    consent_versao: p.consent_versao,
    anexos: comLink,
  };
}

// Muda o status do orçamento (funil: novo → respondido → orcado → fechado/perdido,
// mas sem trancar o caminho — ela pode voltar um card de coluna, como no mercado).
// `respondido_em` grava na PRIMEIRA saída de "novo" e não se apaga: é a data que
// honra o "respondemos em 3 dias úteis" do formulário.
export async function mudaStatusOrcamento(env, id, status) {
  const s = String(status || "").trim();
  if (!STATUS_ORCAMENTO.includes(s)) return { ok: false, erro: "status" };
  const alvo = String(id || "");
  const linha = await env.DB.prepare("SELECT id, ref, status, respondido_em FROM pedidos WHERE id = ?").bind(alvo).first();
  if (!linha) return { ok: false, erro: "nao_encontrado" };
  const marcaResposta = !linha.respondido_em && s !== "novo";
  await env.DB.prepare(
    "UPDATE pedidos SET status = ?" + (marcaResposta ? ", respondido_em = ?" : "") + " WHERE id = ?"
  )
    .bind(...(marcaResposta ? [s, new Date().toISOString(), alvo] : [s, alvo]))
    .run();
  return { ok: true, ref: linha.ref, de: linha.status, para: s };
}

// ── util ─────────────────────────────────────────────────────────────────────

function contaItens(jsonTexto) {
  try {
    const arr = JSON.parse(jsonTexto || "[]");
    return Array.isArray(arr) ? arr.length : 0;
  } catch (_) {
    return 0;
  }
}

// Mesma assinatura do serveAnexo (src/index.js) — duplicada aqui de propósito:
// importar de index.js criaria ciclo (index → admin → vendas → index).
async function assina(dado, secret) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(dado));
  return btoa(String.fromCharCode.apply(null, new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
