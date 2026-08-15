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
import {
  listaProdutos,
  leProduto,
  salvaProduto,
  apagaProduto,
  excluiProduto,
  duplicaProduto,
  listaCategorias,
  salvaCategoria,
  apagaCategoria,
  subirMidia,
  leConfig,
  salvaConfig,
  resumoAdmin,
} from "./catalogo.js";
import {
  listaCompras,
  pegaCompra,
  listaOrcamentos,
  pegaOrcamento,
  mudaStatusOrcamento,
} from "./vendas.js";

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
  if (p === "/api/admin/produto/duplicar" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const { id } = await request.json();
      const r = await duplicaProduto(env, id);
      if (r.ok) await auditoria(env, sessao.usuario_id, "produto.duplicado", r.id, { origem: String(id) }, ip);
      return json(r, r.ok ? 200 : 400);
    } catch (e) {
      console.error("produto.duplicar", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/produto/excluir" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const { id } = await request.json();
      // guarda o nome ANTES de apagar — depois não dá pra saber o que sumiu
      const antes = await leProduto(env, id);
      const r = await excluiProduto(env, id);
      if (r.ok) await auditoria(env, sessao.usuario_id, "produto.excluido", String(id), { nome: antes && antes.nome }, ip);
      return json(r, r.ok ? 200 : 400);
    } catch (e) {
      console.error("produto.excluir", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
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
  // ── Vendas (dado de CLIENTE aqui — lista mínima, detalhe por UUID,
  //    nada de PII em log; ver src/vendas.js) ──────────────────────────────
  if (p === "/api/admin/compras" && m === "GET") {
    try {
      return json({ ok: true, compras: await listaCompras(env, url.searchParams.get("filtro")) });
    } catch (e) {
      console.error("compras lista", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/compra" && m === "GET") {
    try {
      const c = await pegaCompra(env, url.searchParams.get("id"));
      return c ? json({ ok: true, compra: c }) : json({ ok: false, erro: "nao_encontrado" }, 404);
    } catch (e) {
      console.error("compra detalhe", url.searchParams.get("id"), e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/orcamentos" && m === "GET") {
    try {
      return json({ ok: true, orcamentos: await listaOrcamentos(env, url.searchParams.get("filtro")) });
    } catch (e) {
      console.error("orcamentos lista", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/orcamento" && m === "GET") {
    try {
      const o = await pegaOrcamento(env, url.searchParams.get("id"));
      return o ? json({ ok: true, orcamento: o }) : json({ ok: false, erro: "nao_encontrado" }, 404);
    } catch (e) {
      console.error("orcamento detalhe", url.searchParams.get("id"), e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/orcamento/status" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const corpo = await request.json();
      const r = await mudaStatusOrcamento(env, corpo && corpo.id, corpo && corpo.status);
      // auditoria SEM PII: ref + transição bastam pra reconstruir a história
      if (r.ok) await auditoria(env, sessao.usuario_id, "orcamento.status", r.ref, { de: r.de, para: r.para }, ip);
      return json(r, r.ok ? 200 : r.erro === "nao_encontrado" ? 404 : 400);
    } catch (e) {
      console.error("orcamento status", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }

  if (p === "/api/admin/resumo" && m === "GET") {
    try {
      return json({ ok: true, resumo: await resumoAdmin(env) });
    } catch (e) {
      console.error("resumo", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/api/admin/config" && m === "GET") {
    return json({ ok: true, config: await leConfig(env) });
  }
  if (p === "/api/admin/config" && m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    try {
      const corpo = await request.json();
      const r = await salvaConfig(env, corpo);
      if (r.ok) await auditoria(env, sessao.usuario_id, "config.salva", "loja", r.config, ip);
      return json(r, r.ok ? 200 : 400);
    } catch (e) {
      console.error("config", e);
      return json({ ok: false, erro: "servidor" }, 500);
    }
  }
  if (p === "/admin/pedidos") return html(paginaPedidos());
  if (p === "/admin/pedido") return html(paginaPedido());
  if (p === "/admin/orcamentos") return html(paginaOrcamentos());
  if (p === "/admin/orcamento") return html(paginaOrcamento());
  if (p === "/admin/config") return html(paginaConfig());
  if (p === "/admin/acesso") return html(paginaAcesso(sessao));
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
    headers: {
      "content-type": "application/json; charset=utf-8",
      "X-Robots-Tag": "noindex",
      // no-store em TODA resposta de API do admin: com Vendas no ar, várias
      // carregam dado de cliente — nenhum cache (borda ou navegador) deve
      // guardar isso, nem por um segundo.
      "Cache-Control": "no-store",
    },
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
// ── MAPA DO ADMIN ────────────────────────────────────────────────────────────
// Anatomia copiada de Shopify e Nuvemshop: navegação PERSISTENTE à esquerda,
// agrupada por assunto, sempre visível. O mapa inteiro fica exposto desde já —
// inclusive o que ainda não existe, marcado "em breve". Um menu que cresce por
// surpresa faz a pessoa reaprender a ferramenta a cada semana; vendo o mapa
// completo ela entende o tamanho do território e sabe onde a coisa VAI estar.
// Ordem dos grupos: a mesma das duas plataformas — o que dá dinheiro primeiro
// (vendas), depois o que se vende (catálogo), quem compra, como se divulga, o
// site, os números e, por último, a configuração.
const MENU = [
  { grupo: "", itens: [["/admin", "Início"]] },
  {
    grupo: "Vendas",
    itens: [
      ["/admin/pedidos", "Pedidos"],
      ["/admin/orcamentos", "Orçamentos"],
      ["/admin/abandonados", "Carrinhos abandonados", "em breve"],
    ],
  },
  {
    grupo: "Catálogo",
    itens: [
      ["/admin/produtos", "Produtos"],
      ["/admin/categorias", "Categorias"],
      ["/admin/estoque", "Estoque", "em breve"],
      ["/admin/midia", "Mídia", "em breve"],
    ],
  },
  { grupo: "Clientes", itens: [["/admin/clientes", "Clientes", "em breve"]] },
  {
    grupo: "Marketing",
    itens: [
      ["/admin/cupons", "Cupons", "em breve"],
      ["/admin/promocoes", "Promoções", "em breve"],
    ],
  },
  {
    grupo: "Site",
    itens: [
      ["/admin/home", "Página inicial", "em breve"],
      ["/admin/paginas", "Páginas", "em breve"],
      ["/admin/receitas", "Receitas", "em breve"],
    ],
  },
  { grupo: "Relatórios", itens: [["/admin/relatorios", "Relatórios", "em breve"]] },
  {
    grupo: "Configurações",
    itens: [
      ["/admin/config", "Da loja"],
      ["/admin/acesso", "Acesso e aparelhos"],
      ["/admin/envio", "Envio e frete", "em breve"],
      ["/admin/pagamento", "Pagamento", "em breve"],
    ],
  },
];

function menuHtml(atual) {
  return (
    "<nav class=anav-lat aria-label='Seções do admin'>" +
    MENU.map(function (sec) {
      const itens = sec.itens
        .map(function (it) {
          const [href, rotulo, breve] = it;
          const aqui = href === atual;
          if (breve) {
            return (
              "<span class=anav-item aria-disabled=true>" + escapar(rotulo) +
              "<i class=anav-breve>" + breve + "</i></span>"
            );
          }
          return (
            "<a class='anav-item" + (aqui ? " on" : "") + "' href='" + href + "'" +
            (aqui ? " aria-current=page" : "") + ">" + escapar(rotulo) + "</a>"
          );
        })
        .join("");
      return (sec.grupo ? "<div class=anav-grupo>" + escapar(sec.grupo) + "</div>" : "") + itens;
    }).join("") +
    "</nav>"
  );
}

function base(inner, titulo, atual) {
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
      "<a class=alink href='/' target=_blank rel=noopener>Ver a loja ↗</a>" +
      "<span class=tag>Admin</span>" +
    "</div></header>" +
    (atual === undefined ? inner : "<div class=ashell>" + menuHtml(atual) + "<div class=ashell-conteudo>" + inner + "</div></div>") +
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

// INÍCIO — o "Home" do Shopify / "Início" do Nuvemshop: números do negócio no
// topo, tarefas pendentes logo abaixo, atalhos no fim. Os números são REAIS
// (vêm de /api/admin/resumo); painel com número de enfeite é pior que nenhum.
function paginaAdmin(sessao) {
  return base(
    "<div class=apage id=inicio>" +
      "<div class=apage-head><div><h1>Início</h1>" +
      "<p class=apage-sub>" + escapar(sessao.email) + "</p></div>" +
      "<a class=btn href='/admin/produto'>Novo produto</a></div>" +
      "<div id=painel>Carregando…</div>" +
    "</div>",
    "Início",
    "/admin"
  ).replace("</body>", "<script src='/js/admin-inicio.js?v=" + assetsV() + "'></script></body>");
}

// ACESSO — passkeys e sair. Saiu do Início porque não é rotina de trabalho:
// mexe-se nisso uma vez por aparelho (é onde as duas plataformas põem, em
// Configurações → Usuários).
function paginaAcesso(sessao) {
  return base(
    "<div class=apage>" +
      "<div class=apage-head><div><h1>Acesso e aparelhos</h1>" +
      "<p class=apage-sub>Sessão ativa como " + escapar(sessao.email) + "</p></div></div>" +
      "<div class=acard-b id=pkbox>" +
        "<h2 class=acard-b-title>Entrada por passkey</h2>" +
        "<div id=pklista class=apk-lista></div>" +
        "<button id=pkadd class='btn abtn-full'>Cadastrar este aparelho</button>" +
        "<p class=apk-nota>Vale para este endereço. Quando o admin for para o domínio final, cadastre novamente por lá.</p>" +
      "</div>" +
      "<div class=amsg id=msg hidden></div>" +
      "<div class=aacoes><button id=sair class='btn ghost'>Sair</button></div>" +
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
      "</div>",
    "Acesso",
    "/admin/acesso"
  );
}

// Casca larga (listas/formulários) — o conteúdo é montado por js/admin-catalogo.js
function baseLargo(inner, titulo, atual) {
  return base(inner, titulo, atual).replace(
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
    "Produtos",
    "/admin/produtos"
  );
}

function paginaCategorias() {
  return baseLargo(
    "<div class=apage>" +
      "<div class=apage-head><div><h1>Categorias</h1>" +
      "<a class=apage-sub-link href='/admin/produtos'>← Produtos</a></div></div>" +
      "<div id=cats>Carregando…</div>" +
    "</div>",
    "Categorias",
    "/admin/categorias"
  );
}

// Configurações da loja — anatomia do "Settings" do Shopify: seções por assunto,
// cada regra com o efeito explicado ao lado. Começa com uma seção (Vitrine);
// frete, remetente e contato entram aqui conforme forem saindo do código.
function paginaConfig() {
  return base(
    "<div class=apage id=config>Carregando…</div>",
    "Configurações",
    "/admin/config"
  ).replace("</body>", "<script src='/js/admin-config.js?v=" + assetsV() + "'></script></body>");
}

// VENDAS — anatomia da lista de pedidos do Shopify ("Orders") e do Nuvemshop
// ("Vendas"): filtros por status em cima, linhas com nº / data / cliente /
// total / situação; a linha abre o detalhe. Conteúdo montado por
// js/admin-vendas.js — DOM via textContent, nunca innerHTML com dado do banco.
function paginaVendasBase(idConteudo, titulo, atual) {
  return base("<div class=apage id=" + idConteudo + ">Carregando…</div>", titulo, atual).replace(
    "</body>",
    "<script src='/js/admin-vendas.js?v=" + assetsV() + "'></script></body>"
  );
}
function paginaPedidos() {
  return paginaVendasBase("pedidos", "Pedidos", "/admin/pedidos");
}
function paginaPedido() {
  return paginaVendasBase("pedido", "Pedido", "/admin/pedidos");
}
function paginaOrcamentos() {
  return paginaVendasBase("orcamentos", "Orçamentos", "/admin/orcamentos");
}
function paginaOrcamento() {
  return paginaVendasBase("orcamento", "Orçamento", "/admin/orcamentos");
}

function paginaProduto() {
  // formulário na anatomia do admin do Shopify — script próprio (js/admin-produto.js)
  return base("<div class=apage id=form>Carregando…</div>", "Produto", "/admin/produtos").replace(
    "</body>",
    "<script src='/js/admin-produto.js?v=" + assetsV() + "'></script></body>"
  );
}

function escapar(s) {
  return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
