-- Catálogo editável da Loja Suzu (Admin — Fase 1).
-- Move o catálogo do CÓDIGO (array PRODUCTS/SIZES no index.html) para o D1, pra
-- a fundadora editar produtos pelo admin e o site renderizar a partir do banco.
-- Aplicar (só depois de revisado, staging primeiro):
--   npx wrangler d1 execute suzu-pedidos --env preview --file=schema-catalogo.sql
--
-- Convenções:
-- • Preços em CENTAVOS (inteiro), como no resto do sistema (ver src/precos.js).
-- • status do produto = o "rascunho/publicado": o site público só mostra 'ativo'.
-- • TODO produto tem ≥1 variante (peça única = 1 variante com combinacao '{}').
--   Estoque, peso e dimensões vivem SEMPRE na variante (é o que muda a cotação/etiqueta).

-- ── Biblioteca de mídia — IMAGEM ou VÍDEO (arquivos no R2; aqui só os metadados) ─
-- Toda "mídia" do site (capa/thumb, galeria, imagem de variante) pode ser imagem
-- OU vídeo — o `tipo` (mime) diz qual, e o front escolhe o render (<img> vs
-- <video muted loop autoplay playsinline>, igual ao reel que a loja já tem).
CREATE TABLE IF NOT EXISTS assets (
  id           TEXT PRIMARY KEY,          -- uuid
  r2_key       TEXT NOT NULL,             -- caminho no bucket R2
  nome         TEXT,                      -- nome original do arquivo
  tipo         TEXT NOT NULL,             -- mime: image/* OU video/* (define imagem vs vídeo)
  largura      INTEGER,                   -- px (validação de proporção)
  altura       INTEGER,                   -- px
  bytes        INTEGER,                   -- tamanho
  poster_asset TEXT,                      -- só p/ VÍDEO: still/capa mostrada no thumb antes de tocar (FK assets.id)
  duracao_ms   INTEGER,                   -- só p/ vídeo (opcional)
  criado_em    TEXT NOT NULL,
  FOREIGN KEY (poster_asset) REFERENCES assets(id)
);

-- ── Produtos ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cat_produtos (
  id           TEXT PRIMARY KEY,          -- uuid
  slug         TEXT NOT NULL UNIQUE,      -- URL amigável (/p/<slug>); derivado do nome
  nome         TEXT NOT NULL,
  descricao    TEXT,                      -- texto/blocos (rich text controlado)
  status       TEXT NOT NULL DEFAULT 'rascunho', -- rascunho | ativo | arquivado (site só mostra 'ativo')
  destaque     INTEGER NOT NULL DEFAULT 0,-- 1 = destacado na vitrine
  ordem        INTEGER NOT NULL DEFAULT 0,-- ordenação manual na vitrine
  preco        INTEGER NOT NULL,          -- centavos — preço-base (a variante pode sobrescrever)
  preco_promo  INTEGER,                   -- centavos — "de/por" base (null = sem promoção)
  capa_asset   TEXT,                      -- imagem de capa (FK assets.id)
  seo          TEXT,                      -- JSON opcional {titulo, descricao} — controles críticos ficam no template
  criado_em    TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  FOREIGN KEY (capa_asset) REFERENCES assets(id)
);
CREATE INDEX IF NOT EXISTS idx_cat_prod_status ON cat_produtos (status);
CREATE INDEX IF NOT EXISTS idx_cat_prod_ordem  ON cat_produtos (ordem);

-- Galeria (várias imagens por produto, ordenável)
CREATE TABLE IF NOT EXISTS cat_produto_imagens (
  produto_id TEXT NOT NULL,
  asset_id   TEXT NOT NULL,
  ordem      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (produto_id, asset_id),
  FOREIGN KEY (produto_id) REFERENCES cat_produtos(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id)   REFERENCES assets(id)
);

-- ── Variação GENÉRICA (controle total — não presa a "Tamanho") ───────────────
-- Cada produto define 0, 1 ou 2 tipos de opção (nome livre: Cor, Tamanho, Sabor…),
-- cada tipo com sua lista de valores. As combinações viram linhas em cat_variantes.
CREATE TABLE IF NOT EXISTS cat_opcoes (
  id         TEXT PRIMARY KEY,            -- uuid
  produto_id TEXT NOT NULL,
  nome       TEXT NOT NULL,               -- ex.: "Cor", "Tamanho", "Sabor"
  ordem      INTEGER NOT NULL DEFAULT 0,
  valores    TEXT NOT NULL DEFAULT '[]',  -- JSON: ["Rosa","Azul","Verde"]
  FOREIGN KEY (produto_id) REFERENCES cat_produtos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cat_opcoes_prod ON cat_opcoes (produto_id);

-- ── Variantes (a combinação real que se vende) ───────────────────────────────
CREATE TABLE IF NOT EXISTS cat_variantes (
  id          TEXT PRIMARY KEY,           -- uuid
  produto_id  TEXT NOT NULL,
  combinacao  TEXT NOT NULL DEFAULT '{}', -- JSON: {"Cor":"Rosa","Tamanho":"M"} (vazio p/ peça única)
  sku         TEXT,                       -- código interno (opcional)
  preco       INTEGER,                    -- centavos (null = herda cat_produtos.preco)
  preco_promo INTEGER,                    -- centavos (null = herda / sem promoção)
  estoque     INTEGER NOT NULL DEFAULT 0, -- contagem; baixa no PAGAMENTO confirmado
  -- Frete/envio (por variante — é o que muda a cotação e a etiqueta do Melhor Envio):
  peso_g      INTEGER NOT NULL DEFAULT 0, -- gramas
  comp_cm     REAL NOT NULL DEFAULT 0,    -- comprimento da embalagem (cm)
  larg_cm     REAL NOT NULL DEFAULT 0,    -- largura (cm)
  alt_cm      REAL NOT NULL DEFAULT 0,    -- altura (cm)
  imagem_asset TEXT,                      -- imagem própria da variante (opcional)
  ativo       INTEGER NOT NULL DEFAULT 1,
  ordem       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (produto_id)   REFERENCES cat_produtos(id) ON DELETE CASCADE,
  FOREIGN KEY (imagem_asset) REFERENCES assets(id)
);
CREATE INDEX IF NOT EXISTS idx_cat_var_prod ON cat_variantes (produto_id);

-- ── Config da loja (singleton — 1 linha) ─────────────────────────────────────
-- Guarda o que é "config global": origem do frete, remetente da etiqueta (= também
-- os dados legais do rodapé), limiar de "últimas unidades", frete grátis, contato.
CREATE TABLE IF NOT EXISTS cat_config (
  id            TEXT PRIMARY KEY,         -- fixo: 'loja'
  data          TEXT NOT NULL DEFAULT '{}', -- JSON (ver abaixo)
  atualizado_em TEXT NOT NULL
);
-- data (JSON) esperado, ex.:
-- {
--   "cep_origem": "01310100",
--   "remetente": { "nome": "...", "cnpj": "...", "endereco": {...}, "telefone": "..." },
--   "frete_gratis_min_cents": 15000,
--   "limiar_ultimas_unidades": 3,
--   "contato": { "email": "contato@studiosuzu.com.br", "whatsapp": "5511977167137" }
-- }
