// Catálogo do Admin — API de produtos (CRUD) sobre as tabelas cat_*.
//
// Regras que valem aqui:
// • Preço SEMPRE em centavos (inteiro) — nunca float, nunca string.
// • Variação é GENÉRICA: o produto define os tipos de opção (nome livre) e cada
//   combinação vira uma variante com preço/estoque/peso/dimensões próprios.
// • Estoque, peso e dimensões vivem na VARIANTE (é o que muda cotação e etiqueta).
// • Nada aqui confia no cliente: números são coeridos e limitados; textos, cortados.

const MAX_TXT = 5000;
const MAX_NOME = 200;

// ── leitura ─────────────────────────────────────────────────────────────────
export async function listaProdutos(env) {
  const { results } = await env.DB.prepare(
    "SELECT p.id, p.nome, p.slug, p.status, p.destaque, p.ordem, p.preco, p.preco_promo, p.capa_asset, " +
      "(SELECT COUNT(*) FROM cat_variantes v WHERE v.produto_id = p.id) AS n_variantes, " +
      "(SELECT COALESCE(SUM(v.estoque),0) FROM cat_variantes v WHERE v.produto_id = p.id) AS estoque_total " +
      "FROM cat_produtos p ORDER BY p.ordem DESC, p.nome"
  ).all();
  return results || [];
}

export async function leProduto(env, id) {
  const p = await env.DB.prepare("SELECT * FROM cat_produtos WHERE id = ?").bind(String(id)).first();
  if (!p) return null;
  const ops = await env.DB.prepare("SELECT id, nome, ordem, valores FROM cat_opcoes WHERE produto_id = ? ORDER BY ordem").bind(p.id).all();
  const vars = await env.DB.prepare("SELECT * FROM cat_variantes WHERE produto_id = ? ORDER BY ordem").bind(p.id).all();
  return {
    ...p,
    opcoes: (ops.results || []).map((o) => ({ ...o, valores: jparse(o.valores, []) })),
    variantes: (vars.results || []).map((v) => ({ ...v, combinacao: jparse(v.combinacao, {}) })),
  };
}

