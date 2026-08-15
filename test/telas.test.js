// Telas de apoio do admin (Estoque, Clientes, Relatórios, Mídia) — as mesmas
// garantias de test/vendas.test.js: nada responde sem sessão, agregado de
// clientes não carrega CPF/endereço, e os números saem certos.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, beforeEach } from "vitest";

import worker from "../src/index.js";
import schemaSql from "../schema.sql?raw";
import schemaAdminSql from "../schema-admin.sql?raw";
import schemaCatalogoSql from "../schema-catalogo.sql?raw";
import schemaCategoriasSql from "../schema-categorias.sql?raw";

beforeEach(async () => {
  for (const sql of [schemaSql, schemaAdminSql, schemaCatalogoSql, schemaCategoriasSql]) {
    const statements = sql
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      // só a ESTRUTURA: schema-categorias.sql traz sementes de produção
      // (vínculos com produtos reais) que não existem no banco de teste
      .filter((s) => /^CREATE /i.test(s));
    for (const stmt of statements) await env.DB.prepare(stmt).run();
  }
  // filhas antes das mães — as FKs mandam na ordem
  for (const t of [
    "compras", "pedidos",
    "admin_auditoria", "admin_sessoes", "admin_passkeys", "admin_login_tokens", "admin_usuarios",
    "cat_produto_imagens", "cat_slugs_antigos", "cat_produto_categorias", "cat_categorias", "cat_variantes", "cat_produtos", "assets",
  ]) {
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

async function seedCatalogo() {
  const agora = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO cat_produtos (id, slug, nome, status, preco, criado_em, atualizado_em) VALUES ('p1','sakura','Molde Sakura','ativo',9800,?,?)"
  ).bind(agora, agora).run();
  await env.DB.prepare(
    "INSERT INTO cat_variantes (id, produto_id, combinacao, estoque, ativo) VALUES ('v1','p1','{\"Tamanho\":\"P\"}',7,1)"
  ).run();
}

async function seedVenda(email, total, itens, quando) {
  await env.DB.prepare(
    "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, parcelas, contato_email, cpf, status, consentiu) " +
      "VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'pix', 1, ?, '39053344705', 'aprovado', 1)"
  )
    .bind(crypto.randomUUID(), "SUZU-" + Math.random().toString(36).slice(2, 8).toUpperCase(), quando || new Date().toISOString(), JSON.stringify(itens), total, total, email)
    .run();
}

async function chama(caminho, opts) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://x" + caminho, opts), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

test("rotas das telas de apoio sem sessão => 401", async () => {
  for (const rota of ["/api/admin/estoque", "/api/admin/clientes", "/api/admin/relatorios", "/api/admin/midia"]) {
    const res = await chama(rota);
    expect(res.status, rota).toBe(401);
  }
  const post = await chama("/api/admin/estoque", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "v1", estoque: 3 }),
  });
  expect(post.status).toBe(401);
});

test("estoque: lista agrupável e ajuste inline com auditoria", async () => {
  const cookie = await abreSessao();
  await seedCatalogo();

  const lista = await chama("/api/admin/estoque", { headers: { cookie } });
  const j = await lista.json();
  expect(j.estoque[0]).toMatchObject({ id: "v1", produto: "Molde Sakura", rotulo: "P", estoque: 7 });

  const muda = await chama("/api/admin/estoque", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: "v1", estoque: 12 }),
  });
  const r = await muda.json();
  expect(r).toMatchObject({ ok: true, de: 7, para: 12 });
  const linha = await env.DB.prepare("SELECT estoque FROM cat_variantes WHERE id = 'v1'").first();
  expect(linha.estoque).toBe(12);
  const aud = await env.DB.prepare("SELECT alvo FROM admin_auditoria WHERE acao = 'estoque.ajuste'").first();
  expect(aud.alvo).toBe("v1");

  const invalido = await chama("/api/admin/estoque", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id: "v1", estoque: -2 }),
  });
  expect(invalido.status).toBe(400);
});

test("clientes: agrega por e-mail e NÃO carrega CPF", async () => {
  const cookie = await abreSessao();
  await seedVenda("fiel@x.com", 10000, []);
  await seedVenda("fiel@x.com", 5000, []);
  await seedVenda("nova@x.com", 2000, []);

  const res = await chama("/api/admin/clientes", { headers: { cookie } });
  const texto = await res.text();
  expect(texto).not.toContain("39053344705"); // agregado sem CPF — sempre
  const j = JSON.parse(texto);
  const fiel = j.clientes.find((c) => c.contato_email === "fiel@x.com");
  expect(fiel.n_pedidos).toBe(2);
  expect(fiel.total_gasto).toBe(15000);
});

