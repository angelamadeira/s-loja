-- Histórico de endereços do produto.
-- Trocar o nome (ou o slug) no admin muda a URL — e mata todo link que já foi
-- compartilhado no Instagram, no WhatsApp ou indexado no Google. O Shopify
-- resolve isso guardando os endereços antigos e redirecionando. Aqui igual: o
-- endereço velho continua abrindo o produto, e a loja troca a URL da barra pelo
-- endereço atual (sem entrada nova no histórico do navegador).
--
-- Aplicar (staging primeiro, sempre):
--   npx wrangler d1 execute suzu-pedidos --env preview --remote --file=migra-slugs.sql
CREATE TABLE IF NOT EXISTS cat_slugs_antigos (
  slug       TEXT PRIMARY KEY,          -- o endereço que deixou de ser o atual
  produto_id TEXT NOT NULL,
  criado_em  TEXT NOT NULL,
  FOREIGN KEY (produto_id) REFERENCES cat_produtos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cat_slugs_prod ON cat_slugs_antigos (produto_id);
