// Vendas no admin — o que estes testes protegem: DADO DE CLIENTE NÃO VAZA.
// 1) nenhuma rota de vendas responde sem sessão;
// 2) a LISTA não carrega CPF/endereço/brief (minimização — só o detalhe tem);
// 3) toda resposta sai com Cache-Control: no-store;
// 4) mudança de status funciona e marca respondido_em na 1ª resposta.
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, test, beforeEach } from "vitest";

import worker from "../src/index.js";
import schemaSql from "../schema.sql?raw";
import schemaAdminSql from "../schema-admin.sql?raw";
import schemaCatalogoSql from "../schema-catalogo.sql?raw";

beforeEach(async () => {
  // o link assinado do anexo usa este segredo (em produção é um secret real;
  // sem ele o WebCrypto recusa chave HMAC vazia)
  env.TURNSTILE_SECRET = "segredo-de-teste";
  for (const sql of [schemaSql, schemaAdminSql, schemaCatalogoSql]) {
    // comentários saem ANTES do split: um ";" dentro de comentário quebraria
    // o statement ao meio (e um pedaço só-comentário o D1 recusa)
    const statements = sql
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) await env.DB.prepare(stmt).run();
  }
  // o D1 de teste sobrevive entre os casos — cada teste começa do zero
  // (filhas antes das mães: auditoria/sessões referenciam usuários)
  for (const t of ["compras", "pedidos", "admin_auditoria", "admin_sessoes", "admin_usuarios"]) {
    await env.DB.prepare("DELETE FROM " + t).run();
  }
});

async function sha256hex(s) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// sessão válida direto no banco — o mesmo formato que o login cria
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

async function seedCompra() {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, parcelas, contato_email, contato_whats, cpf, endereco, status, consentiu) " +
      "VALUES (?, 'SUZU-VND001', ?, ?, 10000, 2000, 0, 12000, 'pix', 1, 'cliente@x.com', '5511999999999', '12345678909', ?, 'aprovado', 1)"
  )
    .bind(id, new Date().toISOString(), JSON.stringify([{ id: "p1", tam: "P", qtd: 2, preco_unit: 5000 }]), JSON.stringify({ cep: "01001000", cidade: "São Paulo", uf: "SP" }))
    .run();
  return id;
}

async function seedOrcamento(status) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO pedidos (id, ref, criado_em, nome, contato, brief, anexos, origem, status, consentiu, consent_versao) " +
      "VALUES (?, 'SUZU-ORC001', ?, 'Maria', 'maria@x.com', 'Quero um molde de sakura', ?, 'instagram', ?, 1, 'v1')"
  )
    .bind(id, new Date().toISOString(), JSON.stringify([{ key: "orcamentos/a/b.png", name: "b.png", size: 10, type: "image/png" }]), status || "novo")
    .run();
  return id;
}

async function chama(caminho, opts) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://x" + caminho, opts), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ── 1. nada responde sem sessão ──────────────────────────────────────────────
const ROTAS_GET = ["/api/admin/compras", "/api/admin/compra?id=x", "/api/admin/orcamentos", "/api/admin/orcamento?id=x"];

test("rotas de vendas sem sessão => 401, sem nenhum dado", async () => {
  await seedCompra();
  await seedOrcamento();
  for (const rota of ROTAS_GET) {
    const res = await chama(rota);
    expect(res.status, rota).toBe(401);
    const corpo = await res.text();
    expect(corpo, rota).not.toContain("cliente@x.com");
    expect(corpo, rota).not.toContain("12345678909");
  }
  const res = await chama("/api/admin/orcamento/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "x", status: "fechado" }),
  });
  expect(res.status).toBe(401);
});

test("página /admin/pedidos sem sessão => tela de login, sem dado de cliente", async () => {
  await seedCompra();
  const res = await chama("/admin/pedidos");
  const corpo = await res.text();
  expect(corpo).toContain("Entrar no Admin");
  expect(corpo).not.toContain("cliente@x.com");
});

