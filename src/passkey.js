// Passkey (WebAuthn) do Admin — o login forte do dia a dia.
//
// Por que passkey: a chave privada nunca sai do aparelho (fica no Secure Enclave/
// TPM, destravada por Face ID/digital), e a assinatura é amarrada ao DOMÍNIO —
// então um site clonado não consegue reusar o login. É à prova de phishing, ao
// contrário de senha e de código por SMS/e-mail.
//
// A verificação criptográfica (CBOR/COSE, assinatura, flags) é feita pela
// biblioteca @simplewebauthn/server — deliberadamente NÃO escrita à mão: um erro
// sutil de parsing aqui viraria bypass de autenticação.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const DESAFIO_TTL_MS = 5 * 60 * 1000; // 5 min

// O RP ID é o domínio que "dona" a passkey — deriva do host da requisição.
// Consequência esperada: passkey cadastrada na prévia NÃO vale em produção
// (domínios diferentes) — é assim que o WebAuthn impede phishing.
function rp(url) {
  return { rpID: url.hostname, origin: url.origin, rpName: "Studio Suzu · Admin" };
}

async function guardaDesafio(env, usuarioId, desafio, tipo) {
  const agora = new Date();
  await env.DB.prepare(
    "INSERT INTO admin_webauthn_desafios (id, usuario_id, desafio, tipo, criado_em, expira_em) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), usuarioId || null, desafio, tipo, agora.toISOString(), new Date(agora.getTime() + DESAFIO_TTL_MS).toISOString())
    .run();
}

// Consome o desafio (uso único): devolve a linha se ainda for válido, senão null.
async function consomeDesafio(env, desafio, tipo) {
  const row = await env.DB.prepare(
    "SELECT id, usuario_id, expira_em, usado_em FROM admin_webauthn_desafios WHERE desafio = ? AND tipo = ?"
  )
    .bind(desafio, tipo)
    .first();
  if (!row || row.usado_em || new Date(row.expira_em).getTime() < Date.now()) return null;
  await env.DB.prepare("UPDATE admin_webauthn_desafios SET usado_em = ? WHERE id = ? AND usado_em IS NULL")
    .bind(new Date().toISOString(), row.id)
    .run();
  return row;
}

// ── REGISTRO (exige sessão ativa — só quem já entrou cadastra passkey) ───────
export async function registroInicio(env, url, sessao) {
  const { rpID, rpName } = rp(url);
  const jaTem = await env.DB.prepare("SELECT credential_id FROM admin_passkeys WHERE usuario_id = ?")
    .bind(sessao.usuario_id)
    .all();

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: sessao.email,
    userDisplayName: sessao.nome || "Studio Suzu",
    // impede cadastrar a MESMA chave duas vezes no mesmo aparelho
    excludeCredentials: (jaTem.results || []).map((r) => ({ id: r.credential_id })),
    authenticatorSelection: {
      residentKey: "preferred", // passkey descobrível → login sem digitar e-mail
      userVerification: "required", // exige Face ID / digital / PIN (não só presença)
    },
  });
  await guardaDesafio(env, sessao.usuario_id, options.challenge, "registro");
  return options;
}

export async function registroFim(env, url, sessao, resposta) {
  const { rpID, origin } = rp(url);
  const esperado = resposta && resposta.response ? await desafioDaResposta(resposta) : null;
  const linha = esperado ? await consomeDesafio(env, esperado, "registro") : null;
  if (!linha || linha.usuario_id !== sessao.usuario_id) return { ok: false, erro: "desafio" };

  const v = await verifyRegistrationResponse({
    response: resposta,
    expectedChallenge: esperado,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) return { ok: false, erro: "nao_verificado" };

  const cred = v.registrationInfo.credential;
  await env.DB.prepare(
    "INSERT INTO admin_passkeys (id, usuario_id, credential_id, public_key, counter, apelido, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      crypto.randomUUID(),
      sessao.usuario_id,
      cred.id,
      b64url(cred.publicKey),
      cred.counter || 0,
      apelidoDoAgente(resposta.__ua || ""),
      new Date().toISOString()
    )
    .run();
  return { ok: true };
}

// ── LOGIN (sem sessão — é ele que CRIA a sessão) ─────────────────────────────
export async function loginInicio(env, url) {
  const { rpID } = rp(url);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    // sem allowCredentials: passkey descobrível — o aparelho oferece a conta,
    // a pessoa nem digita e-mail.
  });
  await guardaDesafio(env, null, options.challenge, "login");
  return options;
}

// Devolve { ok, usuarioId } — quem chama cria a sessão e registra auditoria.
export async function loginFim(env, url, resposta) {
  const { rpID, origin } = rp(url);
  const esperado = await desafioDaResposta(resposta);
  const linha = esperado ? await consomeDesafio(env, esperado, "login") : null;
  if (!linha) return { ok: false, erro: "desafio" };

  const credId = String((resposta && resposta.id) || "");
  const pk = await env.DB.prepare(
    "SELECT p.id, p.usuario_id, p.credential_id, p.public_key, p.counter, u.ativo " +
      "FROM admin_passkeys p JOIN admin_usuarios u ON u.id = p.usuario_id WHERE p.credential_id = ?"
  )
    .bind(credId)
    .first();
  if (!pk || !pk.ativo) return { ok: false, erro: "credencial" };

  const v = await verifyAuthenticationResponse({
    response: resposta,
    expectedChallenge: esperado,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: pk.credential_id,
      publicKey: deB64url(pk.public_key),
      counter: Number(pk.counter) || 0,
    },
  });
  if (!v.verified) return { ok: false, erro: "nao_verificado" };

  // counter crescente = anti-clonagem do autenticador
  await env.DB.prepare("UPDATE admin_passkeys SET counter = ?, ultimo_uso = ? WHERE id = ?")
    .bind(v.authenticationInfo.newCounter, new Date().toISOString(), pk.id)
    .run();
  return { ok: true, usuarioId: pk.usuario_id };
}

// ── util ────────────────────────────────────────────────────────────────────
// O desafio volta dentro do clientDataJSON (base64url) — lemos de lá pra achar
// a linha guardada. A CONFERÊNCIA de verdade é da biblioteca (expectedChallenge).
async function desafioDaResposta(resposta) {
  try {
    const cdj = resposta && resposta.response && resposta.response.clientDataJSON;
    if (!cdj) return null;
    const txt = new TextDecoder().decode(deB64url(cdj));
    const obj = JSON.parse(txt);
    return obj && obj.challenge ? String(obj.challenge) : null;
  } catch (_) {
    return null;
  }
}

function b64url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deB64url(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Nome amigável do aparelho, só pra a pessoa reconhecer a chave na lista.
function apelidoDoAgente(ua) {
  const s = String(ua);
  if (/iPhone/i.test(s)) return "iPhone";
  if (/iPad/i.test(s)) return "iPad";
  if (/Android/i.test(s)) return "Android";
  if (/Macintosh|Mac OS/i.test(s)) return "Mac";
  if (/Windows/i.test(s)) return "Windows";
  return "Este aparelho";
}
