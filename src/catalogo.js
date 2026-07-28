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
  const cats = await env.DB.prepare("SELECT categoria_id FROM cat_produto_categorias WHERE produto_id = ?").bind(p.id).all();
  const imgs = await env.DB.prepare(
    "SELECT i.asset_id, i.ordem, a.tipo FROM cat_produto_imagens i JOIN assets a ON a.id = i.asset_id WHERE i.produto_id = ? ORDER BY i.ordem"
  ).bind(p.id).all();
  return {
    ...p,
    opcoes: (ops.results || []).map((o) => ({ ...o, valores: jparse(o.valores, []) })),
    variantes: (vars.results || []).map((v) => ({ ...v, combinacao: jparse(v.combinacao, {}) })),
    categorias: (cats.results || []).map((c) => c.categoria_id),
    galeria: imgs.results || [],
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
  // categorias do produto (N:N) — regrava o conjunto
  await env.DB.prepare("DELETE FROM cat_produto_categorias WHERE produto_id = ?").bind(id).run();
  const cats = Array.isArray(body.categorias) ? body.categorias.slice(0, 20) : [];
  for (const c of cats) {
    const cid = txt(c, 64);
    if (!cid) continue;
    await env.DB.prepare("INSERT OR IGNORE INTO cat_produto_categorias (produto_id, categoria_id) VALUES (?,?)").bind(id, cid).run();
  }

  // galeria (imagens/vídeos) — regrava o conjunto, na ordem enviada
  await env.DB.prepare("DELETE FROM cat_produto_imagens WHERE produto_id = ?").bind(id).run();
  const galeria = Array.isArray(body.galeria) ? body.galeria.slice(0, 20) : [];
  for (let i = 0; i < galeria.length; i++) {
    const aid = txt(galeria[i] && (galeria[i].asset_id || galeria[i]), 64);
    if (!aid) continue;
    await env.DB.prepare("INSERT OR IGNORE INTO cat_produto_imagens (produto_id, asset_id, ordem) VALUES (?,?,?)").bind(id, aid, i).run();
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

// ── CATEGORIAS (com aninhamento) ────────────────────────────────────────────
export async function listaCategorias(env) {
  const { results } = await env.DB.prepare(
    "SELECT c.id, c.nome, c.slug, c.pai_id, c.ordem, " +
      "(SELECT COUNT(*) FROM cat_produto_categorias pc WHERE pc.categoria_id = c.id) AS n_produtos " +
      "FROM cat_categorias c ORDER BY c.ordem, c.nome"
  ).all();
  return results || [];
}

export async function salvaCategoria(env, body) {
  const nome = txt(body.nome, 120);
  if (!nome) return { ok: false, erro: "nome" };
  const id = txt(body.id, 64) || crypto.randomUUID();
  let pai = txt(body.pai_id, 64) || null;
  if (pai === id) pai = null; // não pode ser mãe de si mesma
  // evita ciclo (A dentro de B dentro de A)
  if (pai && (await ehDescendente(env, pai, id))) pai = null;
  const existente = await env.DB.prepare("SELECT id FROM cat_categorias WHERE id = ?").bind(id).first();
  const slug = await slugUnicoCat(env, txt(body.slug, 120) || slugify(nome), id);
  if (existente) {
    await env.DB.prepare("UPDATE cat_categorias SET nome=?, slug=?, pai_id=?, ordem=?, descricao=? WHERE id=?")
      .bind(nome, slug, pai, int(body.ordem), txt(body.descricao, 1000), id)
      .run();
  } else {
    await env.DB.prepare("INSERT INTO cat_categorias (id,nome,slug,pai_id,ordem,descricao,criado_em) VALUES (?,?,?,?,?,?,?)")
      .bind(id, nome, slug, pai, int(body.ordem), txt(body.descricao, 1000), new Date().toISOString())
      .run();
  }
  return { ok: true, id, slug };
}

export async function apagaCategoria(env, id) {
  const cid = txt(id, 64);
  if (!cid) return { ok: false, erro: "id" };
  // filhas sobem pra raiz (ON DELETE SET NULL) e os vínculos caem (CASCADE)
  await env.DB.prepare("DELETE FROM cat_categorias WHERE id = ?").bind(cid).run();
  return { ok: true };
}

// true se `possivelFilha` estiver na descendência de `raiz` — trava de ciclo
async function ehDescendente(env, possivelFilha, raiz) {
  let atual = possivelFilha;
  for (let i = 0; i < 20 && atual; i++) {
    if (atual === raiz) return true;
    const r = await env.DB.prepare("SELECT pai_id FROM cat_categorias WHERE id = ?").bind(atual).first();
    atual = r && r.pai_id ? r.pai_id : null;
  }
  return false;
}

async function slugUnicoCat(env, base, id) {
  let s = base || "categoria";
  for (let i = 0; i < 50; i++) {
    const bate = await env.DB.prepare("SELECT id FROM cat_categorias WHERE slug = ? AND id <> ?").bind(s, id).first();
    if (!bate) return s;
    s = base + "-" + (i + 2);
  }
  return base + "-" + Date.now();
}

// ── MÍDIA (imagem OU vídeo) — arquivo no R2, metadados no D1 ────────────────
const MAX_IMAGEM = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO = 50 * 1024 * 1024; // 50 MB

export async function subirMidia(env, request) {
  const form = await request.formData();
  const f = form.get("arquivo");
  if (!f || typeof f === "string") return { ok: false, erro: "arquivo" };
  const tipo = String(f.type || "");
  const ehImagem = tipo.startsWith("image/");
  const ehVideo = tipo.startsWith("video/");
  if (!ehImagem && !ehVideo) return { ok: false, erro: "tipo" };
  if (f.size > (ehVideo ? MAX_VIDEO : MAX_IMAGEM)) return { ok: false, erro: "grande" };

  const id = crypto.randomUUID();
  const ext = (String(f.name || "").match(/\.[a-z0-9]{1,5}$/i) || [""])[0].toLowerCase();
  const key = "catalogo/" + id + ext;
  await env.ANEXOS.put(key, f.stream(), { httpMetadata: { contentType: tipo } });
  await env.DB.prepare(
    "INSERT INTO assets (id, r2_key, nome, tipo, bytes, poster_asset, criado_em) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(id, key, txt(f.name, 200), tipo, f.size, txt(form.get("poster_asset"), 64) || null, new Date().toISOString())
    .run();
  return { ok: true, id, tipo, url: "/midia/" + id };
}

// Serve a mídia (pública — é imagem/vídeo de produto, aparece na loja).
export async function serveMidia(env, id) {
  const a = await env.DB.prepare("SELECT r2_key, tipo FROM assets WHERE id = ?").bind(txt(id, 64)).first();
  if (!a) return new Response("não encontrado", { status: 404 });
  const obj = await env.ANEXOS.get(a.r2_key);
  if (!obj) return new Response("não encontrado", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  if (a.tipo) h.set("content-type", a.tipo);
  // o id é único por upload, então o conteúdo nunca muda → cache longo
  h.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers: h });
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