// ── escrita ─────────────────────────────────────────────────────────────────
// Salva produto + opções + variantes numa tacada. `id` vazio = criar.
export async function salvaProduto(env, body) {
  const nome = txt(body.nome, MAX_NOME);
  if (!nome) return { ok: false, erro: "nome" };

  const id = txt(body.id, 64) || crypto.randomUUID();
  const existente = await env.DB.prepare("SELECT id FROM cat_produtos WHERE id = ?").bind(id).first();

  const slugBase = txt(body.slug, 200) || slugify(nome);
  const slug = await slugUnico(env, slugBase, id);
  const status = ["rascunho", "ativo", "arquivado"].includes(body.status) ? body.status : "rascunho";
  const preco = cents(body.preco);
  const promo = body.preco_promo === null || body.preco_promo === "" ? null : cents(body.preco_promo);
  // "de/por" só faz sentido se o promocional for MENOR que o cheio (CDC: preço
  // riscado tem de ser preço real praticado — não deixamos inverter por engano).
  if (promo !== null && promo >= preco) return { ok: false, erro: "promo_maior" };
  const agora = new Date().toISOString();

  if (existente) {
    await env.DB.prepare(
      "UPDATE cat_produtos SET slug=?, nome=?, descricao=?, status=?, destaque=?, ordem=?, preco=?, preco_promo=?, capa_asset=?, atualizado_em=? WHERE id=?"
    )
      .bind(slug, nome, txt(body.descricao, MAX_TXT), status, body.destaque ? 1 : 0, int(body.ordem), preco, promo, txt(body.capa_asset, 64) || null, agora, id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO cat_produtos (id,slug,nome,descricao,status,destaque,ordem,preco,preco_promo,capa_asset,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(id, slug, nome, txt(body.descricao, MAX_TXT), status, body.destaque ? 1 : 0, int(body.ordem), preco, promo, txt(body.capa_asset, 64) || null, agora, agora)
      .run();
  }

  // Opções e variantes: regrava o conjunto (o admin manda o estado completo).
  await env.DB.prepare("DELETE FROM cat_opcoes WHERE produto_id = ?").bind(id).run();
  const opcoes = Array.isArray(body.opcoes) ? body.opcoes.slice(0, 3) : [];
  for (let i = 0; i < opcoes.length; i++) {
    const o = opcoes[i] || {};
    const onome = txt(o.nome, 60);
    if (!onome) continue;
    const valores = (Array.isArray(o.valores) ? o.valores : []).map((v) => txt(v, 60)).filter(Boolean).slice(0, 30);
    await env.DB.prepare("INSERT INTO cat_opcoes (id,produto_id,nome,ordem,valores) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), id, onome, i, JSON.stringify(valores))
      .run();
  }

  await env.DB.prepare("DELETE FROM cat_variantes WHERE produto_id = ?").bind(id).run();
  const variantes = Array.isArray(body.variantes) ? body.variantes.slice(0, 100) : [];
  for (let i = 0; i < variantes.length; i++) {
    const v = variantes[i] || {};
    const vpreco = v.preco === null || v.preco === "" ? null : cents(v.preco);
    const vpromo = v.preco_promo === null || v.preco_promo === "" ? null : cents(v.preco_promo);
    await env.DB.prepare(
      "INSERT INTO cat_variantes (id,produto_id,combinacao,sku,preco,preco_promo,estoque,peso_g,comp_cm,larg_cm,alt_cm,imagem_asset,ativo,ordem) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        txt(v.id, 64) || crypto.randomUUID(),
        id,
        JSON.stringify(v.combinacao && typeof v.combinacao === "object" ? v.combinacao : {}),
        txt(v.sku, 60) || null,
        vpreco,
        vpromo,
        int(v.estoque),
        int(v.peso_g),
        num(v.comp_cm),
        num(v.larg_cm),
        num(v.alt_cm),
        txt(v.imagem_asset, 64) || null,
        v.ativo === false ? 0 : 1,
        i
      )
      .run();
  }
  return { ok: true, id, slug };
}

export async function apagaProduto(env, id) {
  const pid = String(id || "");
  if (!pid) return { ok: false, erro: "id" };
  // arquivar > apagar: preserva histórico e é reversível (padrão Shopify).
  await env.DB.prepare("UPDATE cat_produtos SET status='arquivado', atualizado_em=? WHERE id=?")
    .bind(new Date().toISOString(), pid)
    .run();
  return { ok: true };
}

// ── util ────────────────────────────────────────────────────────────────────
function jparse(s, fb) {
  try {
    return s ? JSON.parse(s) : fb;
  } catch (_) {
    return fb;
  }
}
function txt(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max || 200);
}
function int(v) {
  const n = Math.round(Number(v) || 0);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, 999999)) : 0;
}
function num(v) {
  const n = Number(v) || 0;
  return Number.isFinite(n) ? Math.max(0, Math.min(n, 9999)) : 0;
}
// CONTRATO: o cliente manda CENTAVOS (inteiro). Nada de "R$ 123,45" aqui —
// converter reais→centavos é responsabilidade do formulário (js/admin-catalogo.js).
// Se aceitássemos as duas formas, "123,45" viraria 123 centavos silenciosamente.
function cents(v) {
  const n = Math.round(Number(v) || 0);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, 99999999)) : 0;
}
function slugify(n) {
  return String(n)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
async function slugUnico(env, base, id) {
  let s = base || "produto";
  for (let i = 0; i < 50; i++) {
    const bate = await env.DB.prepare("SELECT id FROM cat_produtos WHERE slug = ? AND id <> ?").bind(s, id).first();
    if (!bate) return s;
    s = base + "-" + (i + 2);
  }
  return base + "-" + Date.now();
}