test("relatórios: receita/ticket da janela e top produtos via itens", async () => {
  const cookie = await abreSessao();
  await seedCatalogo();
  await seedVenda("a@x.com", 19600, [{ id: "p1", tam: "P", qtd: 2, preco_unit: 9800 }]);
  await seedVenda("b@x.com", 9800, [{ id: "p1", tam: "P", qtd: 1, preco_unit: 9800 }]);
  // venda velha (fora da janela de 30 dias) não entra
  await seedVenda("c@x.com", 99900, [{ id: "p1", tam: "P", qtd: 9, preco_unit: 11100 }], new Date(Date.now() - 45 * 24 * 3600e3).toISOString());

  const res = await chama("/api/admin/relatorios", { headers: { cookie } });
  const j = await res.json();
  const R = j.relatorios;
  expect(R.vendas).toBe(2);
  expect(R.receita).toBe(29400);
  expect(R.ticket).toBe(14700);
  expect(R.anterior.receita).toBe(99900);
  expect(R.top[0]).toMatchObject({ nome: "Molde Sakura", pecas: 3, receita: 29400 });
});

test("mídia: lista assets com onde cada um é usado", async () => {
  const cookie = await abreSessao();
  const agora = new Date().toISOString();
  await env.DB.prepare("INSERT INTO assets (id, r2_key, nome, tipo, bytes, criado_em) VALUES ('a1','k/a1','foto.jpg','image/jpeg',2048,?)").bind(agora).run();
  await env.DB.prepare(
    "INSERT INTO cat_produtos (id, slug, nome, status, preco, capa_asset, criado_em, atualizado_em) VALUES ('p9','molde-x','Molde X','ativo',5000,'a1',?,?)"
  ).bind(agora, agora).run();

  const res = await chama("/api/admin/midia", { headers: { cookie } });
  const j = await res.json();
  expect(j.midia[0].id).toBe("a1");
  expect(j.midia[0].usos[0]).toBe("capa · Molde X");
});

// ── Quem pode entrar (lista viva de e-mails) ─────────────────────────────────

test("emails de acesso: sem sessão => 401", async () => {
  for (const [rota, metodo] of [["/api/admin/emails", "GET"], ["/api/admin/emails", "POST"], ["/api/admin/emails/remover", "POST"]]) {
    const res = await chama(rota, metodo === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : undefined);
    expect(res.status, rota + " " + metodo).toBe(401);
  }
});

test("emails: lista traz a semente, adiciona/remove, e a dona é irremovível", async () => {
  const cookie = await abreSessao();

  const lista = await chama("/api/admin/emails", { headers: { cookie } });
  const j = await lista.json();
  const emails = j.emails.map((e) => e.email);
  expect(emails).toContain("somos.suzu@gmail.com");
  expect(j.emails.find((e) => e.email === "somos.suzu@gmail.com").dono).toBe(true);

  const add = await chama("/api/admin/emails", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "Ajudante@Example.com " }),
  });
  expect((await add.json()).ok).toBe(true);
  const dep = await (await chama("/api/admin/emails", { headers: { cookie } })).json();
  expect(dep.emails.map((e) => e.email)).toContain("ajudante@example.com"); // normalizado

  const ruim = await chama("/api/admin/emails", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "nao-e-email" }),
  });
  expect(ruim.status).toBe(400);

  const tiraDona = await chama("/api/admin/emails/remover", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "somos.suzu@gmail.com" }),
  });
  expect(tiraDona.status).toBe(400);

  const tira = await chama("/api/admin/emails/remover", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ email: "ajudante@example.com" }),
  });
  expect((await tira.json()).ok).toBe(true);
  const fim = await (await chama("/api/admin/emails", { headers: { cookie } })).json();
  expect(fim.emails.map((e) => e.email)).not.toContain("ajudante@example.com");
});

test("coleções: aninhar em ciclo agora é ERRO dito, não correção silenciosa", async () => {
  const cookie = await abreSessao();
  const post = (corpo) => chama("/api/admin/categoria", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
  await post({ id: "c1", nome: "Bombons" });
  await post({ id: "c2", nome: "Esferas", pai_id: "c1" });

  const proprio = await (await post({ id: "c1", nome: "Bombons", pai_id: "c1" })).json();
  expect(proprio).toMatchObject({ ok: false, erro: "ciclo" });

  const ciclo = await (await post({ id: "c1", nome: "Bombons", pai_id: "c2" })).json();
  expect(ciclo).toMatchObject({ ok: false, erro: "ciclo" });

  // e o banco ficou como estava (c1 continua raiz)
  const linha = await env.DB.prepare("SELECT pai_id FROM cat_categorias WHERE id = 'c1'").first();
  expect(linha.pai_id).toBeNull();
});
