import { env } from "cloudflare:test";
import { expect, test, beforeEach } from "vitest";
import { recomputaTotal, parcelasValidas, freteQuoteCents } from "../src/precos.js";
import catalogoSql from "../schema-catalogo.sql?raw";
import migraSql from "../migra-catalogo.sql?raw";

// O preço cobrado agora vem do BANCO (cat_variantes), não de uma tabela copiada
// no código. Então o teste monta o catálogo real: schema + a migração dos 6
// produtos. Bônus: se a migração passar a gravar um preço errado, quebra AQUI.
function statements(sql) {
  return sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
}
beforeEach(async () => {
  for (const sql of [catalogoSql, migraSql]) {
    for (const stmt of statements(sql)) await env.DB.prepare(stmt).run();
  }
});

// CEP de teste: região 0 (1º dígito) => base R$12,90 => Econômico 1290¢ (abaixo de R$150).
const CEP = "01310100";
const OPTS = { metodo: "cartao", cep: CEP, freteOpcao: "economico" };

test("subtotal soma preço do servidor, ignora preço do cliente", async () => {
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 2 }], OPTS);
  expect(r.erro).toBeUndefined();
  expect(r.subtotal).toBeGreaterThan(0);
  expect(r.total).toBe(r.subtotal + r.frete - r.desconto);
});

test("ignora preço enviado pelo cliente (usa só o do servidor)", async () => {
  const limpo = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], OPTS);
  const adulterado = await recomputaTotal(env, 
    [{ id: "tablete", tam: "M", qtd: 1, preco: 1, precoCents: 1 }],
    OPTS
  );
  expect(adulterado.subtotal).toBe(limpo.subtotal);
  expect(adulterado.subtotal).toBe(12300);
});

test("Pix aplica -5% sobre o subtotal", async () => {
  const cartao = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], OPTS);
  const pix = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], { ...OPTS, metodo: "pix" });
  expect(pix.desconto).toBe(Math.round(cartao.subtotal * 0.05));
});

test("cupom inválido não desconta", async () => {
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], { ...OPTS, cupom: "XXX" });
  expect(r.desconto).toBe(0);
});

test("linhas carrega o preco_unit cobrado por item (registro financeiro)", async () => {
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 2 }], OPTS);
  expect(r.linhas).toHaveLength(1);
  expect(r.linhas[0]).toMatchObject({ id: "tablete", tam: "M", qtd: 2, preco_unit: 12300 });
  // var_id: o endereço exato do que foi vendido — é ele que a baixa de estoque usa
  expect(typeof r.linhas[0].var_id).toBe("string");
});

test("item inexistente => erro (não confia no cliente)", async () => {
  const r = await recomputaTotal(env, [{ id: "hacker", tam: "M", qtd: 1 }], { ...OPTS, metodo: "pix" });
  expect(r.erro).toBe("item");
});

// ── uma fonte de preço só: o que a loja mostra é o que o servidor cobra ──────
test("preço mudado no admin passa a ser o preço cobrado", async () => {
  await env.DB.prepare("UPDATE cat_variantes SET preco = 15000 WHERE produto_id = 'tablete' AND combinacao LIKE '%Médio%'").run();
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], OPTS);
  expect(r.subtotal).toBe(15000);
});

test("cobra o PROMOCIONAL quando existe (é o preço em destaque na vitrine)", async () => {
  // cubo Médio: 116,00 cheio / 92,80 promocional
  const r = await recomputaTotal(env, [{ id: "cubo", tam: "M", qtd: 1 }], OPTS);
  expect(r.subtotal).toBe(9280);
});

test("produto fora do ar (rascunho/arquivado) não pode ser comprado", async () => {
  await env.DB.prepare("UPDATE cat_produtos SET status = 'rascunho' WHERE id = 'tablete'").run();
  expect((await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], OPTS)).erro).toBe("item");
});

test("variante desmarcada de 'à venda' não pode ser comprada", async () => {
  await env.DB.prepare("UPDATE cat_variantes SET ativo = 0 WHERE produto_id = 'tablete'").run();
  expect((await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], OPTS)).erro).toBe("item");
});

