// Worker da Loja Suzu.
// Rotas de código:
//   POST /api/orcamento  → recebe o formulário do Projeto Exclusivo
//   GET  /api/anexo       → serve um anexo do R2 via link assinado (usado no e-mail)
// Todo o resto é servido como asset estático (a loja) — ver wrangler.jsonc.
import { EmailMessage } from "cloudflare:email";

const MAX_ARQUIVO = 10 * 1024 * 1024; // 10 MB por anexo
const MAX_ANEXOS = 12;
const TIPOS_OK = ["image/", "application/pdf"];
const CONSENT_VERSAO = "v1-2026-07"; // versão do texto de consentimento (LGPD)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/orcamento") {
      if (request.method !== "POST") return json({ ok: false, error: "metodo" }, 405);
      return handleOrcamento(request, env);
    }
    if (url.pathname === "/api/anexo") {
      return serveAnexo(url, env);
    }
    // qualquer outra coisa → a loja (assets)
    return env.ASSETS.fetch(request);
  },
};

async function handleOrcamento(request, env) {
  try {
    const form = await request.formData();
    const contato = str(form.get("contato"));
    const nome = str(form.get("nome"));
    const brief = str(form.get("brief"));
    const origem = str(form.get("origem")).slice(0, 200);
    const consentiu = str(form.get("consentiu")) === "1";
    const tsToken = str(form.get("cf-turnstile-response"));
    const ip = request.headers.get("CF-Connecting-IP") || "";

    // 1. validação básica (contato é o único obrigatório)
    if (!contato || contato.length > 200) return json({ ok: false, error: "contato" }, 400);
    if (nome.length > 200 || brief.length > 5000) return json({ ok: false, error: "tamanho" }, 400);

    // 2. LGPD — sem consentimento não tratamos os dados
    if (!consentiu) return json({ ok: false, error: "consentimento" }, 400);

    // 3. anti-spam (Turnstile)
    if (!(await verificaTurnstile(tsToken, env, ip))) {
      return json({ ok: false, error: "turnstile" }, 403);
    }

    // 4. anexos → R2 (tipo e tamanho validados NO SERVIDOR, sem confiar no cliente)
    const arquivos = form.getAll("anexos").filter((f) => typeof f !== "string" && f.size > 0);
    if (arquivos.length > MAX_ANEXOS) return json({ ok: false, error: "muitos" }, 400);
    const pedidoId = crypto.randomUUID();
    const ref = "SUZU-" + pedidoId.replace(/-/g, "").slice(0, 6).toUpperCase();
    const anexos = [];
    for (const f of arquivos) {
      if (f.size > MAX_ARQUIVO) return json({ ok: false, error: "arquivo_grande" }, 400);
      if (!TIPOS_OK.some((t) => (f.type || "").startsWith(t))) return json({ ok: false, error: "tipo" }, 400);
      const key = `orcamentos/${pedidoId}/${sanitiza(f.name)}`;
      await env.ANEXOS.put(key, f.stream(), { httpMetadata: { contentType: f.type } });
      anexos.push({ key, name: f.name, size: f.size, type: f.type });
    }

    // 5. grava o pedido ANTES de avisar — se o e-mail falhar, o pedido não se perde
    await env.DB.prepare(
      "INSERT INTO pedidos (id, ref, criado_em, nome, contato, brief, anexos, origem, status, consentiu, consent_versao, ip) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'novo', 1, ?, ?)"
    )
      .bind(pedidoId, ref, new Date().toISOString(), nome, contato, brief, JSON.stringify(anexos), origem, CONSENT_VERSAO, ip)
      .run();

    // 6. avisa o estúdio (não bloqueia o sucesso se falhar — o pedido já está salvo)
    try {
      await avisaEstudio(env, { ref, nome, contato, brief, anexos, origem, base: new URL(request.url).origin });
    } catch (_) {
      // pedido já persistido no D1; o aviso pode ser recuperado do banco
    }

    return json({ ok: true, ref });
  } catch (_) {
    return json({ ok: false, error: "servidor" }, 500);
  }
}

// Serve um anexo do R2 se o link (assinado) for válido — usado nos links do e-mail.
async function serveAnexo(url, env) {
  const key = url.searchParams.get("k") || "";
  const tok = url.searchParams.get("t") || "";
  if (!key || !tok) return new Response("não encontrado", { status: 404 });
  const esperado = await assina(key, env.TURNSTILE_SECRET);
  if (tok !== esperado) return new Response("link inválido", { status: 403 });
  const obj = await env.ANEXOS.get(key);
  if (!obj) return new Response("não encontrado", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("cache-control", "private, no-store");
  return new Response(obj.body, { headers: h });
}

async function verificaTurnstile(token, env, ip) {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const data = await r.json();
  return !!data.success;
}

async function avisaEstudio(env, p) {
  // link clicável (assinado) por anexo — abre a imagem/PDF direto do e-mail
  const anexosLinhas = [];
  for (const a of p.anexos) {
    const tok = await assina(a.key, env.TURNSTILE_SECRET);
    anexosLinhas.push("• " + a.name + " — " + p.base + "/api/anexo?k=" + encodeURIComponent(a.key) + "&t=" + tok);
  }

  const linhas = [
    "Novo pedido de Projeto Exclusivo — " + p.ref + " 🌸",
    "",
    "Contato: " + p.contato,
    p.nome ? "Nome: " + p.nome : null,
    p.origem ? "Origem: " + p.origem : null,
    "",
    "Briefing:",
    p.brief || "(sem briefing)",
    "",
    p.anexos.length ? "Anexos (" + p.anexos.length + "):\n" + anexosLinhas.join("\n") : "Sem anexos",
    "",
    "Responder em até 3 dias úteis.",
  ]
    .filter((x) => x !== null)
    .join("\n");

  // Caminho GRÁTIS: binding send_email → destino verificado (somos.suzu@gmail),
  // via cloudflare:email (não é o produto pago "Email Sending"). MIME montado à mão.
  const subject = "Novo orçamento " + p.ref + " — " + (p.nome || p.contato);
  const raw = [
    "From: " + env.AVISO_FROM,
    "To: " + env.AVISO_TO,
    "Subject: =?UTF-8?B?" + b64(subject) + "?=",
    "Message-ID: <" + crypto.randomUUID() + "@studiosuzu.com.br>",
    "Date: " + new Date().toUTCString(),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    dobra(b64(linhas), 76),
  ].join("\r\n");

  await env.EMAIL.send(new EmailMessage(env.AVISO_FROM, env.AVISO_TO, raw));
}

// base64 de string UTF-8 (sem estourar em textos longos)
function b64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// dobra o base64 em linhas de n chars (RFC 2045)
function dobra(s, n) {
  const partes = [];
  for (let i = 0; i < s.length; i += n) partes.push(s.slice(i, i + n));
  return partes.join("\r\n");
}

// HMAC-SHA256(key) em base64url — assina os links de anexo (reusa a secret do Turnstile).
async function assina(dado, secret) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(dado));
  return btoa(String.fromCharCode.apply(null, new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function str(v) {
  return (v == null ? "" : String(v)).trim();
}

function sanitiza(nome) {
  return String(nome || "arquivo")
    .replace(/[^\w.\-]+/g, "_")
    .slice(-80);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
