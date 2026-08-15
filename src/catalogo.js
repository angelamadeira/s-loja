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

// ── mapa de tamanhos: uma verdade só ────────────────────────────────────────
// A vitrine trabalha com códigos P/M/G; o banco guarda o VALOR que a fundadora
// digitou na opção ("Pequeno"). Esta tabela é o único lugar que liga os dois —
// e é usada tanto pra montar o catálogo público quanto pra cobrar (precos.js).
export const TAM_CODIGO = { pequeno: "P", medio: "M", grande: "G" };

// Normaliza pra comparar: sem acento, minúsculo, sem espaço sobrando. Ela digita
// o valor à mão — "PEQUENO", "Médio", "medio" são a MESMA coisa, e tratar como
// coisas diferentes fazia a peça cair fora da grade de tamanhos sem explicação.
function chaveTam(s) {
  return String(s == null ? "" : s).trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Devolve o código de tamanho da variante, ou null se ela não for "por tamanho"
// (ex.: uma opção de Cor — aí a vitrine usa o rótulo da própria variante).
export function tamDaVariante(combinacao) {
  const c = combinacao && typeof combinacao === "object" ? combinacao : {};
  for (const chave of Object.keys(c)) {
    if (chaveTam(chave) !== "tamanho") continue;
    const cod = TAM_CODIGO[chaveTam(c[chave])];
    if (cod) return cod;
  }
  return null;
}

// ── config da loja (singleton `cat_config`, 1 linha) ────────────────────────
// Regras que valem pra loja inteira e não pertencem a nenhum produto.
// O PADRÃO é o comportamento que a loja JÁ TINHA (limiar 8) — mudar o padrão
// aqui mudaria a vitrine de todo mundo sem ninguém pedir.
const CONFIG_PADRAO = { limiar_ultimas_unidades: 8 };

export async function leConfig(env) {
  const linha = await env.DB.prepare("SELECT data FROM cat_config WHERE id = 'loja'").first();
  const salvo = linha ? jparse(linha.data, {}) : {};
  return { ...CONFIG_PADRAO, ...salvo };
}

export async function salvaConfig(env, body) {
  const atual = await leConfig(env);
  const b = body && typeof body === "object" ? body : {};
  // Limiar de "Últimas unidades": inteiro de 1 a 99. Zero não faz sentido (o
  // selo de 0 é "Esgotado", não "Últimas unidades").
  const limiar = Math.round(Number(b.limiar_ultimas_unidades));
  const nova = {
    ...atual,
    limiar_ultimas_unidades:
      Number.isFinite(limiar) && limiar >= 1 && limiar <= 99 ? limiar : atual.limiar_ultimas_unidades,
  };
  await env.DB.prepare(
    "INSERT INTO cat_config (id, data, atualizado_em) VALUES ('loja', ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, atualizado_em = excluded.atualizado_em"
  )
    .bind(JSON.stringify(nova), new Date().toISOString())
    .run();
  return { ok: true, config: nova };
}

// ── BAIXA DE ESTOQUE ────────────────────────────────────────────────────────
// Roda quando o pagamento é CONFIRMADO — nunca no carrinho, nunca no "iniciado".
// Reservar no carrinho travaria peça por causa de gente que só olha; descontar
// antes da confirmação venderia estoque que talvez nunca seja pago.
//
// IDEMPOTENTE por construção: o webhook do Mercado Pago é reenviado até receber
// 200, então a MESMA venda chega aqui várias vezes. A trava é `compras
// .estoque_baixado`: quem conseguir virar 0→1 é o único que desconta. Sem isso,
// cada reenvio comeria estoque de novo e a loja diria "esgotado" com peça pronta.
export async function baixaEstoque(env, compraId) {
  const id = txt(compraId, 64);
  if (!id) return { ok: false, erro: "id" };

  // reivindica a baixa: só uma execução consegue
  const claim = await env.DB.prepare(
    "UPDATE compras SET estoque_baixado = 1 WHERE id = ? AND estoque_baixado = 0 AND status = 'aprovado'"
  ).bind(id).run();
  if (!claim.meta || claim.meta.changes === 0) return { ok: true, jaFeito: true };

  const compra = await env.DB.prepare("SELECT ref, itens FROM compras WHERE id = ?").bind(id).first();
  const itens = jparse(compra && compra.itens, []);
  const baixados = [];
  for (const it of Array.isArray(itens) ? itens : []) {
    const qtd = Math.max(0, Math.round(Number(it && it.qtd) || 0));
    if (!qtd) continue;
    // pelo id da variante quando existe; senão, pela combinação de tamanho
    // (compras antigas, gravadas antes de a linha carregar var_id).
    // O casamento passa por tamDaVariante em vez de montar um LIKE com o nome:
    // ela digita o valor à mão, e "PEQUENO"/"Pequeno"/"pequeno" precisam achar a
    // mesma variante — um LIKE literal erraria em duas delas.
    let varId = txt(it.var_id, 64);
    if (!varId && it.id && it.tam) {
      const cands = (await env.DB.prepare(
        "SELECT id, combinacao FROM cat_variantes WHERE produto_id = ?"
      ).bind(String(it.id)).all()).results || [];
      const achou = cands.find((c) => tamDaVariante(jparse(c.combinacao, {})) === it.tam);
      varId = achou ? achou.id : "";
    }
    if (!varId) continue;
    // MAX(0, …): estoque negativo não existe no mundo real. Se chegasse aqui
    // negativo seria venda acima do disponível — que fica registrada na auditoria
    // abaixo em vez de virar um número impossível na tela.
    const antes = await env.DB.prepare("SELECT estoque FROM cat_variantes WHERE id = ?").bind(varId).first();
    await env.DB.prepare("UPDATE cat_variantes SET estoque = MAX(0, estoque - ?) WHERE id = ?")
      .bind(qtd, varId)
      .run();
    baixados.push({ varId, qtd, antes: antes ? antes.estoque : null, faltou: antes && antes.estoque < qtd });
  }
  return { ok: true, ref: compra && compra.ref, baixados };
}

// ── resumo do painel (a tela "Início" do admin) ─────────────────────────────
// Números REAIS do banco. Um painel com número inventado é pior que painel
// nenhum: ela tomaria decisão em cima de enfeite.
export async function resumoAdmin(env) {
  const cfg = await leConfig(env);
  const limiar = cfg.limiar_ultimas_unidades;
  const agora = new Date();
  const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();

  const vendas = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM compras WHERE status = 'aprovado' AND criado_em >= ?"
  ).bind(inicioMes).first();
  const aPagar = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM compras WHERE status = 'pendente'"
  ).first();
  const orcamentos = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pedidos WHERE status = 'novo'"
  ).first();
  // estoque por produto ATIVO: quantos zeraram e quantos estão na faixa de aviso
  const estoque = await env.DB.prepare(
    "SELECT SUM(CASE WHEN e = 0 THEN 1 ELSE 0 END) AS esgotados, " +
      "SUM(CASE WHEN e > 0 AND e <= ? THEN 1 ELSE 0 END) AS baixos FROM (" +
      "SELECT COALESCE(SUM(v.estoque),0) AS e FROM cat_produtos p " +
      "LEFT JOIN cat_variantes v ON v.produto_id = p.id AND v.ativo = 1 " +
      "WHERE p.status = 'ativo' GROUP BY p.id)"
  ).bind(limiar).first();
  const cat = await env.DB.prepare(
    "SELECT SUM(CASE WHEN status='ativo' THEN 1 ELSE 0 END) AS ativos, " +
      "SUM(CASE WHEN status='rascunho' THEN 1 ELSE 0 END) AS rascunhos FROM cat_produtos"
  ).first();

  return {
    vendas_mes: { n: (vendas && vendas.n) || 0, total: (vendas && vendas.total) || 0 },
    aguardando_pagamento: (aPagar && aPagar.n) || 0,
    orcamentos_novos: (orcamentos && orcamentos.n) || 0,
    esgotados: (estoque && estoque.esgotados) || 0,
    estoque_baixo: (estoque && estoque.baixos) || 0,
    limiar: limiar,
    produtos_ativos: (cat && cat.ativos) || 0,
    produtos_rascunho: (cat && cat.rascunhos) || 0,
  };
}

