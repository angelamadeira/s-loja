-- Baixa de estoque na venda.
-- Marca, NA COMPRA, se o estoque dela já foi descontado. É o que impede descontar
-- duas vezes: o webhook do Mercado Pago pode chegar várias vezes para o mesmo
-- pagamento (é reenviado até receber 200), e sem esta trava cada reenvio comeria
-- estoque de novo — a loja diria "esgotado" com peça na prateleira.
--
-- Aplicar (staging primeiro, sempre):
--   npx wrangler d1 execute suzu-pedidos --env preview --remote --file=migra-estoque.sql
-- (definição canônica: schema.sql)
ALTER TABLE compras ADD COLUMN estoque_baixado INTEGER NOT NULL DEFAULT 0;
