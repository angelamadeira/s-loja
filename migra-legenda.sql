-- "Legenda curta" do produto: a linha miúda acima do nome no card da vitrine
-- ("Tablete · 12 gomos", "Bombom · mini"). Era copy cravada no index.html; passa
-- a ser campo do produto, editável no admin.
--
-- Aplicar (staging primeiro, sempre):
--   npx wrangler d1 execute suzu-pedidos --env preview --remote --file=migra-legenda.sql
ALTER TABLE cat_produtos ADD COLUMN legenda TEXT;

-- Preenche com o que a loja JÁ mostra hoje, pra nada mudar de aparência e o
-- campo não aparecer vazio no admin (o que faria parecer que a loja inventou o texto).
UPDATE cat_produtos SET legenda = 'Tablete · 12 gomos' WHERE id = 'tablete'  AND legenda IS NULL;
UPDATE cat_produtos SET legenda = 'Bombom · coração'   WHERE id = 'coracao'  AND legenda IS NULL;
UPDATE cat_produtos SET legenda = 'Bombom · mini'      WHERE id = 'concha'   AND legenda IS NULL;
UPDATE cat_produtos SET legenda = 'Pão de mel · cubo'  WHERE id = 'cubo'     AND legenda IS NULL;
UPDATE cat_produtos SET legenda = 'Bombom · esfera'    WHERE id = 'esfera'   AND legenda IS NULL;
UPDATE cat_produtos SET legenda = 'Macaron'            WHERE id = 'macaron'  AND legenda IS NULL;
