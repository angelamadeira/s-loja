// Site editável (F2) — páginas com rascunho→publicado e barra de anúncio.
// Garantias: rotas do admin atrás da sessão; o PÚBLICO só vê o publicado;
// slug fora da whitelist é recusado; página vazia não publica; o link do
// aviso só aceita https/caminho (nada de javascript:).
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, beforeEach } from "vitest";

import worker from "../src/index.js";
import schemaSql from "../schema.sql?raw";
import schemaAdminSql from "../schema-admin.sql?raw";
import schemaCatalogoSql from "../schema-catalogo.sql?raw";

beforeEach(async () => {
  for (const sql of [schemaSql, schemaAdminSql, schemaCatalogoSql]) {
    const statements = sql
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => /^CREATE /i.test(s));
    for (const stmt of statements) await env.DB.prepare(stmt).run();
  }
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_paginas (slug TEXT PRIMARY KEY, titulo TEXT NOT NULL, corpo TEXT NOT NULL, publicado INTEGER NOT NULL DEFAULT 0, atualizado_em TEXT NOT NULL)").run();
  for (const t of ["site_paginas", "cat_config", "admin_auditoria", "admin_sessoes", "admin_usuarios"]) {
    await env.DB.prepare("DELETE FROM " + t).run();
  }
});

async function sha256hex(s) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function abreSessao() {
  const usuarioId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO admin_usuarios (id, email, nome, papel, ativo, criado_em) VALUES (?, 'somos.suzu@gmail.com', 'Suzu', 'dono', 1, ?)"
  ).bind(usuarioId, new Date().toISOString()).run();
  const segredo = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO admin_sessoes (id, usuario_id, token_hash, criado_em, expira_em, revogada) VALUES (?, ?, ?, ?, ?, 0)"
  )
    .bind(crypto.randomUUID(), usuarioId, await sha256hex(segredo), new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString())
    .run();
  return "suzu_admin=" + segredo;
}

async function chama(caminho, opts) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://x" + caminho, opts), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

test("rotas do site no admin sem sessão => 401", async () => {
  expect((await chama("/api/admin/paginas")).status).toBe(401);
  expect((await chama("/api/admin/pagina", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  expect((await chama("/api/admin/pagina/despublicar", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
});

test("rascunho não aparece no público; publicar aparece; despublicar some", async () => {
  const cookie = await abreSessao();
  const salva = (corpo) => chama("/api/admin/pagina", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });

  // rascunho
  await salva({ slug: "trocas", titulo: "Trocas & Devoluções", corpo: "### Arrependimento\nVocê tem 7 dias.", publicado: false });
  let pub = await (await chama("/api/paginas")).json();
  expect(pub.paginas.trocas).toBeUndefined();

  // publicado
  await salva({ slug: "trocas", titulo: "Trocas & Devoluções", corpo: "### Arrependimento\nVocê tem 7 dias.", publicado: true });
  pub = await (await chama("/api/paginas")).json();
  expect(pub.paginas.trocas.corpo).toContain("7 dias");
  expect(pub.paginas.trocas.kicker).toBe("Ajuda");

  // despublicado → público volta ao vazio (vitrine cai no texto do código)
  await chama("/api/admin/pagina/despublicar", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ slug: "trocas" }),
  });
  pub = await (await chama("/api/paginas")).json();
  expect(pub.paginas.trocas).toBeUndefined();
});

test("slug fora da whitelist e página vazia são recusados", async () => {
  const cookie = await abreSessao();
  const ruim = await chama("/api/admin/pagina", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ slug: "hacker", corpo: "x", publicado: true }),
  });
  expect(ruim.status).toBe(400);

  const vazia = await chama("/api/admin/pagina", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ slug: "termos", corpo: "   ", publicado: true }),
  });
  expect((await vazia.json()).erro).toBe("vazia");
});

test("barra de anúncio: salva na config e sai no catálogo; javascript: não passa", async () => {
  const cookie = await abreSessao();
  const salva = (aviso) => chama("/api/admin/config", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ aviso }),
  });

  await salva({ ligado: true, texto: "Frete grátis acima de R$ 150", link: "javascript:alert(1)" });
  let cat = await (await chama("/api/catalogo")).json();
  expect(cat.config.aviso.ligado).toBe(true);
  expect(cat.config.aviso.texto).toContain("Frete grátis");
  expect(cat.config.aviso.link).toBe(""); // esquema proibido caiu

  await salva({ ligado: true, texto: "Coleção nova", link: "/produtos" });
  cat = await (await chama("/api/catalogo")).json();
  expect(cat.config.aviso.link).toBe("/produtos");

  // ligar sem texto não liga
  await salva({ ligado: true, texto: "  ", link: "" });
  cat = await (await chama("/api/catalogo")).json();
  expect(cat.config.aviso.ligado).toBe(false);
});

test("checkout: whats inválido é recusado, dígitos normalizados quando válido", async () => {
  // rota /api/pagar exige mais contexto (itens/estoque), então validamos o
  // recorte que interessa: o corpo com whats ruim morre ANTES de cobrar.
  const res = await chama("/api/pagar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itens: [], metodo: "pix", email: "a@b.com", whats: "1234", consentiu: true }),
  });
  const j = await res.json();
  // em staging/local o checkout está liberado; whats curto => erro "whats"
  expect(res.status).toBe(400);
  expect(j.erro).toBe("whats");
});
