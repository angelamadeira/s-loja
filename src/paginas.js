// Páginas de conteúdo do site (Fase 2 do plano do admin) — Termos, Trocas,
// Entrega e Privacidade editáveis SEM deploy.
//
// Modelo (decisões do plano, já travadas):
// - edição ESTRUTURADA, nunca HTML livre: o corpo é TEXTO com convenções
//   ("### " vira título, "- " vira lista, **negrito**, linha em branco separa
//   parágrafos); quem transforma em HTML é a vitrine, ESCAPANDO tudo;
// - rascunho → publicado: o site só lê `publicado = 1`. Sem linha publicada,
//   a vitrine segue no texto do código (fallback — nada regride);
// - slugs FIXOS (whitelist): v1 edita as páginas que existem, não cria novas.

const SLUGS = ["termos", "trocas", "entrega", "privacidade"];
const KICKER = { termos: "Legal", trocas: "Ajuda", entrega: "Ajuda", privacidade: "Privacidade" };
const TITULO_PADRAO = {
  termos: "Termos de Uso",
  trocas: "Trocas & Devoluções",
  entrega: "Entrega & Frete",
  privacidade: "Política de Privacidade",
};
const MAX_TITULO = 120;
const MAX_CORPO = 20000;

// tabela criada na primeira vez (mesmo padrão do admin_emails_permitidos —
// nada de depender de migração manual no D1 remoto)
async function garanteTabela(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS site_paginas (" +
      "slug TEXT PRIMARY KEY, titulo TEXT NOT NULL, corpo TEXT NOT NULL, " +
      "publicado INTEGER NOT NULL DEFAULT 0, atualizado_em TEXT NOT NULL)"
  ).run();
}

// Admin: TODAS as páginas, com estado — inclusive as que ainda vivem no código.
export async function listaPaginasAdmin(env) {
  await garanteTabela(env);
  const { results } = await env.DB.prepare("SELECT slug, titulo, corpo, publicado, atualizado_em FROM site_paginas").all();
  const noBanco = {};
  for (const r of results || []) noBanco[r.slug] = r;
  return SLUGS.map((slug) => {
    const r = noBanco[slug];
    return {
      slug,
      kicker: KICKER[slug],
      titulo: (r && r.titulo) || TITULO_PADRAO[slug],
      corpo: r ? r.corpo : "",
      // estado: "publicada" | "rascunho" | "codigo" (ainda não editada)
      estado: r ? (r.publicado ? "publicada" : "rascunho") : "codigo",
      atualizado_em: r ? r.atualizado_em : null,
    };
  });
}

export async function salvaPagina(env, body) {
  const b = body && typeof body === "object" ? body : {};
  const slug = String(b.slug || "");
  if (!SLUGS.includes(slug)) return { ok: false, erro: "slug" };
  const titulo = String(b.titulo == null ? "" : b.titulo).trim().slice(0, MAX_TITULO) || TITULO_PADRAO[slug];
  const corpo = String(b.corpo == null ? "" : b.corpo).slice(0, MAX_CORPO);
  // publicar página VAZIA deixaria a página real em branco — é rascunho à força
  const publicado = b.publicado === true && corpo.trim().length > 0 ? 1 : 0;
  if (b.publicado === true && !publicado) return { ok: false, erro: "vazia" };
  await garanteTabela(env);
  await env.DB.prepare(
    "INSERT INTO site_paginas (slug, titulo, corpo, publicado, atualizado_em) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(slug) DO UPDATE SET titulo = excluded.titulo, corpo = excluded.corpo, publicado = excluded.publicado, atualizado_em = excluded.atualizado_em"
  )
    .bind(slug, titulo, corpo, publicado, new Date().toISOString())
    .run();
  return { ok: true, slug, publicado: !!publicado };
}

// Despublicar = a vitrine volta pro texto do código (o rascunho fica guardado).
export async function despublicaPagina(env, slug) {
  const s = String(slug || "");
  if (!SLUGS.includes(s)) return { ok: false, erro: "slug" };
  await garanteTabela(env);
  await env.DB.prepare("UPDATE site_paginas SET publicado = 0, atualizado_em = ? WHERE slug = ?")
    .bind(new Date().toISOString(), s)
    .run();
  return { ok: true, slug: s };
}

// Público: SÓ as publicadas — é o que a vitrine consome.
export async function paginasPublicadas(env) {
  await garanteTabela(env);
  const { results } = await env.DB.prepare(
    "SELECT slug, titulo, corpo, atualizado_em FROM site_paginas WHERE publicado = 1"
  ).all();
  const out = {};
  for (const r of results || []) {
    if (!SLUGS.includes(r.slug)) continue;
    out[r.slug] = { kicker: KICKER[r.slug], titulo: r.titulo, corpo: r.corpo, atualizado_em: r.atualizado_em };
  }
  return out;
}
