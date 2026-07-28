// Admin da Loja Suzu — SEGURANÇA em primeiro lugar.
//
// Incremento 1 (este arquivo): login por LINK MÁGICO (e-mail) + sessão + trava
// do /admin + log de auditoria. O passkey (WebAuthn) entra por cima depois, e o
// próprio link mágico é o caminho de recuperação e de cadastro do 1º passkey.
//
// Princípios: nunca guardar segredo em claro (só o hash SHA-256); token de uso
// único e curto; cookie HttpOnly/Secure/SameSite; não vazar quais e-mails são
// válidos; toda ação sensível vira linha em admin_auditoria.
import { EmailMessage } from "cloudflare:email";
import { registroInicio, registroFim, loginInicio, loginFim } from "./passkey.js";
import { listaProdutos, leProduto, salvaProduto, apagaProduto, listaCategorias, salvaCategoria, apagaCategoria, subirMidia } from "./catalogo.js";

// Quem pode entrar. Dono = somos.suzu; angelmadeira = recuperação. Ambos
// autenticam na MESMA conta dona. (Entrega do link p/ angelmadeira depende de
// verificar o endereço no Cloudflare Email Routing — ver AVISO em enviaLink.)
const ADMIN_EMAILS = ["somos.suzu@gmail.com", "angelmadeira@gmail.com"];
const DONO_EMAIL = "somos.suzu@gmail.com";

const TOKEN_TTL_MS = 15 * 60 * 1000; // link mágico: 15 min
const SESSAO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // sessão: 7 dias
const COOKIE = "suzu_admin";

// Cache-busting dos assets do admin.
// ATENÇÃO: Date.now() no ESCOPO DE MÓDULO de um Worker devolve 0 (o runtime
// congela o relógio até haver I/O) — daria um "?v=0" eterno, PIOR que não ter.
// Por isso é função: chamada durante a requisição, aí o relógio é real.
// O admin é de uma pessoa só, então revalidar sempre custa nada e garante que
// ela nunca veja CSS/JS velho (já a confundiu três vezes).
function assetsV() {
  // NÃO usar Date.now(): num Worker o relógio fica congelado em 0 até haver I/O
  // (a tela de login não consulta nada), o que daria "?v=0" eterno — pior que
  // não ter. Um id aleatório por requisição garante CSS/JS sempre frescos.
  // O admin é de uma pessoa só: baixar ~20 KB por visita é irrelevante perto de
  // ela ver a versão errada da tela (o que já aconteceu três vezes).
  return crypto.randomUUID().slice(0, 8);
}

