// Worker da Loja Suzu.
// Rotas de código:
//   POST /api/orcamento  → recebe o formulário do Projeto Exclusivo
//   GET  /api/anexo       → serve um anexo do R2 via link assinado (usado no e-mail)
// Todo o resto é servido como asset estático (a loja) — ver wrangler.jsonc.
import { EmailMessage } from "cloudflare:email";
import { recomputaTotal, parcelasValidas } from "./precos.js";
import { criaPagamento, consultaPagamento, consultaPagamentoFull } from "./mp.js";

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
    if (url.pathname === "/api/pagar") {
      if (request.method !== "POST") return json({ ok: false, error: "metodo" }, 405);
      return handlePagar(request, env);
    }
    if (url.pathname === "/api/compra") {
      if (request.method !== "GET") return json({ ok: false, error: "metodo" }, 405);
      return handleCompra(url, env);
    }
    if (url.pathname === "/api/mp-webhook") {
      // Sempre 200 aqui dentro (mesmo em método errado) — o MP reenvia pra
      // sempre qualquer coisa != 200, então não queremos abrir esse buraco.
      return handleMpWebhook(request, env);
    }
    if (url.pathname === "/api/config") {
      if (request.method !== "GET") return json({ ok: false, error: "metodo" }, 405);
      return json({ mpKey: env.MP_PUBLIC_KEY });
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
    const ref = gerarRef(pedidoId);
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

// MP → interno (schema.sql: status = iniciado|pendente|aprovado|recusado|cancelado).
// Compartilhado entre /api/pagar e /api/mp-webhook — status desconhecido
// retorna undefined (cada chamador decide o que fazer com isso).
const MP_STATUS = {
  approved: "aprovado",
  in_process: "pendente",
  pending: "pendente",
  rejected: "recusado",
  cancelled: "cancelado",
};
function mapStatusMp(mpStatus) {
  return MP_STATUS[mpStatus];
}

// Teto de frete aceito do cliente: R$1000 em centavos. F4a ainda recebe o
// frete do cliente (frete real/calculado por CEP é F4b — servidor autoritativo
// só pra frete vem depois); este teto + o floor em 0 fecham o buraco de
// "pagar quase nada pelos produtos" mandando freteCents negativo.
const FRETE_MAX_CENTS = 100000;

// POST /api/pagar — hub da Fase 4a: recomputa o total no servidor (nunca confia
// no preço do cliente), grava a compra ANTES de chamar o MP (resiliência —
// se o MP/rede falhar, a linha não se perde), chama o MP e atualiza o status.
async function handlePagar(request, env) {
  try {
    const body = await request.json();
    const itens = Array.isArray(body.itens) ? body.itens : [];
    const metodo = str(body.metodo);
    const cupom = str(body.cupom);
    const email = str(body.email);
    const whats = str(body.whats);
    const cpf = str(body.cpf).replace(/\D/g, "");
    const endereco = body.endereco || null;
    // freteCents é do cliente (F4a) — nunca confiar sem clamp: negativo
    // zeraria o total junto com o subtotal recomputado.
    const freteCents = Math.max(0, Math.min(Math.round(Number(body.freteCents) || 0), FRETE_MAX_CENTS));
    const consentiu = body.consentiu === true;
    const ip = request.headers.get("CF-Connecting-IP") || "";

    // 1. LGPD — sem consentimento não cobramos nem tratamos os dados
    if (!consentiu) return json({ ok: false, erro: "consentimento" }, 400);
    if (!email) return json({ ok: false, erro: "email" }, 400);
    if (cpf.length !== 11) return json({ ok: false, erro: "cpf" }, 400);
    if (!itens.length) return json({ ok: false, erro: "vazio" }, 400);

    // 2. o valor cobrado nasce AQUI — recomputado a partir de {id,tam,qtd},
    //    ignorando qualquer preço (e agora também qualquer frete fora do
    //    teto) que tenha vindo no payload do cliente
    const calc = recomputaTotal(itens, { metodo, cupom, freteCents });
    if (calc.erro) return json({ ok: false, erro: calc.erro }, 400);
    const { subtotal, desconto, frete, total, linhas } = calc;

    // parcelas: nunca confiar no valor do cliente — clampa em [1, máximo
    // permitido pro total recomputado] (mesma regra de negócio de parcelasValidas)
    const parcelas = Math.min(Math.max(1, Math.round(Number(body.parcelas) || 1)), parcelasValidas(total).maxParcelas);

    // 3. grava a compra ANTES de chamar o MP — se a rede/MP falhar, a venda
    //    iniciada não se perde. itens grava as linhas com o preco_unit
    //    efetivamente cobrado (registro financeiro), não o payload cru do cliente.
    const compraId = crypto.randomUUID();
    const ref = gerarRef(compraId);
    await env.DB.prepare(
      "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, parcelas, contato_email, contato_whats, cpf, endereco, status, consentiu, ip) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'iniciado', 1, ?)"
    )
      .bind(compraId, ref, new Date().toISOString(), JSON.stringify(linhas), subtotal, frete, desconto, total, metodo, parcelas, email, whats || null, cpf, endereco ? JSON.stringify(endereco) : null, ip)
      .run();

    // 4. cobra no Mercado Pago
    // PRÉ-VENDA (sinal 30%) NÃO é modelada aqui: `total` acima já é o preço
    // cheio recomputado a partir do preço do servidor — o servidor não sabe
    // que um item é reserva e cobra 100% dele. Manter PREVENDA=false (index.html)
    // até a F4-pré-venda implementar o sinal server-side, senão a primeira
    // reserva cobra 3.3× a mais do que deveria.
    const resultado = await criaPagamento(env, {
      totalCents: total,
      metodo,
      parcelas,
      token: body.token,
      paymentMethodId: body.paymentMethodId,
      issuerId: body.issuerId,
      cpf,
      email,
      ref,
      // uuid da compra como chave de idempotência (não o `ref` curto de 6 hex,
      // que pode colidir entre compras diferentes e devolver o pagamento
      // errado) — `ref` continua só na descrição, pra referência humana.
      idempotencyKey: compraId,
      descricao: "Pedido " + ref,
    });

    // Erro de rede/MP (ex.: cartão recusado com corpo sem `status`) mapeia pra
    // undefined em mapStatusMp e cai aqui: tratamos como "recusado", nunca
    // como "pendente" — uma tentativa de cartão nunca pode ficar pendurada
    // com mp_payment_id nulo esperando um Pix que não existe (ver IMPORTANTE #2).
    const mpMappedStatus = mapStatusMp(resultado.status);
    const status = resultado.status === "error" || !mpMappedStatus ? "recusado" : mpMappedStatus;

    // 5. atualiza a compra com o resultado do MP
    await env.DB.prepare("UPDATE compras SET status = ?, mp_payment_id = ? WHERE id = ?")
      .bind(status, resultado.id != null ? String(resultado.id) : null, compraId)
      .run();

    return json({ ok: true, ref, status, pix: resultado.pix });
  } catch (e) {
    console.error("pagar falhou", e);
    return json({ ok: false, erro: "servidor" }, 500);
  }
}

// GET /api/compra?ref= — polling do estado do pagamento (usado pelo front na tela
// /pix/<ref>, retornável, enquanto espera a confirmação do Pix — e no /checkout
// antes de navegar pra lá). Só expõe status/QR do Pix, nada de dado financeiro
// (total, itens, endereço, CPF) ou pessoal (e-mail, telefone).
//
// Compra pendente em Pix: reconsulta o MP (por mp_payment_id) e devolve o QR/
// copia-e-cola atuais — a tela /pix/<ref> é retornável (pode ser recarregada ou
// reaberta bem depois de /api/pagar ter respondido), então não dá pra confiar
// num QR que só existiu na memória do primeiro request.
async function handleCompra(url, env) {
  const ref = str(url.searchParams.get("ref"));
  if (!ref) return json({ status: "nao_encontrado" });
  const row = await env.DB.prepare("SELECT status, metodo, mp_payment_id FROM compras WHERE ref = ?").bind(ref).first();
  if (!row) return json({ status: "nao_encontrado" });

  const resposta = { status: row.status };
  if (row.status === "pendente" && row.metodo === "pix" && row.mp_payment_id) {
    try {
      const full = await consultaPagamentoFull(env, row.mp_payment_id);
      if (full && full.pix) resposta.pix = full.pix;
    } catch (e) {
      // MP indisponível nesta rodada — devolve só o status; o polling do
      // cliente tenta de novo em ~4s.
      console.error("consultaPagamentoFull falhou", e);
    }
  }
  return json(resposta);
}

// POST /api/mp-webhook — o MP notifica mudanças de status assíncronas
// (essencial pro Pix, que confirma depois do fato). Sempre responde 200:
// o MP reenvia pra sempre qualquer coisa != 200, e um erro nosso não pode
// virar reenvio infinito. Idempotente por natureza: o UPDATE por
// mp_payment_id sempre converge pro mesmo estado, processar o mesmo evento
// 2x não muda o resultado. Evento sem compra correspondente (WHERE não bate
// nenhuma linha) e tipo de evento desconhecido são no-op, não erro.
async function handleMpWebhook(request, env) {
  try {
    const body = await request.json();
    if (body && body.type === "payment" && body.data && body.data.id != null) {
      const resultado = await consultaPagamento(env, body.data.id);
      const status = mapStatusMp(resultado.status);
      // status MP não mapeado (ex.: authorized, in_mediation) → não sobrescreve
      // o status atual da compra em vez de arriscar um default errado.
      if (status) {
        await env.DB.prepare("UPDATE compras SET status = ? WHERE mp_payment_id = ?")
          .bind(status, String(body.data.id))
          .run();
      }
    }
  } catch (e) {
    console.error("mp-webhook falhou", e);
  }
  return json({ ok: true }, 200);
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

// nº amigável a partir de um uuid — mesmo padrão em pedidos e compras
function gerarRef(id) {
  return "SUZU-" + id.replace(/-/g, "").slice(0, 6).toUpperCase();
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
