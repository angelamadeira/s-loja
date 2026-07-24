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
