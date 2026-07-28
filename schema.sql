-- Schema do banco de pedidos (Cloudflare D1 / SQLite).
-- Aplicar: wrangler d1 execute suzu-pedidos --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS pedidos (
  id             TEXT PRIMARY KEY,            -- uuid (chave real)
  ref            TEXT NOT NULL,               -- nº amigável, ex. SUZU-A1B2C3
  criado_em      TEXT NOT NULL,               -- ISO 8601 (UTC)
  respondido_em  TEXT,                        -- null até responder (honra o "3 dias úteis")
  nome           TEXT,                        -- opcional
  contato        TEXT NOT NULL,               -- e-mail ou WhatsApp (único obrigatório)
  brief          TEXT,                        -- briefing (opcional)
  anexos         TEXT NOT NULL DEFAULT '[]',  -- JSON: [{key,name,size,type}]
  origem         TEXT,                        -- de onde veio o lead (instagram/google/direto/utm)
  status         TEXT NOT NULL DEFAULT 'novo',-- novo | respondido | orcado | fechado | perdido
  -- prova de consentimento (LGPD — o ônus da prova é da empresa):
  consentiu      INTEGER NOT NULL DEFAULT 0,  -- 1 = consentiu
  consent_versao TEXT,                        -- versão do texto de consentimento aceito
  ip             TEXT                         -- IP no momento do envio
);

CREATE INDEX IF NOT EXISTS idx_pedidos_criado ON pedidos (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos (status);

-- Tabela de vendas (compras/pagamentos) — separada de pedidos (orçamentos)
CREATE TABLE IF NOT EXISTS compras (
  id            TEXT PRIMARY KEY,            -- uuid
  ref           TEXT NOT NULL,               -- SUZU-XXXXXX amigável
  criado_em     TEXT NOT NULL,               -- ISO 8601 UTC
  itens         TEXT NOT NULL,               -- JSON [{id,tam,qtd,preco_unit}]
  subtotal      INTEGER NOT NULL,            -- centavos (fonte: servidor)
  frete         INTEGER NOT NULL DEFAULT 0,  -- centavos (F4a: do frete simulado)
  desconto      INTEGER NOT NULL DEFAULT 0,  -- centavos (Pix/cupom, servidor)
  total         INTEGER NOT NULL,            -- centavos cobrados (servidor)
  metodo        TEXT NOT NULL,               -- pix | cartao
  parcelas      INTEGER NOT NULL DEFAULT 1,
  contato_email TEXT NOT NULL,
  contato_whats TEXT,
  cpf           TEXT,                        -- só dígitos
  endereco      TEXT,                        -- JSON (null p/ pré-venda)
  status        TEXT NOT NULL DEFAULT 'iniciado', -- iniciado|pendente|aprovado|recusado|cancelado
  mp_payment_id TEXT,
  consentiu     INTEGER NOT NULL DEFAULT 0,
  estoque_baixado INTEGER NOT NULL DEFAULT 0, -- 1 = estoque já descontado (trava anti-duplo)
  ip            TEXT
);

CREATE INDEX IF NOT EXISTS idx_compras_criado ON compras (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_compras_status ON compras (status);
CREATE INDEX IF NOT EXISTS idx_compras_mp ON compras (mp_payment_id);
