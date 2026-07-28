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
    // qualquer outra coisa → a loja (assets).
    // Cache "sempre revalida" (no-cache) em HTML/CSS/JS: o Cloudflare guarda mas
    // consulta a origem a cada request → 304 (REVALIDATED) quando não mudou
    // (rápido, quase-cache) e 200 (EXPIRED) quando mudou. Assim todo deploy
    // aparece na hora, SEM purge manual. Fontes/imagens seguem o cache padrão.
    const res = await env.ASSETS.fetch(request);
    const ct = res.headers.get("content-type") || "";
    if (/text\/html|text\/css|javascript/i.test(ct)) {
      const r = new Response(res.body, res);
      r.headers.set("Cache-Control", "no-cache, must-revalidate");
      return r;
    }
    return res;
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
  authorized: "pendente", // auth-hold (auth-e-captura): ainda não capturado — nunca tratar como recusado
  in_process: "pendente",
  pending: "pendente",
  rejected: "recusado",
  cancelled: "cancelado",
};
function mapStatusMp(mpStatus) {
  return MP_STATUS[mpStatus];
}

// JSON.parse tolerante: dado malformado no D1 (itens/endereço) não pode derrubar
// GET /api/compra num 500 sem corpo (o front cairia no .catch genérico). Degrada
// pro fallback e segue.
function jparse(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch (_) {
    return fallback;
  }
}

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
    // frete recomputado no servidor (em recomputaTotal) a partir do CEP do
    // endereço + a OPÇÃO escolhida — o cliente só manda a opção, nunca o valor.
    const freteOpcao = str(body.freteOpcao) === "expresso" ? "expresso" : "economico";
    const consentiu = body.consentiu === true;
    const ip = request.headers.get("CF-Connecting-IP") || "";

    // 1. LGPD — sem consentimento não cobramos nem tratamos os dados
    if (!consentiu) return json({ ok: false, erro: "consentimento" }, 400);
    if (!email) return json({ ok: false, erro: "email" }, 400);
    if (cpf.length !== 11) return json({ ok: false, erro: "cpf" }, 400);
    if (!itens.length) return json({ ok: false, erro: "vazio" }, 400);

    // 2. o valor cobrado nasce AQUI — subtotal recomputado de {id,tam,qtd} e
    //    FRETE recomputado do CEP + opção; ignora qualquer preço/frete que tenha
    //    vindo no payload do cliente (que só escolhe a opção de frete).
    const calc = recomputaTotal(itens, { metodo, cupom, cep: endereco && endereco.cep, freteOpcao });
    if (calc.erro) return json({ ok: false, erro: calc.erro }, 400);
    const { subtotal, desconto, frete, total, linhas } = calc;

    // parcelas: nunca confiar no valor do cliente — clampa em [1, máximo
    // permitido pro total recomputado] (mesma regra de negócio de parcelasValidas)
    // Pix é sempre à vista (1×); só o cartão parcela. Evita mandar installments>1
    // num Pix (o MP rejeitaria e viraria "recusado" à toa).
    const parcelas = metodo === "pix" ? 1 : Math.min(Math.max(1, Math.round(Number(body.parcelas) || 1)), parcelasValidas(total).maxParcelas);

    // 3. grava a compra ANTES de chamar o MP — se a rede/MP falhar, a venda
    //    iniciada não se perde. itens grava as linhas com o preco_unit
    //    efetivamente cobrado (registro financeiro), não o payload cru do cliente.
    //
    // IDEMPOTÊNCIA (anti-cobrança-dupla): o cliente manda um `checkoutId` estável
    // — o MESMO em retries/duplo-clique da mesma tentativa. Ele vira a PK da compra
    // E a X-Idempotency-Key do MP. Assim um retry: (a) esbarra na PK (compra já
    // existe) e devolve o mesmo resultado sem cobrar de novo; (b) mesmo se dois
    // requests correrem juntos, o MP com a mesma chave devolve o MESMO pagamento
    // (não cobra 2×). Sem checkoutId (cliente antigo) cai no uuid aleatório = hoje.
    const compraId = /^[0-9a-f-]{36}$/i.test(str(body.checkoutId)) ? str(body.checkoutId) : crypto.randomUUID();
    const ref = gerarRef(compraId);
    try {
      await env.DB.prepare(
        "INSERT INTO compras (id, ref, criado_em, itens, subtotal, frete, desconto, total, metodo, parcelas, contato_email, contato_whats, cpf, endereco, status, consentiu, ip) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'iniciado', 1, ?)"
      )
        .bind(compraId, ref, new Date().toISOString(), JSON.stringify(linhas), subtotal, frete, desconto, total, metodo, parcelas, email, whats || null, cpf, endereco ? JSON.stringify(endereco) : null, ip)
        .run();
    } catch (e) {
      // Provável violação de PK = retry do MESMO checkout. Se a 1ª tentativa já
      // avançou (status != 'iniciado'), devolve o mesmo resultado — não cobra de novo.
      const existente = await env.DB.prepare("SELECT ref, status, metodo, mp_payment_id FROM compras WHERE id = ?").bind(compraId).first();
      if (!existente) {
        // INSERT falhou por outro motivo (não é a compra duplicada) — não cobra às cegas.
        console.error("insert compra falhou", e);
        return json({ ok: false, erro: "servidor" }, 500);
      }
      if (existente.status !== "iniciado") {
        let pix;
        if (existente.status === "pendente" && existente.metodo === "pix" && existente.mp_payment_id) {
          try { const full = await consultaPagamentoFull(env, existente.mp_payment_id); if (full && full.pix) pix = full.pix; } catch (_) { /* MP fora do ar: devolve sem pix, o polling tenta de novo */ }
        }
        return json({ ok: true, ref: existente.ref, status: existente.status, pix });
      }
      // status 'iniciado' (1ª tentativa ainda em voo): segue e chama o MP com a MESMA
      // idempotencyKey — o MP devolve o mesmo pagamento (não cobra 2×) e o UPDATE converge.
    }

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
// antes de navegar pra lá). Pendente só expõe status/QR do Pix, nada de dado
// financeiro (total, itens, endereço) ou pessoal (e-mail, telefone) — mas uma
// compra APROVADA inclui `order` (itens/total/frete/endereço/contato), pra
// /pix/<ref> conseguir montar o mesmo recap de /pedido (confirmView, ver
// index.html) mesmo numa aba "retornada" sem CO em memória.
//
// Compra pendente em Pix: reconsulta o MP (por mp_payment_id) e devolve o QR/
// copia-e-cola atuais — a tela /pix/<ref> é retornável (pode ser recarregada ou
// reaberta bem depois de /api/pagar ter respondido), então não dá pra confiar
// num QR que só existiu na memória do primeiro request.
//
// PRIVACIDADE (pré-lançamento, endereçar antes de produção pra valer): `ref`
// tem só 6 chars hex (gerarRef()) — alguém que adivinhasse/força-brutasse um
// ref alheio veria o pedido completo (itens, total, endereço). Aceitável
// agora (loja ainda não lançou pra valer), mas antes de ir ao ar de verdade
// isso precisa de um token mais longo (ou exigir e-mail pra liberar `order`).
async function handleCompra(url, env) {
  const ref = str(url.searchParams.get("ref"));
  if (!ref) return json({ status: "nao_encontrado" });
  const row = await env.DB.prepare(
    "SELECT id, ref, status, metodo, mp_payment_id, itens, total, frete, desconto, parcelas, endereco, contato_email, contato_whats, criado_em " +
      "FROM compras WHERE ref = ?"
  )
    .bind(ref)
    .first();
  if (!row) return json({ status: "nao_encontrado" });

  const resposta = { status: row.status };
  if (row.status === "pendente" && row.metodo === "pix") {
    // `total` (centavos) é o único dado financeiro exposto no estado pendente —
    // não é sensível: já está embutido no código copia-e-cola/QR que o cliente
    // vê no app do banco. Mostrar na tela /pix/<ref> antes de escanear é boa
    // prática; itens/endereço/cpf continuam reservados pro estado aprovado.
    resposta.total = row.total;
    if (row.mp_payment_id) {
      try {
        const full = await consultaPagamentoFull(env, row.mp_payment_id);
        const novo = mapStatusMp(full.status);
        if (novo && novo !== "pendente") {
          // O MP já avançou (aprovado/recusado/cancelado) e o webhook ainda não
          // chegou (ou se perdeu): persiste AQUI e reflete já nesta resposta —
          // a tela /pix/<ref> confirma sozinha, sem depender só do webhook.
          await env.DB.prepare("UPDATE compras SET status = ? WHERE id = ? AND status = 'pendente'")
            .bind(novo, row.id)
            .run();
          row.status = novo;
          resposta.status = novo;
        }
        // só faz sentido devolver o QR enquanto segue pendente
        if (row.status === "pendente" && full && full.pix) resposta.pix = full.pix;
      } catch (e) {
        // MP indisponível nesta rodada — devolve só o status; o polling do
        // cliente tenta de novo em ~4s.
        console.error("consultaPagamentoFull falhou", e);
      }
    }
  }
  if (row.status === "aprovado") {
    // nunca inclui cpf nem mp_payment_id aqui — só o que o recap precisa mostrar.
    resposta.order = {
      ref: row.ref,
      itens: jparse(row.itens, []),
      total: row.total,
      frete: row.frete,
      desconto: row.desconto,
      metodo: row.metodo,
      parcelas: row.parcelas,
      endereco: jparse(row.endereco, null),
      contato_email: row.contato_email,
      contato_whats: row.contato_whats,
      criado_em: row.criado_em,
    };
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
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: true }, 200); // corpo inválido: ack, não faz o MP reenviar à toa
  }

  // Só nos importa evento de pagamento com id — o resto é ack (no-op bem-formado).
  if (!(body && body.type === "payment" && body.data && body.data.id != null)) {
    return json({ ok: true }, 200);
  }

  // Assinatura do MP (defesa em profundidade). O endpoint já é resistente a forja
  // porque RECONSULTA o status real no MP (não confia no corpo) — mas verificar a
  // assinatura evita consultas disparadas por terceiros. Inerte até MP_WEBHOOK_SECRET
  // existir (ainda não configurado): sem o segredo, não bloqueia nada.
  if (env.MP_WEBHOOK_SECRET) {
    const ok = await verificaAssinaturaMp(request, body, env.MP_WEBHOOK_SECRET);
    if (!ok) return json({ ok: false, erro: "assinatura" }, 401);
  }

  try {
    const resultado = await consultaPagamento(env, body.data.id);
    if (resultado.status == null) {
      // Não conseguimos ler o status no MP (indisponível/erro de rede) — NÃO
      // engole como 200. Devolve 5xx pro MP reenviar; senão a confirmação some.
      return json({ ok: false, erro: "mp_indisponivel" }, 503);
    }
    const status = mapStatusMp(resultado.status);
    // status conhecido mas não mapeado (in_mediation, refunded…) → ack, no-op:
    // não sobrescreve o status atual com um default errado.
    if (status) {
      const upd = await env.DB.prepare("UPDATE compras SET status = ? WHERE mp_payment_id = ?")
        .bind(status, String(body.data.id))
        .run();
      // Cura de órfão: se nenhuma linha casou pelo mp_payment_id, a compra pode ter
      // ficado 'iniciado' com mp_payment_id NULL (o /api/pagar cobrou mas morreu antes
      // do UPDATE). Casa pela external_reference (= id da compra) e backfilla o
      // mp_payment_id, pra os próximos webhooks casarem direto.
      if ((!upd.meta || upd.meta.changes === 0) && resultado.externalReference) {
        await env.DB.prepare("UPDATE compras SET status = ?, mp_payment_id = ? WHERE id = ? AND mp_payment_id IS NULL")
          .bind(status, String(body.data.id), String(resultado.externalReference))
          .run();
      }
    }
  } catch (e) {
    // Erro nosso (DB/rede) — pede reenvio (5xx), não engole como sucesso.
    console.error("mp-webhook falhou", e);
    return json({ ok: false, erro: "servidor" }, 500);
  }
  return json({ ok: true }, 200);
}

// Verifica a assinatura HMAC do webhook do MP (header x-signature: "ts=...,v1=...").
// Manifesto = "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" (partes omitidas
// quando ausentes), HMAC-SHA256 com o segredo → compara em hex com v1.
async function verificaAssinaturaMp(request, body, secret) {
  try {
    const sig = request.headers.get("x-signature") || "";
    const reqId = request.headers.get("x-request-id") || "";
    const parts = {};
    sig.split(",").forEach((kv) => {
      const i = kv.indexOf("=");
      if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
    if (!parts.ts || !parts.v1) return false;
    const id = body.data && body.data.id != null ? String(body.data.id) : "";
    let manifest = "";
    if (id) manifest += "id:" + id + ";";
    if (reqId) manifest += "request-id:" + reqId + ";";
    manifest += "ts:" + parts.ts + ";";
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(manifest));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex === parts.v1;
  } catch (_) {
    return false;
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
