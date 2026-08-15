-- Fundação de SEGURANÇA do Admin da Loja Suzu (Fase 0).
-- Segurança é a prioridade nº 1 do admin (decisão da fundadora) — por isso o
-- alicerce vem ANTES de qualquer tela: identidade, login forte, sessão e auditoria.
-- Aplicar (staging primeiro, só depois de revisado):
--   npx wrangler d1 execute suzu-pedidos --env preview --file=schema-admin.sql
--
-- Princípios de segurança embutidos aqui:
-- • NUNCA guardar segredo em claro: tokens e sessões guardam só o HASH (SHA-256).
-- • Login forte por PASSKEY (WebAuthn — Face ID/digital, à prova de phishing, sem
--   senha pra vazar); link mágico por e-mail só como RECUPERAÇÃO.
-- • Tokens de uso único, com expiração curta.
-- • Toda ação sensível deixa rastro em admin_auditoria (quem/quando/o quê).

-- ── Quem pode entrar no admin ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_usuarios (
  id         TEXT PRIMARY KEY,            -- uuid
  email      TEXT NOT NULL UNIQUE,        -- também a raiz da recuperação
  nome       TEXT,
  papel      TEXT NOT NULL DEFAULT 'dono',-- dono | (futuro: papéis com menos privilégio)
  ativo      INTEGER NOT NULL DEFAULT 1,  -- 0 = acesso suspenso (sem apagar histórico)
  criado_em  TEXT NOT NULL
);

-- ── Passkeys (WebAuthn) — o login forte do dia a dia ─────────────────────────
CREATE TABLE IF NOT EXISTS admin_passkeys (
  id            TEXT PRIMARY KEY,         -- uuid
  usuario_id    TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,     -- id da credencial WebAuthn (base64url)
  public_key    TEXT NOT NULL,            -- chave pública (COSE, base64) — verificação da assinatura
  counter       INTEGER NOT NULL DEFAULT 0, -- contador anti-clonagem do autenticador
  apelido       TEXT,                     -- "iPhone da Angela", p/ a pessoa reconhecer
  criado_em     TEXT NOT NULL,
  ultimo_uso    TEXT,
  FOREIGN KEY (usuario_id) REFERENCES admin_usuarios(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_admin_passkeys_user ON admin_passkeys (usuario_id);

-- ── Tokens de uso único (link mágico de login/recuperação) ───────────────────
-- Guarda só o HASH do token; o valor real vai no link por e-mail e nunca é
-- persistido. Uso único (usado_em) + expiração curta.
CREATE TABLE IF NOT EXISTS admin_login_tokens (
  id          TEXT PRIMARY KEY,           -- uuid
  usuario_id  TEXT,                       -- a quem pertence (null até resolver o e-mail)
  token_hash  TEXT NOT NULL UNIQUE,       -- SHA-256 do token (nunca o token cru)
  finalidade  TEXT NOT NULL,              -- 'login' | 'recuperacao'
  criado_em   TEXT NOT NULL,
  expira_em   TEXT NOT NULL,              -- curto (ex.: 15 min)
  usado_em    TEXT,                       -- null até ser usado (uso único)
  ip          TEXT,
  FOREIGN KEY (usuario_id) REFERENCES admin_usuarios(id) ON DELETE CASCADE
);

-- ── Sessões ──────────────────────────────────────────────────────────────────
-- O cookie leva um segredo aleatório; aqui guardamos só o HASH dele. Sessão
-- expira e pode ser revogada (logout / "sair de todos os aparelhos").
CREATE TABLE IF NOT EXISTS admin_sessoes (
  id          TEXT PRIMARY KEY,           -- uuid
  usuario_id  TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,       -- SHA-256 do segredo do cookie
  criado_em   TEXT NOT NULL,
  expira_em   TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  revogada    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (usuario_id) REFERENCES admin_usuarios(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_admin_sessoes_user ON admin_sessoes (usuario_id);

-- ── Log de auditoria (a "caixa-preta" do admin) ──────────────────────────────
-- Toda ação sensível: mudança de status/preço, exclusão, exportação de dados,
-- login. Append-only na prática (nunca editar/apagar linha).
CREATE TABLE IF NOT EXISTS admin_auditoria (
  id         TEXT PRIMARY KEY,            -- uuid
  usuario_id TEXT,                        -- quem fez (null p/ tentativas anônimas)
  acao       TEXT NOT NULL,               -- ex.: 'produto.editar', 'pedido.status', 'login.ok', 'login.falha'
  alvo       TEXT,                        -- id do objeto afetado (produto/pedido…)
  detalhe    TEXT,                        -- JSON (ex.: {de:'pago', para:'em_producao'})
  ip         TEXT,
  criado_em  TEXT NOT NULL,
  FOREIGN KEY (usuario_id) REFERENCES admin_usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_criado ON admin_auditoria (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_acao   ON admin_auditoria (acao);

-- Quem pode PEDIR o link de entrada (a lista viva; o código tem só a semente).
-- O e-mail dono (somos.suzu) é irremovível — ninguém se tranca pra fora.
CREATE TABLE IF NOT EXISTS admin_emails_permitidos (
  email          TEXT PRIMARY KEY,   -- minúsculo, já validado
  criado_em      TEXT NOT NULL,
  adicionado_por TEXT                -- e-mail de quem cadastrou (auditoria amigável)
);
