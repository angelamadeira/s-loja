-- Lacunas vs a página de produto do Shopify — colunas que faltavam.
-- Aplicar (staging primeiro, sempre):
--   npx wrangler d1 execute suzu-pedidos --env preview --file=migra-lacunas.sql
--   npx wrangler d1 execute suzu-pedidos            --file=migra-lacunas.sql
--
-- `seo` (JSON {titulo, descricao}) já existe em cat_produtos desde o schema
-- inicial — só não estava sendo usado; não precisa de ALTER.

-- Tags: organização livre, paralela às categorias (Shopify tem os dois).
-- JSON de strings: ["natal","presente"].
ALTER TABLE cat_produtos ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

-- Código de barras da variante (GTIN/EAN/UPC) — irmão do `sku`, que já existe.
ALTER TABLE cat_variantes ADD COLUMN gtin TEXT;

-- "Continuar vendendo quando esgotar" (vender no negativo). Padrão 0 = a loja
-- para de vender ao zerar o estoque, que é o comportamento seguro pra encomenda
-- artesanal (não promete o que não tem).
ALTER TABLE cat_variantes ADD COLUMN vender_sem_estoque INTEGER NOT NULL DEFAULT 0;
