// Worker da Loja Suzu.
// Só uma rota de código: POST /api/orcamento (formulário do Projeto Exclusivo).
// Todo o resto é servido como asset estático (a loja) — ver wrangler.jsonc.

const MAX_ARQUIVO = 10 * 1024 * 1024; // 10 MB por anexo
const MAX_ANEXOS = 12;
const TIPOS_OK = ["image/", "application/pdf"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/orcamento") {
      if (request.method !== "POST") return json({ ok: false, error: "metodo" }, 405);
      return handleOrcamento(request, env);
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
    const tsToken = str(form.get("cf-turnstile-response"));

    // 1. validação básica (contato é o único obrigatório)
    if (!contato || contato.length > 200) return json({ ok: false, error: "contato" }, 400);
    if (nome.length > 200 || brief.length > 5000) return json({ ok: false, error: "tamanho" }, 400);

    // 2. anti-spam (Turnstile)
    if (!(await verificaTurnstile(tsToken, env, request))) {
      return json({ ok: false, error: "turnstile" }, 403);
    }

    // 3. anexos → R2 (tipo e tamanho validados NO SERVIDOR, sem confiar no cliente)
    const arquivos = form.getAll("anexos").filter((f) => typeof f !== "string" && f.size > 0);
    if (arquivos.length > MAX_ANEXOS) return json({ ok: false, error: "muitos" }, 400);
    const pedidoId = crypto.randomUUID();
    const anexos = [];
    for (const f of arquivos) {
      if (f.size > MAX_ARQUIVO) return json({ ok: false, error: "arquivo_grande" }, 400);
      if (!TIPOS_OK.some((t) => (f.type || "").startsWith(t))) return json({ ok: false, error: "tipo" }, 400);
      const key = `orcamentos/${pedidoId}/${sanitiza(f.name)}`;
      await env.ANEXOS.put(key, f.stream(), { httpMetadata: { contentType: f.type } });
      anexos.push({ key, name: f.name, size: f.size, type: f.type });
    }

    // 4. grava o pedido ANTES de avisar — se o e-mail falhar, o pedido não se perde
    await env.DB.prepare(
      "INSERT INTO pedidos (id, criado_em, nome, contato, brief, anexos, status) VALUES (?, ?, ?, ?, ?, ?, 'novo')"
    )
      .bind(pedidoId, new Date().toISOString(), nome, contato, brief, JSON.stringify(anexos))
      .run();

    // 5. avisa o estúdio (não bloqueia o sucesso se falhar — o pedido já está salvo)
    try {
      await avisaEstudio(env, { pedidoId, nome, contato, brief, anexos });
    } catch (_) {
      // pedido já persistido no D1; o aviso pode ser recuperado do banco
    }

    return json({ ok: true, id: pedidoId });
  } catch (_) {
    return json({ ok: false, error: "servidor" }, 500);
  }
}

async function verificaTurnstile(token, env, request) {
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const data = await r.json();
  return !!data.success;
}

async function avisaEstudio(env, p) {
  const linhas = [
    "Novo pedido de Projeto Exclusivo 🌸",
    "",
    "Contato: " + p.contato,
    p.nome ? "Nome: " + p.nome : null,
    "",
    "Briefing:",
    p.brief || "(sem briefing)",
    "",
    p.anexos.length
      ? "Anexos (" + p.anexos.length + "): " + p.anexos.map((a) => a.name).join(", ")
      : "Sem anexos",
    "",
    "Pedido: " + p.pedidoId,
    "Responder em até 3 dias úteis.",
  ]
    .filter((x) => x !== null)
    .join("\n");

  await env.EMAIL.send({
    to: env.AVISO_TO,
    from: env.AVISO_FROM,
    subject: "Novo orçamento — " + (p.nome || p.contato),
    text: linhas,
  });
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