// ── 2. minimização: a lista NÃO carrega o que só o detalhe precisa ──────────
test("lista de compras não expõe CPF nem endereço; detalhe expõe (autenticado)", async () => {
  const cookie = await abreSessao();
  const id = await seedCompra();

  const lista = await chama("/api/admin/compras", { headers: { cookie } });
  expect(lista.status).toBe(200);
  const textoLista = await lista.text();
  expect(textoLista).toContain("SUZU-VND001");
  expect(textoLista).not.toContain("12345678909"); // CPF só no detalhe
  expect(textoLista).not.toContain("01001000"); // endereço só no detalhe

  const det = await chama("/api/admin/compra?id=" + id, { headers: { cookie } });
  const j = await det.json();
  expect(j.ok).toBe(true);
  expect(j.compra.cpf).toBe("12345678909");
  expect(j.compra.endereco.cidade).toBe("São Paulo");
  expect(j.compra.itens[0].qtd).toBe(2);
});

test("lista de orçamentos não expõe o brief; detalhe expõe com anexo assinado", async () => {
  const cookie = await abreSessao();
  const id = await seedOrcamento();

  const lista = await chama("/api/admin/orcamentos", { headers: { cookie } });
  const textoLista = await lista.text();
  expect(textoLista).toContain("SUZU-ORC001");
  expect(textoLista).not.toContain("molde de sakura"); // brief só no detalhe

  const det = await chama("/api/admin/orcamento?id=" + id, { headers: { cookie } });
  const j = await det.json();
  expect(j.ok).toBe(true);
  expect(j.orcamento.brief).toContain("sakura");
  expect(j.orcamento.anexos[0].url).toMatch(/^\/api\/anexo\?k=.+&t=.+/); // link assinado, não a key crua
});

// ── 3. no-store em tudo ──────────────────────────────────────────────────────
test("respostas de vendas saem com Cache-Control: no-store", async () => {
  const cookie = await abreSessao();
  await seedCompra();
  for (const rota of ["/api/admin/compras", "/api/admin/orcamentos"]) {
    const res = await chama(rota, { headers: { cookie } });
    expect(res.headers.get("cache-control"), rota).toBe("no-store");
  }
});

// ── 4. funil do orçamento ────────────────────────────────────────────────────
test("mudar status marca respondido_em na primeira resposta e audita sem PII", async () => {
  const cookie = await abreSessao();
  const id = await seedOrcamento("novo");

  const res = await chama("/api/admin/orcamento/status", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id, status: "respondido" }),
  });
  const j = await res.json();
  expect(j.ok).toBe(true);

  const linha = await env.DB.prepare("SELECT status, respondido_em FROM pedidos WHERE id = ?").bind(id).first();
  expect(linha.status).toBe("respondido");
  expect(linha.respondido_em).toBeTruthy();

  // auditoria registra a transição pela REF — nunca contato/brief
  const aud = await env.DB.prepare("SELECT alvo, detalhe FROM admin_auditoria WHERE acao = 'orcamento.status'").first();
  expect(aud.alvo).toBe("SUZU-ORC001");
  expect(aud.detalhe).not.toContain("maria@x.com");

  const res2 = await chama("/api/admin/orcamento/status", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ id, status: "invalido" }),
  });
  expect(res2.status).toBe(400);
});

test("um anexo sem assinatura NÃO derruba o orçamento (url nula, resto vivo)", async () => {
  const cookie = await abreSessao();
  const id = await seedOrcamento();
  env.TURNSTILE_SECRET = ""; // ambiente sem o segredo: assinar é impossível

  const det = await chama("/api/admin/orcamento?id=" + id, { headers: { cookie } });
  const j = await det.json();
  expect(j.ok).toBe(true); // a tela abre
  expect(j.orcamento.brief).toContain("sakura"); // briefing acessível
  expect(j.orcamento.anexos[0].url).toBeNull(); // só o link ficou indisponível
});
