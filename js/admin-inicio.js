/* Início do admin — o "Home" do Shopify / "Início" do Nuvemshop, na linguagem
   da Suzu: números do negócio em cima, tarefas pendentes no meio, atalhos no fim.
   Todo número vem do banco (/api/admin/resumo). DOM/textContent sempre. */
(function () {
  var alvo = document.getElementById("painel");
  if (!alvo) return;

  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function reais(cents) { return BRL.format((Number(cents) || 0) / 100); }

  // Um número só não diz nada; o que informa é número + o que ele significa +
  // para onde ir fazer algo a respeito. Por isso todo cartão tem os três.
  function cartao(rotulo, valor, nota, href, urgente) {
    var box = el(href ? "a" : "div", "akpi" + (urgente ? " akpi-alerta" : ""));
    if (href) { box.href = href; }
    box.appendChild(el("span", "akpi-rot", rotulo));
    box.appendChild(el("strong", "akpi-num", valor));
    if (nota) box.appendChild(el("span", "akpi-nota", nota));
    return box;
  }

  function pintar(r) {
    alvo.textContent = "";

    var kpis = el("div", "akpis");
    kpis.appendChild(cartao(
      "Vendas do mês", reais(r.vendas_mes.total),
      r.vendas_mes.n === 1 ? "1 pedido pago" : r.vendas_mes.n + " pedidos pagos"
    ));
    kpis.appendChild(cartao(
      "Aguardando pagamento", String(r.aguardando_pagamento),
      r.aguardando_pagamento ? "Pix ainda não confirmado" : "nada pendente",
      null, r.aguardando_pagamento > 0
    ));
    kpis.appendChild(cartao(
      "Orçamentos novos", String(r.orcamentos_novos),
      r.orcamentos_novos ? "esperando resposta" : "nenhum sem resposta",
      null, r.orcamentos_novos > 0
    ));
    kpis.appendChild(cartao(
      "Esgotados", String(r.esgotados),
      r.esgotados ? "fora do ar na vitrine" : "nenhum produto zerado",
      "/admin/produtos", r.esgotados > 0
    ));
    kpis.appendChild(cartao(
      "Estoque baixo", String(r.estoque_baixo),
      "com " + r.limiar + " ou menos",
      "/admin/produtos", r.estoque_baixo > 0
    ));
    kpis.appendChild(cartao(
      "No ar", String(r.produtos_ativos),
      r.produtos_rascunho ? r.produtos_rascunho + " em rascunho" : "nenhum rascunho",
      "/admin/produtos"
    ));
    alvo.appendChild(kpis);

    // ── Próximos passos: o "setup guide" do Shopify. Só entram tarefas REAIS,
    // que dependem de uma decisão dela — não enfeite motivacional.
    var passos = el("div", "acard-b");
    passos.appendChild(el("h2", "acard-b-title", "Próximos passos"));
    var lista = el("div", "apassos");
    [
      ["Abrir o MEI e ligar o pagamento", "Enquanto isso, a loja capta pedido pelo WhatsApp e o checkout só roda na prévia."],
      ["Cadastrar a passkey neste aparelho", "Entrar com Face ID ou digital, sem depender do e-mail.", "/admin/acesso"],
      ["Preencher CNPJ e WhatsApp reais", "Hoje o rodapé e as páginas legais estão com texto de exemplo."],
      ["Ligar o Cloudflare Web Analytics", "Para saber quantas pessoas entram na loja."],
    ].forEach(function (t) {
      var it = el(t[2] ? "a" : "div", "apasso");
      if (t[2]) it.href = t[2];
      it.appendChild(el("b", null, t[0]));
      it.appendChild(el("span", null, t[1]));
      lista.appendChild(it);
    });
    passos.appendChild(lista);
    alvo.appendChild(passos);
  }

  fetch("/api/admin/resumo")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.ok && d.resumo) pintar(d.resumo);
      else { alvo.textContent = ""; alvo.appendChild(el("p", "ahint", "Não deu para carregar os números agora.")); }
    })
    .catch(function () {
      alvo.textContent = "";
      alvo.appendChild(el("p", "ahint", "Sem conexão com o servidor."));
    });
})();