// ── catálogo PÚBLICO (o que a loja lê) ──────────────────────────────────────
// Só produtos 'ativo' e variantes 'ativo'. Devolve exatamente o que a vitrine
// precisa — nada de estoque interno, custo ou rascunho vazando pra fora.
export async function catalogoPublico(env) {
  const config = await leConfig(env);
  const prods = (await env.DB.prepare(
    "SELECT id, slug, nome, descricao, legenda, preco, preco_promo, capa_asset, video_asset, video_links " +
      "FROM cat_produtos WHERE status = 'ativo' ORDER BY ordem DESC, nome"
  ).all()).results || [];
  // A config vai junto mesmo sem produtos: é ela que diz à vitrine a partir de
  // quantas peças o selo vira "Últimas unidades".
  if (!prods.length) return { produtos: [], config: { limiarUltimas: config.limiar_ultimas_unidades } };

  const ids = prods.map((p) => p.id);
  const marcas = ids.map(() => "?").join(",");
  const vars = (await env.DB.prepare(
    "SELECT id, produto_id, combinacao, medida, preco, preco_promo, estoque, vender_sem_estoque, imagem_asset " +
      "FROM cat_variantes WHERE ativo = 1 AND produto_id IN (" + marcas + ") ORDER BY ordem"
  ).bind(...ids).all()).results || [];
  const imgs = (await env.DB.prepare(
    "SELECT i.produto_id, i.asset_id, a.tipo FROM cat_produto_imagens i JOIN assets a ON a.id = i.asset_id " +
      "WHERE i.produto_id IN (" + marcas + ") ORDER BY i.ordem"
  ).bind(...ids).all()).results || [];
  const cats = (await env.DB.prepare(
    "SELECT produto_id, categoria_id FROM cat_produto_categorias WHERE produto_id IN (" + marcas + ")"
  ).bind(...ids).all()).results || [];
  // endereços antigos → id do produto: é o que mantém link compartilhado vivo
  const antigos = (await env.DB.prepare(
    "SELECT slug, produto_id FROM cat_slugs_antigos WHERE produto_id IN (" + marcas + ")"
  ).bind(...ids).all()).results || [];

  const porProduto = (linhas) =>
    linhas.reduce((m, l) => ((m[l.produto_id] = m[l.produto_id] || []).push(l), m), {});
  const vPorProd = porProduto(vars);
  const iPorProd = porProduto(imgs);
  const cPorProd = porProduto(cats);

  return {
    config: { limiarUltimas: config.limiar_ultimas_unidades },
    slugsAntigos: antigos.reduce((m, a) => ((m[a.slug] = a.produto_id), m), {}),
    produtos: prods.map((p) => {
      const links = jparse(p.video_links, {});
      return {
        id: p.id,
        slug: p.slug,
        nome: p.nome,
        desc: p.descricao || "",
        use: p.legenda || "", /* a linha miúda acima do nome no card */
        capa: p.capa_asset || null,
        video: p.video_asset || null,
        ig: links.instagram || "",
        tt: links.tiktok || "",
        galeria: (iPorProd[p.id] || []).map((i) => ({ id: i.asset_id, tipo: i.tipo })),
        cats: (cPorProd[p.id] || []).map((c) => c.categoria_id),
        // TODAS as variantes ativas — inclusive as que não são "por tamanho".
        // Antes só as de Tamanho passavam, e um produto de Cor ou Sabor sumia da
        // loja EM SILÊNCIO (a fundadora cadastrava e não entendia por que não
        // aparecia). `tam` continua vindo quando existe, porque é ele que casa
        // com o filtro de tamanho e com os endereços antigos da vitrine.
        vars: (vPorProd[p.id] || []).map((v) => {
          const comb = jparse(v.combinacao, {});
          const vals = Object.keys(comb).map((k) => comb[k]).filter(Boolean);
          return {
            id: v.id,
            tam: tamDaVariante(comb), // null quando a opção não é Tamanho
            combinacao: comb,
            rotulo: vals.length ? vals.join(" · ") : "Peça única",
            medida: v.medida || "",
            cheio: v.preco,
            promo: v.preco_promo,
            estoque: v.estoque,
            semEstoque: v.vender_sem_estoque ? 1 : 0,
            img: v.imagem_asset || null,
          };
        }),
      };
    }),
  };
}