// ── roteador do admin ────────────────────────────────────────────────────────
export async function handleAdmin(request, env, url) {
  const p = url.pathname;
  const m = request.method;

  // Endpoints ABERTOS (antes da trava): pedir link, validar link e LOGIN por passkey.
  if (p === "/api/admin/login-link" && m === "POST") return pedirLink(request, env, url);
  if (p === "/admin/entrar" && m === "GET") return validarLink(request, env, url);
  if (p === "/api/admin/passkey/login-inicio" && m === "POST") {
    try {
      return json({ ok: true, options: await loginInicio(env, url) });
    } catch (e) {
      console.error("passkey login-inicio", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/passkey/login-fim" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const r = await loginFim(env, url, await request.json());
      if (!r.ok) {
        await auditoria(env, null, "login.falha", null, { via: "passkey", erro: r.erro }, ip);
        return json({ ok: false, erro: r.erro }, 401);
      }
      const { cookie } = await criaSessao(env, r.usuarioId, request);
      await auditoria(env, r.usuarioId, "login.ok", null, { via: "passkey" }, ip);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "Set-Cookie": cookie },
      });
    } catch (e) {
      console.error("passkey login-fim", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }

  // Daqui pra baixo, tudo exige sessão válida.
  const sessao = await sessaoAtual(request, env);
  if (!sessao) {
    // Página do admin sem sessão → tela de login. API sem sessão → 401.
    if (p.startsWith("/api/")) return json({ ok: false, erro: "nao_autenticado" }, 401);
    return html(paginaLogin());
  }

  if (p === "/api/admin/logout" && m === "POST") return logout(request, env, sessao);

  // Cadastro de passkey — só com sessão ativa (quem já provou ser dona).
  if (p === "/api/admin/passkey/registrar-inicio" && m === "POST") {
    try {
      return json({ ok: true, options: await registroInicio(env, url, sessao) });
    } catch (e) {
      console.error("passkey registrar-inicio", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/passkey/registrar-fim" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const body = await request.json();
      body.__ua = request.headers.get("User-Agent") || "";
      const r = await registroFim(env, url, sessao, body);
      await auditoria(env, sessao.usuario_id, r.ok ? "passkey.cadastrada" : "passkey.falha", null, r.ok ? null : { erro: r.erro }, ip);
      return json(r, r.ok ? 200 : 400);
    } catch (e) {
      console.error("passkey registrar-fim", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/passkey/lista" && m === "GET") {
    const r = await env.DB.prepare("SELECT id, apelido, criado_em, ultimo_uso FROM admin_passkeys WHERE usuario_id = ? ORDER BY criado_em DESC")
      .bind(sessao.usuario_id)
      .all();
    return json({ ok: true, passkeys: r.results || [] });
  }
  if (p === "/api/admin/passkey/remover" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const { id } = await request.json();
      await env.DB.prepare("DELETE FROM admin_passkeys WHERE id = ? AND usuario_id = ?").bind(String(id), sessao.usuario_id).run();
      await auditoria(env, sessao.usuario_id, "passkey.removida", String(id), null, ip);
      return json({ ok: true });
    } catch (_) {
      return json({ ok: false, erro: "servidor" }, 400);
    }
  }

  // ── catálogo (produtos) ──────────────────────────────────────────────────
  if (p === "/api/admin/produtos" && m === "GET") {
    return json({ ok: true, produtos: await listaProdutos(env) });
  }
  if (p === "/api/admin/produto" && m === "GET") {
    const prod = await leProduto(env, url.searchParams.get("id"));
    return prod ? json({ ok: true, produto: prod }) : json({ ok: false, erro: "nao_encontrado" }, 404);
  }
  if (p === "/api/admin/produto" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const body = await request.json();
      const r = await salvaProduto(env, body);
      if (r.ok) await auditoria(env, sessao.usuario_id, "produto.salvo", r.id, { nome: body.nome }, ip);
      return json(r, r.ok ? 200 : 400);
    } catch (e) {
      console.error("produto.salvar", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/produto/arquivar" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const { id } = await request.json();
    const r = await apagaProduto(env, id);
    if (r.ok) await auditoria(env, sessao.usuario_id, "produto.arquivado", String(id), null, ip);
    return json(r, r.ok ? 200 : 400);
  }
  if (p === "/api/admin/categorias" && m === "GET") {
    return json({ ok: true, categorias: await listaCategorias(env) });
  }
  if (p === "/api/admin/categoria" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const r = await salvaCategoria(env, await request.json());
    if (r.ok) await auditoria(env, sessao.usuario_id, "categoria.salva", r.id, null, ip);
    return json(r, r.ok ? 200 : 400);
  }
  if (p === "/api/admin/categoria/apagar" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const { id } = await request.json();
    const r = await apagaCategoria(env, id);
    if (r.ok) await auditoria(env, sessao.usuario_id, "categoria.apagada", String(id), null, ip);
    return json(r, r.ok ? 200 : 400);
  }
  if (p === "/api/admin/midia" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const r = await subirMidia(env, request);
      if (r.ok) await auditoria(env, sessao.usuario_id, "midia.enviada", r.id, { tipo: r.tipo }, ip);
      return json(r, r.ok ? 200 : 400);
    } catch (e) {
      console.error("midia", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/admin/categorias") return html(paginaCategorias());
  if (p === "/admin/produtos") return html(paginaProdutos());
  if (p === "/admin/produto") return html(paginaProduto());

  if (p === "/admin" || p === "/admin/") return html(paginaAdmin(sessao));

  // Rota de admin desconhecida (já autenticada)
  if (p.startsWith("/api/")) return json({ ok: false, erro: "nao_encontrado" }, 404);
  return html(paginaAdmin(sessao));
}

// ── login: pedir o link mágico ───────────────────────────────────────────────
async function pedirLink(request, env, url) {
  let email = "";
  try {
    const body = await request.json();
    email = String((body && body.email) || "").trim().toLowerCase();
  } catch (_) {
    /* corpo inválido cai no "resposta genérica" abaixo */
  }
  const ip = request.headers.get("CF-Connecting-IP") || "";

  // Só manda link se o e-mail for autorizado — MAS responde sempre igual, pra
  // não revelar quais e-mails existem (anti-enumeração).
  if (ADMIN_EMAILS.includes(email)) {
    try {
      const usuario = await garanteDono(env);
      const tokenCru = tokenAleatorio();
      const tokenHash = await sha256hex(tokenCru);
      const agora = new Date();
      await env.DB.prepare(
        "INSERT INTO admin_login_tokens (id, usuario_id, token_hash, finalidade, criado_em, expira_em, ip) VALUES (?, ?, ?, 'login', ?, ?, ?)"
      )
        .bind(crypto.randomUUID(), usuario.id, tokenHash, agora.toISOString(), new Date(agora.getTime() + TOKEN_TTL_MS).toISOString(), ip)
        .run();
      const link = url.origin + "/admin/entrar?token=" + encodeURIComponent(tokenCru);
      await enviaLink(env, email, link);
      await auditoria(env, usuario.id, "login.link_enviado", null, { email }, ip);
    } catch (e) {
      console.error("pedirLink falhou", e);
      // continua na resposta genérica — não expõe o erro
    }
  }
  return json({ ok: true, msg: "Se este e-mail tiver acesso, enviamos um link de entrada." });
}

// ── login: validar o link e abrir sessão ─────────────────────────────────────
async function validarLink(request, env, url) {
  const tokenCru = String(url.searchParams.get("token") || "");
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!tokenCru) return html(paginaLogin("Link inválido. Peça um novo."));

  const tokenHash = await sha256hex(tokenCru);
  const row = await env.DB.prepare(
    "SELECT id, usuario_id, expira_em, usado_em FROM admin_login_tokens WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  const invalido = !row || row.usado_em || new Date(row.expira_em).getTime() < Date.now();
  if (invalido) {
    await auditoria(env, row ? row.usuario_id : null, "login.falha", null, { motivo: "token_invalido" }, ip);
    return html(paginaLogin("Este link expirou ou já foi usado. Peça um novo."));
  }

  // uso único: marca usado ANTES de criar a sessão
  await env.DB.prepare("UPDATE admin_login_tokens SET usado_em = ? WHERE id = ? AND usado_em IS NULL")
    .bind(new Date().toISOString(), row.id)
    .run();

  const { cookie } = await criaSessao(env, row.usuario_id, request);
  await auditoria(env, row.usuario_id, "login.ok", null, null, ip);

  // redireciona pro /admin já com o cookie
  return new Response(null, {
    status: 303,
    headers: { Location: "/admin", "Set-Cookie": cookie },
  });
}

async function logout(request, env, sessao) {
  await env.DB.prepare("UPDATE admin_sessoes SET revogada = 1 WHERE id = ?").bind(sessao.sessao_id).run();
  await auditoria(env, sessao.usuario_id, "logout", null, null, request.headers.get("CF-Connecting-IP") || "");
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Set-Cookie": COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    },
  });
}

// ── sessão ───────────────────────────────────────────────────────────────────
async function criaSessao(env, usuarioId, request) {
  const segredo = tokenAleatorio();
  const hash = await sha256hex(segredo);
  const agora = new Date();
  await env.DB.prepare(
    "INSERT INTO admin_sessoes (id, usuario_id, token_hash, criado_em, expira_em, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      crypto.randomUUID(),
      usuarioId,
      hash,
      agora.toISOString(),
      new Date(agora.getTime() + SESSAO_TTL_MS).toISOString(),
      request.headers.get("CF-Connecting-IP") || "",
      (request.headers.get("User-Agent") || "").slice(0, 300)
    )
    .run();
  const maxAge = Math.floor(SESSAO_TTL_MS / 1000);
  const cookie = COOKIE + "=" + segredo + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + maxAge;
  return { cookie };
}

async function sessaoAtual(request, env) {
  const segredo = leCookie(request, COOKIE);
  if (!segredo) return null;
  const hash = await sha256hex(segredo);
  const row = await env.DB.prepare(
    "SELECT s.id AS sessao_id, s.usuario_id, s.expira_em, s.revogada, u.email, u.nome, u.ativo " +
      "FROM admin_sessoes s JOIN admin_usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?"
  )
    .bind(hash)
    .first();
  if (!row || row.revogada || !row.ativo || new Date(row.expira_em).getTime() < Date.now()) return null;
  return row;
}

// ── util ─────────────────────────────────────────────────────────────────────
async function garanteDono(env) {
  const achou = await env.DB.prepare("SELECT id, email FROM admin_usuarios WHERE email = ?").bind(DONO_EMAIL).first();
  if (achou) return achou;
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO admin_usuarios (id, email, nome, papel, ativo, criado_em) VALUES (?, ?, 'Studio Suzu', 'dono', 1, ?)")
    .bind(id, DONO_EMAIL, new Date().toISOString())
    .run();
  return { id, email: DONO_EMAIL };
}

async function auditoria(env, usuarioId, acao, alvo, detalhe, ip) {
  try {
    await env.DB.prepare(
      "INSERT INTO admin_auditoria (id, usuario_id, acao, alvo, detalhe, ip, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(crypto.randomUUID(), usuarioId || null, acao, alvo || null, detalhe ? JSON.stringify(detalhe) : null, ip || null, new Date().toISOString())
      .run();
  } catch (e) {
    console.error("auditoria falhou", e);
  }
}

function tokenAleatorio() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function leCookie(request, nome) {
  const raw = request.headers.get("Cookie") || "";
  const par = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith(nome + "="));
  return par ? decodeURIComponent(par.slice(nome.length + 1)) : "";
}

async function enviaLink(env, email, link) {
  // AVISO: o binding cloudflare:email só entrega no destino VERIFICADO
  // (somos.suzu@gmail). Pra o link chegar em angelmadeira@gmail, esse endereço
  // precisa ser verificado no Cloudflare Email Routing (ação da fundadora) — ou
  // trocar por um serviço de e-mail real (Resend/SendGrid) quando houver volume.
  const linhas = [
    "Seu link de entrada no Admin do Studio Suzu 🌸",
    "",
    "Clique para entrar (vale por 15 minutos, uso único):",
    link,
    "",
    "Se você não pediu isso, ignore este e-mail.",
  ].join("\n");
  const subject = "Entrar no Admin — Studio Suzu";
  const raw = [
    "From: " + env.AVISO_FROM,
    "To: " + email,
    "Subject: =?UTF-8?B?" + b64(subject) + "?=",
    "Message-ID: <" + crypto.randomUUID() + "@studiosuzu.com.br>",
    "Date: " + new Date().toUTCString(),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    dobra(b64(linhas), 76),
  ].join("\r\n");
  await env.EMAIL.send(new EmailMessage(env.AVISO_FROM, email, raw));
}

function b64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function dobra(s, n) {
  const partes = [];
  for (let i = 0; i < s.length; i += n) partes.push(s.slice(i, i + n));
  return partes.join("\r\n");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", "X-Robots-Tag": "noindex" },
  });
}
function html(markup) {
  return new Response(markup, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

// ── páginas ──────────────────────────────────────────────────────────────────
// 100% design system: nenhum estilo inline aqui — tudo em css/admin.css com
// var(--token). O topo espelha o header do site (.brand/.seal/.word) e usa o
// SELO REAL (/suzu-seal.svg, o mesmo símbolo do index.html) via <use>, herdando
// a cor por currentColor. Botão primário = a classe .btn da loja.
function base(inner, titulo) {
  return (
    "<!doctype html><html lang=pt-br><head><meta charset=utf-8>" +
    "<meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<meta name=robots content=noindex>" +
    "<title>" + titulo + " · Admin Suzu</title>" +
    "<link rel=stylesheet href=/css/tokens.css>" +
    "<link rel=stylesheet href=/css/components.css>" +
    "<link rel=stylesheet href='/css/admin.css?v=" + assetsV() + "'>" +
    "</head><body class=abody>" +
    "<header class=ahd><div class=ahd-in>" +
      "<a class=brand href=/admin aria-label='Admin — Studio Suzu'>" +
        "<svg class=seal viewBox='0 0 633 633' aria-hidden=true><use href='/suzu-seal.svg#suzu-seal'/></svg>" +
        "<span class=word><span>Studio Suzu</span><b>formas autorais</b></span>" +
      "</a>" +
      "<span class=tag>Admin</span>" +
    "</div></header>" +
    inner +
    "<div class=afoot>Área restrita · acesso registrado</div>" +
    "</body></html>"
  );
}

function paginaLogin(msg) {
  return base(
    "<div class=awrap><div class=acard>" +
      "<h1>Entrar no Admin</h1>" +
      "<p>Use a sua passkey — o desbloqueio do próprio aparelho. Ou receba um link por e-mail.</p>" +
      (msg ? "<div class='amsg err'>" + escapar(msg) + "</div>" : "") +
      "<button id=pk class='btn abtn-full' hidden>Entrar com Face ID ou digital</button>" +
      "<div class=asep id=sep hidden><span>ou</span></div>" +
      "<form id=f>" +
        "<label class=afield><span>E-mail</span>" +
        "<input id=e type=email autocomplete=email inputmode=email placeholder='voce@exemplo.com' required></label>" +
        "<button type=submit id=b class='btn ghost abtn-full'>Enviar link de entrada</button>" +
      "</form>" +
      "<div class=amsg id=ok hidden></div>" +
      "<script src='/js/admin-passkey.js?v=" + assetsV() + "'></script>" +
      "<script>" +
      "var f=document.getElementById('f'),pk=document.getElementById('pk'),sep=document.getElementById('sep'),ok=document.getElementById('ok');" +
      "if(window.SuzuPasskey&&SuzuPasskey.suportado()){pk.hidden=false;sep.hidden=false;}" +
      "pk.addEventListener('click',function(){pk.disabled=true;pk.textContent='Confirmando…';SuzuPasskey.entrar().then(function(){location.href='/admin';}).catch(function(err){pk.disabled=false;pk.textContent='Entrar com Face ID ou digital';ok.hidden=false;ok.className='amsg err';ok.textContent=(String(err.message)==='cancelado')?'Entrada cancelada.':'Não deu para entrar com a passkey. Use o link por e-mail.';});});" +
      "f.addEventListener('submit',function(ev){ev.preventDefault();var b=document.getElementById('b');b.disabled=true;b.textContent='Enviando…';fetch('/api/admin/login-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('e').value})}).then(function(r){return r.json();}).then(function(d){ok.hidden=false;ok.className='amsg';ok.textContent=d.msg||'Pronto — confira o seu e-mail.';f.style.display='none';if(pk)pk.hidden=true;if(sep)sep.hidden=true;}).catch(function(){b.disabled=false;b.textContent='Enviar link de entrada';});});" +
      "</script>" +
      "</div></div>",
    "Entrar"
  );
}

function paginaAdmin(sessao) {
  return base(
    "<div class=awrap><div class=acard>" +
      "<h1>Você está no Admin</h1>" +
      "<p>Sessão segura ativa como <b>" + escapar(sessao.email) + "</b>.</p>" +
      "<section class=asec>" +
        "<h2 class=asec-title>Gerenciar</h2>" +
        "<nav class=anav>" +
          "<a href='/admin/produtos'>Produtos<span>catálogo, preços, estoque</span></a>" +
          "<a href='/admin/categorias'>Categorias<span>organizar a vitrine</span></a>" +
        "</nav>" +
      "</section>" +
      "<section class=asec id=pkbox>" +
        "<h2 class=asec-title>Entrada por passkey</h2>" +
        "<div id=pklista class=apk-lista></div>" +
        "<button id=pkadd class='btn abtn-full'>Cadastrar este aparelho</button>" +
        "<p class=apk-nota>Vale para este endereço. Quando o admin for para o domínio final, cadastre novamente por lá.</p>" +
      "</section>" +
      "<div class=amsg id=msg hidden></div>" +
      "<section class=asec>" +
        "<button id=sair class='btn ghost abtn-full'>Sair</button>" +
      "</section>" +
      "<script src='/js/admin-passkey.js?v=" + assetsV() + "'></script>" +
      "<script>" +
      "var msg=document.getElementById('msg'),lista=document.getElementById('pklista'),add=document.getElementById('pkadd');" +
      "function aviso(t,erro){msg.hidden=false;msg.className=erro?'amsg err':'amsg';msg.textContent=t;}" +
      // monta a lista com DOM (textContent), nunca innerHTML — dado do banco não vira HTML
      "function carrega(){fetch('/api/admin/passkey/lista').then(function(r){return r.json();}).then(function(d){var ps=(d&&d.passkeys)||[];lista.textContent='';if(!ps.length){var v=document.createElement('div');v.className='apk-vazio';v.textContent='Nenhum aparelho cadastrado ainda.';lista.appendChild(v);return;}ps.forEach(function(p){var it=document.createElement('div');it.className='apk-item';var n=document.createElement('span');n.textContent=p.apelido||'Aparelho';var rm=document.createElement('button');rm.className='apk-rm';rm.type='button';rm.textContent='remover';rm.addEventListener('click',function(){fetch('/api/admin/passkey/remover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:p.id})}).then(carrega).then(function(){aviso('Aparelho removido.');});});it.appendChild(n);it.appendChild(rm);lista.appendChild(it);});});}" +
      "if(window.SuzuPasskey&&SuzuPasskey.suportado()){carrega();}else{document.getElementById('pkbox').hidden=true;}" +
      "add.addEventListener('click',function(){add.disabled=true;add.textContent='Confirmando…';SuzuPasskey.cadastrar().then(function(){add.disabled=false;add.textContent='Cadastrar este aparelho';aviso('Pronto! Agora você entra com Face ID ou digital.');carrega();}).catch(function(err){add.disabled=false;add.textContent='Cadastrar este aparelho';aviso(String(err.message)==='cancelado'?'Cadastro cancelado.':'Não deu para cadastrar agora.',true);});});" +
      "document.getElementById('sair').addEventListener('click',function(){fetch('/api/admin/logout',{method:'POST'}).then(function(){location.href='/admin';});});" +
      "</script>" +
      "</div></div>",
    "Admin"
  );
}

// Casca larga (listas/formulários) — o conteúdo é montado por js/admin-catalogo.js
function baseLargo(inner, titulo) {
  return base("<main class='awrap awrap-wide'>" + inner + "</main>", titulo).replace(
    "</body>",
    "<script src=/js/admin-catalogo.js></script></body>"
  );
}

function paginaProdutos() {
  return baseLargo(
    "<div class=apage>" +
      "<div class=apage-head>" +
        "<div><h1>Produtos</h1><p class=apage-sub id=contagem>Carregando…</p></div>" +
        "<a class='btn' href='/admin/produto'>Novo produto</a>" +
      "</div>" +
      "<div id=lista class=alista></div>" +
    "</div>",
    "Produtos"
  );
}

function paginaCategorias() {
  return baseLargo(
    "<div class=apage>" +
      "<div class=apage-head><div><h1>Categorias</h1>" +
      "<a class=apage-sub-link href='/admin/produtos'>← Produtos</a></div></div>" +
      "<div id=cats>Carregando…</div>" +
    "</div>",
    "Categorias"
  );
}

function paginaProduto() {
  return baseLargo("<div class=apage id=form>Carregando…</div>", "Produto");
}

function escapar(s) {
  return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