test("tamanho que o produto não tem => erro (não inventa preço)", async () => {
  // tablete só tem Médio e Grande
  expect((await recomputaTotal(env, [{ id: "tablete", tam: "P", qtd: 1 }], OPTS)).erro).toBe("item");
});

// ── variação genérica: comprar pelo ID DA VARIANTE ──────────────────────────
const varIdDe = (prod, valor) =>
  env.DB.prepare("SELECT id FROM cat_variantes WHERE produto_id = ? AND combinacao LIKE ?")
    .bind(prod, "%" + valor + "%")
    .first()
    .then((r) => r && r.id);

test("compra pelo id da variante cobra o preço dela", async () => {
  const vid = await varIdDe("tablete", "Médio");
  const r = await recomputaTotal(env, [{ id: "tablete", varId: vid, qtd: 1 }], OPTS);
  expect(r.erro).toBeUndefined();
  expect(r.subtotal).toBe(12300);
  expect(r.linhas[0].var_id).toBe(vid);
});

test("id de variante de OUTRO produto é recusado", async () => {
  const vid = await varIdDe("cubo", "Médio");
  const r = await recomputaTotal(env, [{ id: "tablete", varId: vid, qtd: 1 }], OPTS);
  expect(r.erro).toBe("item");
});

test("id de variante desligada não vende (não é salvo-conduto)", async () => {
  const vid = await varIdDe("tablete", "Médio");
  await env.DB.prepare("UPDATE cat_variantes SET ativo = 0 WHERE id = ?").bind(vid).run();
  expect((await recomputaTotal(env, [{ id: "tablete", varId: vid, qtd: 1 }], OPTS)).erro).toBe("item");
});

test("tamanho digitado em CAIXA ALTA ou sem acento continua sendo o mesmo tamanho", async () => {
  // ela digita o valor à mão no admin: "PEQUENO", "Pequeno" e "pequeno" são a
  // MESMA coisa. Tratar como diferentes fazia a peça cair fora da grade.
  await env.DB.prepare(
    "INSERT INTO cat_produtos (id,slug,nome,status,preco,criado_em,atualizado_em) VALUES ('caixa','caixa','Caixa','ativo',8900,'x','x')"
  ).run();
  await env.DB.prepare(
    "INSERT INTO cat_variantes (id,produto_id,combinacao,preco,estoque,ativo,ordem) VALUES ('cv1','caixa','{\"TAMANHO\":\"PEQUENO\"}',8900,3,1,0)"
  ).run();
  const r = await recomputaTotal(env, [{ id: "caixa", tam: "P", qtd: 1 }], OPTS);
  expect(r.erro).toBeUndefined();
  expect(r.subtotal).toBe(8900);
});

test("variante que não é de Tamanho (Cor) também se compra", async () => {
  // produto novo, com opção Cor — o caso que a vitrine ignorava em silêncio
  await env.DB.prepare(
    "INSERT INTO cat_produtos (id,slug,nome,status,preco,criado_em,atualizado_em) VALUES ('laco','laco-rosa','Laço','ativo',5000,'x','x')"
  ).run();
  await env.DB.prepare(
    "INSERT INTO cat_variantes (id,produto_id,combinacao,preco,estoque,ativo,ordem) VALUES ('lv1','laco','{\"Cor\":\"Rosa\"}',5000,4,1,0)"
  ).run();
  const r = await recomputaTotal(env, [{ id: "laco", varId: "lv1", qtd: 2 }], OPTS);
  expect(r.erro).toBeUndefined();
  expect(r.subtotal).toBe(10000);
});

// ── estoque: não se vende o que não existe ──────────────────────────────────
test("não vende mais do que tem em estoque", async () => {
  // tablete Médio tem 7
  expect((await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 7 }], OPTS)).erro).toBeUndefined();
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 8 }], OPTS);
  expect(r.erro).toBe("estoque");
  expect(r.disponivel).toBe(7);
});

