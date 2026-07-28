-- Desafios WebAuthn (passkey) — Admin, Fase 0 incremento 2.
-- O desafio é gerado pelo servidor e precisa ser guardado pra ser conferido na
-- volta (é o que impede replay). Uso único e vida curta (5 min).
-- Aplicar: npx wrangler d1 execute suzu-pedidos --env preview --remote --file=schema-admin-passkey.sql
CREATE TABLE IF NOT EXISTS admin_webauthn_desafios (
  id         TEXT PRIMARY KEY,            -- uuid
  usuario_id TEXT,                        -- null no login sem e-mail (passkey descobrível)
  desafio    TEXT NOT NULL,               -- challenge (base64url) gerado pelo servidor
  tipo       TEXT NOT NULL,               -- 'registro' | 'login'
  criado_em  TEXT NOT NULL,
  expira_em  TEXT NOT NULL,               -- curto (5 min)
  usado_em   TEXT,                        -- uso único
  FOREIGN KEY (usuario_id) REFERENCES admin_usuarios(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wa_desafio ON admin_webauthn_desafios (desafio);
