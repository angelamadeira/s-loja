-- Schema do banco de pedidos (Cloudflare D1 / SQLite).
-- Aplicar: wrangler d1 execute suzu-pedidos --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS pedidos (
  id         TEXT PRIMARY KEY,        -- uuid do pedido
  criado_em  TEXT NOT NULL,           -- ISO 8601 (UTC)
  nome       TEXT,                    -- opcional
  contato    TEXT NOT NULL,           -- e-mail ou WhatsApp (único obrigatório)
  brief      TEXT,                    -- briefing (opcional)
  anexos     TEXT NOT NULL DEFAULT '[]', -- JSON: [{key,name,size,type}]
  status     TEXT NOT NULL DEFAULT 'novo' -- novo | respondido | arquivado
);

CREATE INDEX IF NOT EXISTS idx_pedidos_criado ON pedidos (criado_em DESC);