test("tamanho esgotado não pode ser comprado", async () => {
  // tablete Grande está com 0
  expect((await recomputaTotal(env, [{ id: "tablete", tam: "G", qtd: 1 }], OPTS)).erro).toBe("estoque");
});

test("'continuar vendendo quando esgotar' libera a venda no zero", async () => {
  await env.DB.prepare(
    "UPDATE cat_variantes SET vender_sem_estoque = 1 WHERE produto_id = 'tablete' AND combinacao LIKE '%Grande%'"
  ).run();
  expect((await recomputaTotal(env, [{ id: "tablete", tam: "G", qtd: 3 }], OPTS)).erro).toBeUndefined();
});

test("qtd inválida (0, negativa, fracionária, acima do teto) => erro qtd", async () => {
  for (const q of [0, -2, 1.5, 100, 9999]) {
    expect((await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: q }], { ...OPTS, metodo: "pix" })).erro).toBe("qtd");
  }
  // 99 (o teto por linha) passa na regra de QUANTIDADE — mas agora esbarra no
  // ESTOQUE (tablete M tem 7), que é outro erro, e é o certo.
  expect((await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 99 }], { ...OPTS, metodo: "pix" })).erro).toBe("estoque");
});

test("acima do teto de LINHAS (MAX_ITENS) => erro itens", async () => {
  const muitas = Array.from({ length: 51 }, () => ({ id: "tablete", tam: "M", qtd: 1 }));
  expect((await recomputaTotal(env, muitas, OPTS)).erro).toBe("itens");
});

test("Pix e cupom empilham (aditivo) — regra a confirmar", async () => {
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], { ...OPTS, metodo: "pix", cupom: "PRIMEIRA10" });
  // subtotal 12300; pix 5% = 615; cupom 10% = 1230; desconto = 1845; frete econômico 1290 (região 0)
  expect(r.desconto).toBe(615 + 1230);
  expect(r.frete).toBe(1290);
  expect(r.total).toBe(12300 + 1290 - 1845);
});

// ── frete recomputado no servidor (nunca confia no cliente) ──────────────────
test("frete entra no total mas não no desconto de Pix", async () => {
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], { ...OPTS, metodo: "pix" });
  expect(r.frete).toBe(1290); // econômico, região 0, subtotal < R$150
  expect(r.total).toBe(r.subtotal + r.frete - r.desconto);
});

test("frete grátis (econômico) acima de R$150 de subtotal", async () => {
  // 2× tablete M = R$246 (>150) => econômico grátis
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 2 }], OPTS);
  expect(r.frete).toBe(0);
});

test("Expresso nunca é grátis e custa base + R$16", async () => {
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 2 }], { ...OPTS, freteOpcao: "expresso" });
  expect(r.frete).toBe(2890); // (12,90 + 16) * 100
});

test("CEP inválido com itens a enviar => erro cep", async () => {
  const r = await recomputaTotal(env, [{ id: "tablete", tam: "M", qtd: 1 }], { metodo: "cartao", cep: "123", freteOpcao: "economico" });
  expect(r.erro).toBe("cep");
});

test("freteQuoteCents: região do CEP muda a base; CEP inválido => null", async () => {
  expect(freteQuoteCents("01310100", 1000, "economico")).toBe(1290); // região 0
  expect(freteQuoteCents("80000000", 1000, "economico")).toBe(2570); // região 8: 12,90 + 8×1,60 = 25,70
  expect(freteQuoteCents("01310100", 20000, "economico")).toBe(0);   // grátis acima de R$150
  expect(freteQuoteCents("123", 1000, "economico")).toBe(null);      // CEP inválido
});

test("parcelas respeitam mínimo por parcela e teto", async () => {
  expect(parcelasValidas(30000)).toEqual({ maxParcelas: 6, semJurosAte: 3 });
  expect(parcelasValidas(12000).maxParcelas).toBe(2); // 12000/5000 = 2.4 -> 2
});

test("total abaixo do mínimo por parcela => só à vista (1x)", async () => {
  expect(parcelasValidas(4000).maxParcelas).toBe(1); // R$40 < R$50 mínimo
});
