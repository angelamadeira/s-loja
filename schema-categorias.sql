-- Categorias do catálogo (com ANINHAMENTO) + vínculo com produtos.
-- Aplicar: npx wrangler d1 execute suzu-pedidos --env preview --remote --file=schema-categorias.sql

-- Árvore de categorias: `pai_id` aponta pra categoria mãe (null = raiz).
-- Um nível de aninhamento já cobre "Bombons > Esferas"; a estrutura aceita mais.
CREATE TABLE IF NOT EXISTS cat_categorias (
  id        TEXT PRIMARY KEY,             -- uuid
  nome      TEXT NOT NULL,
  slug      TEXT NOT NULL UNIQUE,         -- /categoria/<slug>
  pai_id    TEXT,                         -- null = categoria raiz
  ordem     INTEGER NOT NULL DEFAULT 0,
  descricao TEXT,
  criado_em TEXT NOT NULL,
  FOREIGN KEY (pai_id) REFERENCES cat_categorias(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cat_categorias_pai ON cat_categorias (pai_id, ordem);

-- Um produto pode estar em VÁRIAS categorias (N:N) — como nas plataformas.
CREATE TABLE IF NOT EXISTS cat_produto_categorias (
  produto_id   TEXT NOT NULL,
  categoria_id TEXT NOT NULL,
  PRIMARY KEY (produto_id, categoria_id),
  FOREIGN KEY (produto_id)   REFERENCES cat_produtos(id) ON DELETE CASCADE,
  FOREIGN KEY (categoria_id) REFERENCES cat_categorias(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cat_pc_categoria ON cat_produto_categorias (categoria_id);

-- Migra as coleções que já existiam no código (campo `coll` do array PRODUCTS).
INSERT OR IGNORE INTO cat_categorias (id, nome, slug, pai_id, ordem, criado_em) VALUES
  ('cat-essenciais',   'Essenciais',    'essenciais',    NULL, 1, '2026-07-28T00:00:00Z'),
  ('cat-bombons',      'Bombons',       'bombons',       NULL, 2, '2026-07-28T00:00:00Z'),
  ('cat-bento-festa',  'Bento & Festa', 'bento-e-festa', NULL, 3, '2026-07-28T00:00:00Z');

INSERT OR IGNORE INTO cat_produto_categorias (produto_id, categoria_id) VALUES
  ('tablete', 'cat-essenciais'),
  ('macaron', 'cat-essenciais'),
  ('coracao', 'cat-bombons'),
  ('concha',  'cat-bombons'),
  ('esfera',  'cat-bombons'),
  ('cubo',    'cat-bento-festa');