// ── leitura ─────────────────────────────────────────────────────────────────
// Lista do admin. Traz as VARIANTES junto porque é nelas que moram preço,
// estoque e disponibilidade — a lista do Shopify abre a linha do produto e
// mostra cada variante; sem esses dados aqui, essa tela não existe.
export async function listaProdutos(env) {
  const { results } = await env.DB.prepare(
    "SELECT p.id, p.nome, p.slug, p.status, p.destaque, p.ordem, p.preco, p.preco_promo, p.capa_asset, " +
      "(SELECT COUNT(*) FROM cat_variantes v WHERE v.produto_id = p.id) AS n_variantes, " +
      "(SELECT COALESCE(SUM(v.estoque),0) FROM cat_variantes v WHERE v.produto_id = p.id) AS estoque_total " +
      "FROM cat_produtos p ORDER BY p.ordem DESC, p.nome"
  ).all();
  const produtos = results || [];
  if (!produtos.length) return [];

  const marcas = produtos.map(() => "?").join(",");
  const vars = (await env.DB.prepare(
    "SELECT produto_id, combinacao, sku, medida, preco, preco_promo, estoque, vender_sem_estoque, ativo, imagem_asset " +
      "FROM cat_variantes WHERE produto_id IN (" + marcas + ") ORDER BY ordem"
  ).bind(...produtos.map((p) => p.id)).all()).results || [];
  const capas = (await env.DB.prepare(
    "SELECT produto_id, asset_id, MIN(ordem) AS ordem FROM cat_produto_imagens WHERE produto_id IN (" + marcas + ") GROUP BY produto_id"
  ).bind(...produtos.map((p) => p.id)).all()).results || [];

  const porProd = {};
  for (const v of vars) (porProd[v.produto_id] = porProd[v.produto_id] || []).push(v);
  const capaDe = {};
  for (const c of capas) capaDe[c.produto_id] = c.asset_id;

  return produtos.map((p) => {
    const lista = (porProd[p.id] || []).map((v) => ({
      combinacao: jparse(v.combinacao, {}),
      sku: v.sku || "",
      medida: v.medida || "",
      preco: v.preco,
      preco_promo: v.preco_promo,
      estoque: v.estoque,
      vender_sem_estoque: v.vender_sem_estoque,
      ativo: v.ativo,
      imagem_asset: v.imagem_asset,
    }));
    // faixa de preço ("a partir de X" quando as variantes têm preços diferentes)
    const cobrados = lista.filter((v) => v.ativo).map((v) => (v.preco_promo || v.preco) || 0).filter((n) => n > 0);
    return {
      ...p,
      // capa: a imagem escolhida no produto ou, na falta dela, a 1ª da galeria
      capa_asset: p.capa_asset || capaDe[p.id] || null,
      preco_min: cobrados.length ? Math.min(...cobrados) : null,
      preco_max: cobrados.length ? Math.max(...cobrados) : null,
      variantes: lista,
    };
  });
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
    seo: jparse(p.seo, {}),
    tags: jparse(p.tags, []),
    video_links: jparse(p.video_links, {}),
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
  const existente = await env.DB.prepare("SELECT id, ordem, slug FROM cat_produtos WHERE id = ?").bind(id).first();
  // A posição na vitrine não é campo do formulário. Se o corpo não trouxer
  // `ordem`, PRESERVA a que já existe — senão todo "Salvar" jogaria o produto
  // pro fim da fila sem ninguém pedir (foi o que aconteceu com os 6 primeiros).
  const ordem = body.ordem == null || body.ordem === "" ? (existente ? existente.ordem : 0) : int(body.ordem);

  const slugBase = txt(body.slug, 200) || slugify(nome);
  const slug = await slugUnico(env, slugBase, id);
  // Endereço mudou? Guarda o antigo pra ele continuar abrindo (links já
  // compartilhados não podem morrer porque a peça mudou de nome).
  if (existente && existente.slug && existente.slug !== slug) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO cat_slugs_antigos (slug, produto_id, criado_em) VALUES (?,?,?)"
    ).bind(existente.slug, id, new Date().toISOString()).run();
  }
  // Se o endereço NOVO era um endereço antigo (voltou atrás), tira do histórico —
  // senão o mesmo slug seria atual e antigo ao mesmo tempo.
  await env.DB.prepare("DELETE FROM cat_slugs_antigos WHERE slug = ?").bind(slug).run();
  const status = ["rascunho", "ativo", "arquivado"].includes(body.status) ? body.status : "rascunho";
  const preco = cents(body.preco);
  const promo = body.preco_promo === null || body.preco_promo === "" ? null : cents(body.preco_promo);
  // "de/por" só faz sentido se o promocional for MENOR que o cheio (CDC: preço
  // riscado tem de ser preço real praticado — não deixamos inverter por engano).
  // MAIOR é erro de verdade (mostraria um "desconto" que é aumento); IGUAL não é
  // engano nenhum, é só "sem promoção" — normaliza pra null em vez de recusar.
  const promoOk = promo === null || promo < preco ? promo : promo === preco ? null : undefined;
  if (promoOk === undefined) return { ok: false, erro: "promo_maior" };
  const seo = JSON.stringify(limpaSeo(body.seo));
  const tags = JSON.stringify(limpaTags(body.tags));
  const links = JSON.stringify(limpaLinksVideo(body.video_links));
  const agora = new Date().toISOString();

  if (existente) {
    await env.DB.prepare(
      "UPDATE cat_produtos SET slug=?, nome=?, descricao=?, legenda=?, status=?, destaque=?, ordem=?, preco=?, preco_promo=?, capa_asset=?, video_asset=?, video_links=?, seo=?, tags=?, atualizado_em=? WHERE id=?"
    )
      .bind(slug, nome, txt(body.descricao, MAX_TXT), txt(body.legenda, 80) || null, status, body.destaque ? 1 : 0, ordem, preco, promoOk, txt(body.capa_asset, 64) || null, txt(body.video_asset, 64) || null, links, seo, tags, agora, id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO cat_produtos (id,slug,nome,descricao,legenda,status,destaque,ordem,preco,preco_promo,capa_asset,video_asset,video_links,seo,tags,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(id, slug, nome, txt(body.descricao, MAX_TXT), txt(body.legenda, 80) || null, status, body.destaque ? 1 : 0, ordem, preco, promoOk, txt(body.capa_asset, 64) || null, txt(body.video_asset, 64) || null, links, seo, tags, agora, agora)
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
      "INSERT INTO cat_variantes (id,produto_id,combinacao,sku,gtin,medida,preco,preco_promo,estoque,vender_sem_estoque,peso_g,comp_cm,larg_cm,alt_cm,imagem_asset,ativo,ordem) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        txt(v.id, 64) || crypto.randomUUID(),
        id,
        JSON.stringify(v.combinacao && typeof v.combinacao === "object" ? v.combinacao : {}),
        txt(v.sku, 60) || null,
        txt(v.gtin, 60) || null,
        txt(v.medida, 40) || null,
        vpreco,
        vpromo,
        int(v.estoque),
        v.vender_sem_estoque ? 1 : 0,
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

// Exclusão DEFINITIVA — a que o Shopify esconde atrás de um "tem certeza?".
// Seguro para o histórico: `compras.itens` guarda um SNAPSHOT em JSON do que foi
// vendido (nome, tamanho, preço da hora), não uma FK pro catálogo. Apagar o
// produto não reescreve nem apaga venda nenhuma.
export async function excluiProduto(env, id) {
  const pid = txt(id, 64);
  if (!pid) return { ok: false, erro: "id" };
  const existe = await env.DB.prepare("SELECT id FROM cat_produtos WHERE id = ?").bind(pid).first();
  if (!existe) return { ok: false, erro: "nao_encontrado" };
  // opções, variantes, imagens e vínculos de categoria caem por ON DELETE CASCADE.
  await env.DB.prepare("DELETE FROM cat_produtos WHERE id = ?").bind(pid).run();
  return { ok: true };
}

// Duplicar — copia tudo (dados, opções, variantes, galeria, categorias) e devolve
// o clone como RASCUNHO, pra não publicar por acidente. Padrão Shopify.
export async function duplicaProduto(env, id) {
  const orig = await leProduto(env, id);
  if (!orig) return { ok: false, erro: "nao_encontrado" };
  const novoId = crypto.randomUUID();
  const nome = txt("Cópia de " + orig.nome, MAX_NOME);
  const slug = await slugUnico(env, slugify(nome), novoId);
  const agora = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO cat_produtos (id,slug,nome,descricao,legenda,status,destaque,ordem,preco,preco_promo,capa_asset,video_asset,video_links,seo,tags,criado_em,atualizado_em) " +
      "VALUES (?,?,?,?,?,'rascunho',?,?,?,?,?,?,?,?,?,?,?)"
  )
    .bind(
      novoId, slug, nome, orig.descricao || null, orig.legenda || null, orig.destaque ? 1 : 0, orig.ordem || 0,
      orig.preco, orig.preco_promo, orig.capa_asset, orig.video_asset,
      JSON.stringify(orig.video_links || {}), JSON.stringify(orig.seo || {}), JSON.stringify(orig.tags || []), agora, agora
    )
    .run();

  for (const o of orig.opcoes || []) {
    await env.DB.prepare("INSERT INTO cat_opcoes (id,produto_id,nome,ordem,valores) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), novoId, o.nome, o.ordem || 0, JSON.stringify(o.valores || []))
      .run();
  }
  for (const v of orig.variantes || []) {
    await env.DB.prepare(
      "INSERT INTO cat_variantes (id,produto_id,combinacao,sku,gtin,medida,preco,preco_promo,estoque,vender_sem_estoque,peso_g,comp_cm,larg_cm,alt_cm,imagem_asset,ativo,ordem) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        crypto.randomUUID(), novoId, JSON.stringify(v.combinacao || {}),
        // SKU e código de barras NÃO se copiam: são identificadores únicos —
        // duas peças com o mesmo código viram confusão de estoque.
        null, null, v.medida || null,
        v.preco, v.preco_promo, v.estoque, v.vender_sem_estoque ? 1 : 0,
        v.peso_g, v.comp_cm, v.larg_cm, v.alt_cm, v.imagem_asset, v.ativo ? 1 : 0, v.ordem || 0
      )
      .run();
  }
  for (const g of orig.galeria || []) {
    await env.DB.prepare("INSERT OR IGNORE INTO cat_produto_imagens (produto_id, asset_id, ordem) VALUES (?,?,?)")
      .bind(novoId, g.asset_id, g.ordem || 0)
      .run();
  }
  for (const c of orig.categorias || []) {
    await env.DB.prepare("INSERT OR IGNORE INTO cat_produto_categorias (produto_id, categoria_id) VALUES (?,?)")
      .bind(novoId, c)
      .run();
  }
  return { ok: true, id: novoId, slug };
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
  const pai = txt(body.pai_id, 64) || null;
  // ciclo é ERRO dito em voz alta, não correção silenciosa (pedido dela,
  // 2026-08-15): quem tentou aninhar precisa saber que não aninhou.
  if (pai === id) return { ok: false, erro: "ciclo" }; // mãe de si mesma
  if (pai && (await ehDescendente(env, pai, id))) return { ok: false, erro: "ciclo" };
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
// SEO: só os dois campos que o Google mostra. Limites folgados em relação ao que
// aparece na busca (~60 e ~160 caracteres) — cortar aqui seria decidir pela
// fundadora; o aviso de tamanho é do formulário, não uma trava do servidor.
function limpaSeo(s) {
  const o = s && typeof s === "object" ? s : {};
  const titulo = txt(o.titulo, 200);
  const descricao = txt(o.descricao, 500);
  return titulo || descricao ? { titulo, descricao } : {};
}
// Link do post da rede — este valor vira um href numa página PÚBLICA, então é
// lista de permissão, não faxina: só https e só nos domínios das duas redes.
// Assim um "javascript:..." ou um link pra qualquer outro site nunca chega lá.
const HOSTS_REDE = {
  instagram: ["instagram.com", "www.instagram.com"],
  tiktok: ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
};
function limpaLinksVideo(v) {
  const o = v && typeof v === "object" ? v : {};
  const out = {};
  for (const rede of Object.keys(HOSTS_REDE)) {
    const url = linkDaRede(o[rede], rede);
    if (url) out[rede] = url;
  }
  return out;
}
function linkDaRede(bruto, rede) {
  const s = txt(bruto, 300);
  if (!s) return "";
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return "";
  }
  if (u.protocol !== "https:") return "";
  if (!HOSTS_REDE[rede].includes(u.hostname.toLowerCase())) return "";
  return u.toString();
}
// Tags: lista de etiquetas curtas, sem repetição e sem vazias.
function limpaTags(t) {
  const arr = Array.isArray(t) ? t : [];
  const vistas = [];
  for (const x of arr) {
    const v = txt(x, 40);
    if (v && vistas.indexOf(v) < 0) vistas.push(v);
    if (vistas.length >= 30) break;
  }
  return vistas;
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
