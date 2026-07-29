-- Medida da peça, POR VARIANTE ("≈ 3 cm").
-- Era texto cravado no index.html, igual para a loja inteira — o que é falso: um
-- "Médio" de Tablete não tem a mesma medida de um "Médio" de Bombom Concha.
--
-- NÃO confundir com peso_g/comp_cm/larg_cm/alt_cm, que já existem na variante:
-- aqueles são a EMBALAGEM (para cotar frete e imprimir etiqueta). Este é o
-- tamanho da PEÇA, que a cliente lê na hora de escolher.
--
-- Aplicar (staging primeiro, sempre):
--   npx wrangler d1 execute suzu-pedidos --env preview --remote --file=migra-medida.sql
ALTER TABLE cat_variantes ADD COLUMN medida TEXT;

-- Preenche com o que a loja JÁ mostra, para nada mudar de aparência.
-- LIKE em texto com acento é sensível a caixa no SQLite, daí as variações.
UPDATE cat_variantes SET medida = '≈ 3 cm'
  WHERE medida IS NULL AND (combinacao LIKE '%Pequeno%' OR combinacao LIKE '%PEQUENO%' OR combinacao LIKE '%pequeno%');
UPDATE cat_variantes SET medida = '≈ 7 cm'
  WHERE medida IS NULL AND (combinacao LIKE '%Médio%' OR combinacao LIKE '%MÉDIO%' OR combinacao LIKE '%médio%' OR combinacao LIKE '%Medio%');
UPDATE cat_variantes SET medida = '≈ 12 cm'
  WHERE medida IS NULL AND (combinacao LIKE '%Grande%' OR combinacao LIKE '%GRANDE%' OR combinacao LIKE '%grande%');
