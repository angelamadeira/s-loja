// Catálogo do admin — as lacunas fechadas nesta rodada (SEO, tags, SKU/código de
// barras, vender sem estoque, ordem da mídia, imagem por variante, duplicar,
// excluir). Roda no D1 de teste com o schema real.
import { env } from "cloudflare:test";
import { expect, test, beforeEach } from "vitest";

import { salvaProduto, leProduto, duplicaProduto, excluiProduto, apagaProduto, leConfig, salvaConfig, catalogoPublico } from "../src/catalogo.js";
import catalogoSql from "../schema-catalogo.sql?raw";
import categoriasSql from "../schema-categorias.sql?raw";

// Os schemas são comentados de ponta a ponta, inclusive NO FIM DA LINHA, e vários
// comentários contêm ";" ("-- contagem; baixa no PAGAMENTO confirmado"). Então:
// tira TODO comentário `--` primeiro, só depois separa por ";" — o contrário parte
// o arquivo no meio de um CREATE TABLE. (Nenhum literal destes schemas tem "--".)
function statements(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// O banco de teste é o MESMO ao longo do arquivo (o schema usa CREATE IF NOT
// EXISTS, que não limpa nada). Sem zerar, um produto criado num teste faz o
// slug do seguinte virar "peca-2" e o teste quebra por contaminação, não por bug.
const TABELAS = ["cat_slugs_antigos", "cat_produto_imagens", "cat_produto_categorias", "cat_variantes", "cat_opcoes", "cat_produtos", "cat_config", "assets"];

beforeEach(async () => {
  for (const sql of [catalogoSql, categoriasSql]) {
    for (const stmt of statements(sql)) {
      // schema-categorias.sql traz junto a migração das coleções que já existiam
      // no código (INSERT apontando pros 6 produtos antigos). Num banco de teste
      // vazio isso quebra na FK — aqui só interessa a ESTRUTURA.
      if (/^INSERT/i.test(stmt)) continue;
      await env.DB.prepare(stmt).run();
    }
  }
  for (const t of TABELAS) await env.DB.prepare("DELETE FROM " + t + " WHERE 1 = 1").run();
});

function base(extra) {
  return Object.assign(
    {
      nome: "Tablete Ursinho",
      preco: 11600,
      variantes: [{ combinacao: {}, preco: 11600, estoque: 4, peso_g: 120, comp_cm: 10, larg_cm: 8, alt_cm: 3, ativo: true }],
    },
    extra || {}
  );
}

test("SEO e tags vão pro banco e voltam como objeto/lista", async () => {
  const r = await salvaProduto(env, base({
    seo: { titulo: "Tablete Ursinho artesanal", descricao: "Molde autoral em chocolate belga." },
    tags: ["natal", "presente", "natal", "  "],
  }));
  expect(r.ok).toBe(true);
  const p = await leProduto(env, r.id);
  expect(p.seo.titulo).toBe("Tablete Ursinho artesanal");
  expect(p.seo.descricao).toBe("Molde autoral em chocolate belga.");
  // sem repetição e sem vazias
  expect(p.tags).toEqual(["natal", "presente"]);
});

test("sem SEO e sem tags, salva vazio em vez de quebrar", async () => {
  const r = await salvaProduto(env, base());
  const p = await leProduto(env, r.id);
  expect(p.seo).toEqual({});
  expect(p.tags).toEqual([]);
});

test("SKU, código de barras e 'vender sem estoque' persistem por variante", async () => {
  const r = await salvaProduto(env, base({
    variantes: [
      { combinacao: { Tamanho: "P" }, preco: 9000, estoque: 0, sku: "TAB-P", gtin: "7891234567890", vender_sem_estoque: true, ativo: true },
      { combinacao: { Tamanho: "M" }, preco: 11600, estoque: 2, sku: "TAB-M", gtin: "", vender_sem_estoque: false, ativo: true },
    ],
  }));
  const p = await leProduto(env, r.id);
  const [pp, mm] = p.variantes;
  expect(pp.sku).toBe("TAB-P");
  expect(pp.gtin).toBe("7891234567890");
  expect(pp.vender_sem_estoque).toBe(1);
  expect(mm.gtin).toBe(null);
  expect(mm.vender_sem_estoque).toBe(0);
});

test("a ordem da galeria é a ordem enviada (a 1ª é a capa)", async () => {
  const agora = new Date().toISOString();
  for (const a of ["a1", "a2", "a3"]) {
    await env.DB.prepare("INSERT INTO assets (id,r2_key,nome,tipo,criado_em) VALUES (?,?,?,?,?)")
      .bind(a, "catalogo/" + a, a, "image/jpeg", agora)
      .run();
  }
  const r = await salvaProduto(env, base({ galeria: [{ asset_id: "a3" }, { asset_id: "a1" }, { asset_id: "a2" }] }));
  const p = await leProduto(env, r.id);
  expect(p.galeria.map((g) => g.asset_id)).toEqual(["a3", "a1", "a2"]);

  // reordenar = salvar de novo com outra ordem
  const r2 = await salvaProduto(env, base({ id: r.id, galeria: [{ asset_id: "a1" }, { asset_id: "a2" }, { asset_id: "a3" }] }));
  expect(r2.ok).toBe(true);
  const p2 = await leProduto(env, r.id);
  expect(p2.galeria.map((g) => g.asset_id)).toEqual(["a1", "a2", "a3"]);
});

test("imagem própria da variante é guardada", async () => {
  await env.DB.prepare("INSERT INTO assets (id,r2_key,nome,tipo,criado_em) VALUES ('img1','catalogo/img1','img1','image/jpeg',?)")
    .bind(new Date().toISOString())
    .run();
  const r = await salvaProduto(env, base({
    galeria: [{ asset_id: "img1" }],
    variantes: [{ combinacao: { Cor: "Rosa" }, preco: 9000, estoque: 1, imagem_asset: "img1", ativo: true }],
  }));
  const p = await leProduto(env, r.id);
  expect(p.variantes[0].imagem_asset).toBe("img1");
});

test("duplicar copia tudo, vira rascunho e NÃO repete SKU nem código de barras", async () => {
  const orig = await salvaProduto(env, base({
    status: "ativo",
    tags: ["natal"],
    seo: { titulo: "T", descricao: "D" },
    opcoes: [{ nome: "Tamanho", valores: ["P", "M"] }],
    variantes: [
      { combinacao: { Tamanho: "P" }, preco: 9000, estoque: 3, sku: "TAB-P", gtin: "789", ativo: true },
      { combinacao: { Tamanho: "M" }, preco: 11600, estoque: 5, sku: "TAB-M", gtin: "790", ativo: true },
    ],
  }));
  const dup = await duplicaProduto(env, orig.id);
  expect(dup.ok).toBe(true);
  expect(dup.id).not.toBe(orig.id);

  const c = await leProduto(env, dup.id);
  expect(c.nome).toBe("Cópia de Tablete Ursinho");
  expect(c.status).toBe("rascunho"); // não publica por acidente
  expect(c.slug).not.toBe((await leProduto(env, orig.id)).slug);
  expect(c.tags).toEqual(["natal"]);
  expect(c.seo.titulo).toBe("T");
  expect(c.opcoes[0].valores).toEqual(["P", "M"]);
  expect(c.variantes).toHaveLength(2);
  expect(c.variantes.map((v) => v.estoque).sort()).toEqual([3, 5]);
  // identificadores únicos não se clonam
  expect(c.variantes.every((v) => v.sku === null && v.gtin === null)).toBe(true);
  // o original continua intacto
  const o = await leProduto(env, orig.id);
  expect(o.status).toBe("ativo");
  expect(o.variantes[0].sku).toBe("TAB-P");
});

test("arquivar tira da loja mas mantém o produto; excluir apaga com as variantes", async () => {
  const r = await salvaProduto(env, base({ status: "ativo", opcoes: [{ nome: "Cor", valores: ["Rosa"] }] }));
  await apagaProduto(env, r.id);
  expect((await leProduto(env, r.id)).status).toBe("arquivado");

  expect((await excluiProduto(env, r.id)).ok).toBe(true);
  expect(await leProduto(env, r.id)).toBe(null);
  const sobra = await env.DB.prepare("SELECT COUNT(*) AS n FROM cat_variantes WHERE produto_id = ?").bind(r.id).first();
  expect(sobra.n).toBe(0);
  const ops = await env.DB.prepare("SELECT COUNT(*) AS n FROM cat_opcoes WHERE produto_id = ?").bind(r.id).first();
  expect(ops.n).toBe(0);
});

test("link do post: aceita Instagram e TikTok de verdade", async () => {
  const r = await salvaProduto(env, base({
    video_links: {
      instagram: "https://www.instagram.com/reel/Cx1y2z3AbCd/",
      tiktok: "https://www.tiktok.com/@somos.suzu/video/7300000000000000000",
    },
  }));
  const p = await leProduto(env, r.id);
  expect(p.video_links.instagram).toBe("https://www.instagram.com/reel/Cx1y2z3AbCd/");
  expect(p.video_links.tiktok).toBe("https://www.tiktok.com/@somos.suzu/video/7300000000000000000");
});

test("link do post: recusa tudo que não seja https no domínio das redes", async () => {
  // este valor vira href numa página pública — a lista de permissão é a defesa
  const ruins = {
    instagram: "javascript:alert(document.cookie)",
    tiktok: "http://www.tiktok.com/@x/video/1", // http, não https
  };
  const r = await salvaProduto(env, base({ video_links: ruins }));
  expect((await leProduto(env, r.id)).video_links).toEqual({});

  // domínio parecido, mas não é a rede (typosquat)
  const r2 = await salvaProduto(env, base({ video_links: { instagram: "https://instagram.com.golpe.net/reel/1" } }));
  expect((await leProduto(env, r2.id)).video_links).toEqual({});

  // rede trocada: link do TikTok no campo do Instagram não passa
  const r3 = await salvaProduto(env, base({ video_links: { instagram: "https://www.tiktok.com/@x/video/1" } }));
  expect((await leProduto(env, r3.id)).video_links).toEqual({});
});

test("link do post vai junto na duplicação", async () => {
  const orig = await salvaProduto(env, base({ video_links: { instagram: "https://www.instagram.com/reel/AbC/" } }));
  const dup = await duplicaProduto(env, orig.id);
  expect((await leProduto(env, dup.id)).video_links.instagram).toBe("https://www.instagram.com/reel/AbC/");
});

// ── renomear não pode matar link já compartilhado ───────────────────────────
test("trocar o endereço guarda o antigo, e o antigo ainda aponta pro produto", async () => {
  const r = await salvaProduto(env, base({ nome: "Tablete Seigaiha", status: "ativo" }));
  expect((await leProduto(env, r.id)).slug).toBe("tablete-seigaiha");

  await salvaProduto(env, base({ id: r.id, nome: "Tablete Ursinho", slug: "tablete-ursinho", status: "ativo" }));
  expect((await leProduto(env, r.id)).slug).toBe("tablete-ursinho");

  const pub = await catalogoPublico(env);
  expect(pub.slugsAntigos["tablete-seigaiha"]).toBe(r.id);
});

test("voltar ao endereço antigo o tira do histórico (não pode ser atual e antigo)", async () => {
  const r = await salvaProduto(env, base({ nome: "Peça A", status: "ativo" }));
  await salvaProduto(env, base({ id: r.id, nome: "Peça A", slug: "peca-b", status: "ativo" }));
  expect((await catalogoPublico(env)).slugsAntigos["peca-a"]).toBe(r.id);

  await salvaProduto(env, base({ id: r.id, nome: "Peça A", slug: "peca-a", status: "ativo" }));
  const pub = await catalogoPublico(env);
  expect(pub.slugsAntigos["peca-a"]).toBeUndefined();
  expect(pub.slugsAntigos["peca-b"]).toBe(r.id);
});

// ── config da loja: o limiar de "Últimas unidades" ──────────────────────────
test("sem nada salvo, o limiar é o padrão (o comportamento que a loja já tinha)", async () => {
  expect((await leConfig(env)).limiar_ultimas_unidades).toBe(8);
});

test("limiar salvo vale para a loja e volta no catálogo público", async () => {
  await salvaConfig(env, { limiar_ultimas_unidades: 3 });
  expect((await leConfig(env)).limiar_ultimas_unidades).toBe(3);
  expect((await catalogoPublico(env)).config.limiarUltimas).toBe(3);
});

test("limiar fora da faixa é recusado sem estragar o que estava salvo", async () => {
  await salvaConfig(env, { limiar_ultimas_unidades: 3 });
  for (const ruim of [0, -5, 100, "abc", null]) {
    await salvaConfig(env, { limiar_ultimas_unidades: ruim });
    expect((await leConfig(env)).limiar_ultimas_unidades).toBe(3);
  }
});

test("o catálogo público só mostra produto ativo, e sem dado interno", async () => {
  const ativo = await salvaProduto(env, base({ nome: "Visível", status: "ativo" }));
  await salvaProduto(env, base({ nome: "Escondido", status: "rascunho" }));
  const pub = await catalogoPublico(env);
  const nomes = pub.produtos.map((p) => p.nome);
  expect(nomes).toContain("Visível");
  expect(nomes).not.toContain("Escondido");
  const p = pub.produtos.filter((x) => x.id === ativo.id)[0];
  expect(p.status).toBeUndefined(); // nada de rascunho/arquivado vazando
  expect(p.tags).toBeUndefined(); // tags são organização interna
});

test("excluir produto que não existe devolve erro em vez de fingir sucesso", async () => {
  expect(await excluiProduto(env, "nao-existe")).toEqual({ ok: false, erro: "nao_encontrado" });
});
