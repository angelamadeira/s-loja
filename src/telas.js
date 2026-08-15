// Telas de apoio do admin — Estoque, Clientes, Relatórios e Mídia.
// Mesmas regras de src/vendas.js: query 100% .bind, lista com o MÍNIMO
// (Clientes agrega por e-mail e NUNCA carrega CPF/endereço — isso é do
// detalhe do pedido), nada de PII em log. Quem chama já validou a sessão.

// ── ESTOQUE — a "Inventory" do Shopify: uma linha por variante ──────────────

export async function listaEstoque(env) {
  const { results } = await env.DB.prepare(
    "SELECT v.id, v.combinacao, v.sku, v.estoque, v.vender_sem_estoque, v.ativo, " +
      "p.id AS produto_id, p.nome, p.status " +
      "FROM cat_variantes v JOIN cat_produtos p ON p.id = v.produto_id " +
      "WHERE p.status != 'arquivado' " +
      "ORDER BY p.ordem, p.nome, v.ordem"
  ).all();
  return (results || []).map((v) => ({
    id: v.id,
    produto_id: v.produto_id,
    produto: v.nome,
    produto_status: v.status,
    rotulo: rotuloDe(v.combinacao),
    sku: v.sku,
    estoque: Number(v.estoque) || 0,
    vender_sem_estoque: !!v.vender_sem_estoque,
    ativo: !!v.ativo,
  }));
}

// Só o número muda aqui — preço/medida continuam no formulário do produto.
// `de` é o valor que A TELA conhecia: o UPDATE só aplica se o banco ainda
// estiver nele. Se uma VENDA baixou o estoque no meio do caminho, salvar o
// número absoluto engoliria a baixa (peça vendida "voltaria a existir") —
// em vez disso devolvemos erro "mudou" com o valor atual, e a tela explica.
export async function salvaEstoque(env, id, estoque, de) {
  const n = Number(estoque);
  if (!Number.isInteger(n) || n < 0 || n > 100000) return { ok: false, erro: "estoque" };
  const alvo = String(id || "");
  const linha = await env.DB.prepare(
    "SELECT v.id, v.estoque, p.nome FROM cat_variantes v JOIN cat_produtos p ON p.id = v.produto_id WHERE v.id = ?"
  ).bind(alvo).first();
  if (!linha) return { ok: false, erro: "nao_encontrado" };
  const esperado = Number(de);
  if (Number.isInteger(esperado)) {
    const r = await env.DB.prepare("UPDATE cat_variantes SET estoque = ? WHERE id = ? AND estoque = ?")
      .bind(n, alvo, esperado)
      .run();
    if (!r.meta || !r.meta.changes) {
      const atual = await env.DB.prepare("SELECT estoque FROM cat_variantes WHERE id = ?").bind(alvo).first();
      return { ok: false, erro: "mudou", atual: Number(atual && atual.estoque) || 0 };
    }
  } else {
    // sem `de` (chamador antigo): comportamento absoluto de antes
    await env.DB.prepare("UPDATE cat_variantes SET estoque = ? WHERE id = ?").bind(n, alvo).run();
  }
  return { ok: true, id: alvo, de: Number(linha.estoque) || 0, para: n, produto: linha.nome };
}

// ── CLIENTES — agregado por e-mail, só de compras APROVADAS ─────────────────
// Minimização de propósito: a lista diz "quem, quantas, quanto, quando" — o
// resto (CPF, endereço, itens) mora no detalhe do PEDIDO, que já é auditável.

export async function listaClientes(env) {
  // LOWER: compras antigas guardaram o e-mail como o cliente digitou —
  // "Ana@..." e "ana@..." são a mesma pessoa (as novas já entram minúsculas)
  const { results } = await env.DB.prepare(
    "SELECT LOWER(contato_email) AS contato_email, COUNT(*) AS n_pedidos, SUM(total) AS total_gasto, MAX(criado_em) AS ultima " +
      "FROM compras WHERE status = 'aprovado' GROUP BY LOWER(contato_email) ORDER BY ultima DESC LIMIT 500"
  ).all();
  return (results || []).map((r) => ({
    contato_email: r.contato_email,
    n_pedidos: Number(r.n_pedidos) || 0,
    total_gasto: Number(r.total_gasto) || 0,
    ultima: r.ultima,
  }));
}

// ── RELATÓRIOS — números do NOSSO banco (visitas virão da Cloudflare depois) ─

export async function relatorios(env) {
  const d30 = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
  const d60 = new Date(Date.now() - 60 * 24 * 3600e3).toISOString();

  const [v30, v60, top, funil, aguardando] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS receita FROM compras WHERE status = 'aprovado' AND criado_em >= ?"
    ).bind(d30).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS receita FROM compras WHERE status = 'aprovado' AND criado_em >= ? AND criado_em < ?"
    ).bind(d60, d30).first(),
    // top produtos: abre o JSON de itens linha a linha (json_each é do SQLite)
    env.DB.prepare(
      "SELECT json_extract(j.value,'$.id') AS pid, " +
        "SUM(json_extract(j.value,'$.qtd')) AS pecas, " +
        "SUM(json_extract(j.value,'$.qtd') * json_extract(j.value,'$.preco_unit')) AS receita " +
        "FROM compras, json_each(compras.itens) AS j " +
        "WHERE compras.status = 'aprovado' AND compras.criado_em >= ? " +
        "GROUP BY pid ORDER BY receita DESC LIMIT 5"
    ).bind(d30).all(),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM pedidos GROUP BY status").all(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM compras WHERE status = 'pendente'").first(),
  ]);

  // nomes dos produtos do top
  const ids = (top.results || []).map((t) => String(t.pid || "")).filter(Boolean);
  const nomes = {};
  if (ids.length) {
    const marcas = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare("SELECT id, nome FROM cat_produtos WHERE id IN (" + marcas + ")").bind(...ids).all();
    for (const p of results || []) nomes[p.id] = p.nome;
  }

  const receita30 = Number(v30.receita) || 0;
  const n30 = Number(v30.n) || 0;
  return {
    janela: "30 dias",
    vendas: n30,
    receita: receita30,
    ticket: n30 ? Math.round(receita30 / n30) : 0,
    anterior: { vendas: Number(v60.n) || 0, receita: Number(v60.receita) || 0 },
    aguardando: Number(aguardando.n) || 0,
    top: (top.results || []).map((t) => ({
      id: t.pid,
      nome: nomes[t.pid] || "Produto fora do catálogo",
      pecas: Number(t.pecas) || 0,
      receita: Number(t.receita) || 0,
    })),
    orcamentos: Object.fromEntries((funil.results || []).map((f) => [f.status, Number(f.n) || 0])),
  };
}

// ── MÍDIA — galeria de assets com onde cada um é usado ──────────────────────

export async function listaMidia(env) {
  const [assets, capas, galeria, variantes, videos] = await Promise.all([
    env.DB.prepare("SELECT id, nome, tipo, largura, altura, bytes, poster_asset, criado_em FROM assets ORDER BY criado_em DESC LIMIT 500").all(),
    env.DB.prepare("SELECT capa_asset AS aid, nome FROM cat_produtos WHERE capa_asset IS NOT NULL").all(),
    env.DB.prepare("SELECT i.asset_id AS aid, p.nome FROM cat_produto_imagens i JOIN cat_produtos p ON p.id = i.produto_id").all(),
    env.DB.prepare("SELECT v.imagem_asset AS aid, p.nome FROM cat_variantes v JOIN cat_produtos p ON p.id = v.produto_id WHERE v.imagem_asset IS NOT NULL").all(),
    env.DB.prepare("SELECT video_asset AS aid, nome FROM cat_produtos WHERE video_asset IS NOT NULL").all(),
  ]);
  const uso = {};
  const anota = (rows, papel) => {
    for (const r of rows.results || []) {
      if (!r.aid) continue;
      (uso[r.aid] = uso[r.aid] || []).push(papel + " · " + r.nome);
    }
  };
  anota(capas, "capa");
  anota(galeria, "galeria");
  anota(variantes, "variante");
  anota(videos, "vídeo");
  return (assets.results || []).map((a) => ({
    id: a.id,
    nome: a.nome,
    tipo: a.tipo,
    largura: a.largura,
    altura: a.altura,
    bytes: a.bytes,
    poster_asset: a.poster_asset,
    criado_em: a.criado_em,
    usos: uso[a.id] || [],
  }));
}

function rotuloDe(combinacaoJson) {
  try {
    const c = JSON.parse(combinacaoJson || "{}");
    const vals = Object.values(c || {});
    return vals.length ? vals.join(" · ") : "Peça única";
  } catch (_) {
    return "Peça única";
  }
}
