/* Vendas no Admin — Pedidos (compras da loja) e Orçamentos (Projeto Exclusivo).
   Anatomia copiada do "Orders" do Shopify / "Vendas" do Nuvemshop: filtros por
   status no topo, lista com nº · data · cliente · total · situação; a linha
   abre o detalhe (?id=uuid).
   REGRA DE OURO deste arquivo: dado do banco SÓ entra na tela via textContent —
   nunca innerHTML. É o que impede um dado malicioso de virar script aqui. */
(function () {
  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  function reais(cents) { return BRL.format((Number(cents) || 0) / 100); }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function dataBr(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) + " · " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function qs(nome) { return new URLSearchParams(location.search).get(nome) || ""; }

  // rótulos e cor (classe) por status — palavras da LOJA, não do gateway
  var ST_COMPRA = {
    aprovado: ["Pago", "ok"],
    pendente: ["Aguardando pagamento", "espera"],
    iniciado: ["Checkout iniciado", "neutro"],
    recusado: ["Recusado", "ruim"],
    cancelado: ["Cancelado", "neutro"],
  };
  var ST_ORC = {
    novo: ["Novo", "espera"],
    respondido: ["Respondido", "neutro"],
    orcado: ["Orçado", "neutro"],
    fechado: ["Fechado", "ok"],
    perdido: ["Perdido", "ruim"],
  };
  function badge(mapa, st) {
    var par = mapa[st] || [st || "—", "neutro"];
    return el("span", "abadge abadge-" + par[1], par[0]);
  }
  function filtros(pares, ativo, aoTrocar) {
    var row = el("div", "afiltros");
    pares.forEach(function (p) {
      var b = el("button", "afiltro" + (p[0] === ativo ? " on" : ""), p[1]);
      b.type = "button";
      b.addEventListener("click", function () { aoTrocar(p[0]); });
      row.appendChild(b);
    });
    return row;
  }
  function cabecalho(cont, titulo, sub, voltarHref, voltarRotulo) {
    var head = el("div", "apage-head");
    var box = el("div");
    if (voltarHref) {
      var v = el("a", "apage-sub-link", "← " + voltarRotulo);
      v.href = voltarHref;
      box.appendChild(v);
    }
    box.appendChild(el("h1", null, titulo));
    if (sub != null) box.appendChild(el("p", "apage-sub", sub));
    head.appendChild(box);
    cont.appendChild(head);
    return head;
  }
  function vazio(msg) { return el("div", "avazio", msg); }
  function linhaDado(rotulo, valor) {
    var d = el("div", "adado");
    d.appendChild(el("span", "adado-r", rotulo));
    d.appendChild(el("span", "adado-v", valor == null || valor === "" ? "—" : String(valor)));
    return d;
  }

  // ── PEDIDOS (compras) — lista; também veste "Carrinhos abandonados"
  //    (status 'iniciado': checkout começado e não pago — no Shopify é uma
  //    tela própria, então aqui também) ─────────────────────────────────────
  function telaPedidos(cont, abandonados) {
    var filtro = abandonados ? "iniciado" : qs("filtro");
    cont.textContent = "";
    cabecalho(cont, abandonados ? "Carrinhos abandonados" : "Pedidos", "Carregando…");
    if (!abandonados) {
      cont.appendChild(filtros(
        [["", "Todos"], ["aprovado", "Pagos"], ["pendente", "Aguardando"], ["recusado", "Recusados"], ["cancelado", "Cancelados"]],
        filtro,
        function (f) { location.href = "/admin/pedidos" + (f ? "?filtro=" + f : ""); }
      ));
    }
    var lista = el("div", "alista");
    cont.appendChild(lista);
    fetch("/api/admin/compras" + (filtro ? "?filtro=" + encodeURIComponent(filtro) : ""))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var compras = (d && d.compras) || [];
        var coisa = abandonados ? "carrinho" : "pedido";
        cont.querySelector(".apage-sub").textContent =
          compras.length === 0 ? "Nenhum " + coisa + " por aqui ainda." :
          compras.length === 1 ? "1 " + coisa : compras.length + " " + coisa + "s";
        if (!compras.length) {
          lista.appendChild(vazio(abandonados
            ? "Checkout começado e não pago aparece aqui — é a lista de quem quase comprou."
            : "Quando alguém comprar na loja, o pedido aparece aqui."));
          return;
        }
        compras.forEach(function (c) {
          var a = el("a", "aitem avenda");
          a.href = "/admin/pedido?id=" + encodeURIComponent(c.id);
          var esq = el("div");
          esq.appendChild(el("div", "aitem-nome", c.ref));
          var meta = el("div", "aitem-meta");
          meta.appendChild(el("span", null, dataBr(c.criado_em)));
          meta.appendChild(el("span", null, c.contato_email || "—"));
          meta.appendChild(el("span", null, c.qtd_itens === 1 ? "1 item" : c.qtd_itens + " itens"));
          esq.appendChild(meta);
          var dir = el("div", "aitem-side");
          dir.appendChild(el("b", null, reais(c.total)));
          dir.appendChild(badge(ST_COMPRA, c.status));
          a.appendChild(esq);
          a.appendChild(dir);
          lista.appendChild(a);
        });
      })
      .catch(function () { lista.appendChild(vazio("Não deu para carregar. Recarregue a página.")); });
  }

  // ── PEDIDO (compra) — detalhe ─────────────────────────────────────────────
  function telaPedido(cont) {
    var id = qs("id");
    cont.textContent = "";
    if (!id) { location.href = "/admin/pedidos"; return; }
    fetch("/api/admin/compra?id=" + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { cont.appendChild(vazio("Pedido não encontrado.")); return; }
        var c = d.compra;
        var head = cabecalho(cont, c.ref, dataBr(c.criado_em), "/admin/pedidos", "Pedidos");
        head.appendChild(badge(ST_COMPRA, c.status));

        // itens
        var sec = el("div", "asec");
        sec.appendChild(el("div", "asec-title", "Itens"));
        (c.itens || []).forEach(function (i) {
          var row = el("div", "avenda-item");
          var nome = (i.nome || "Produto fora do catálogo") + (i.tam ? " · " + i.tam : "");
          row.appendChild(el("span", null, i.qtd + " × " + nome));
          row.appendChild(el("b", null, reais((i.preco_unit || 0) * (i.qtd || 0))));
          sec.appendChild(row);
        });
        var tot = el("div", "avenda-totais");
        tot.appendChild(linhaDado("Subtotal", reais(c.subtotal)));
        tot.appendChild(linhaDado("Frete", reais(c.frete)));
        if (c.desconto) tot.appendChild(linhaDado("Desconto", "− " + reais(c.desconto)));
        var t = linhaDado("Total", reais(c.total));
        t.className = "adado adado-total";
        tot.appendChild(t);
        sec.appendChild(tot);
        cont.appendChild(sec);

        // pagamento
        var pag = el("div", "asec");
        pag.appendChild(el("div", "asec-title", "Pagamento"));
        pag.appendChild(linhaDado("Método", c.metodo === "pix" ? "Pix" : "Cartão" + (c.parcelas > 1 ? " · " + c.parcelas + "×" : "")));
        pag.appendChild(linhaDado("Mercado Pago", c.mp_payment_id));
        pag.appendChild(linhaDado("Estoque", c.estoque_baixado ? "baixado" : "ainda não baixado"));
        cont.appendChild(pag);

        // cliente — o bloco de PII: só existe NESTA tela, atrás da sessão
        var cli = el("div", "asec");
        cli.appendChild(el("div", "asec-title", "Cliente"));
        cli.appendChild(linhaDado("E-mail", c.contato_email));
        cli.appendChild(linhaDado("WhatsApp", c.contato_whats));
        cli.appendChild(linhaDado("CPF", c.cpf));
        if (c.endereco) {
          var e = c.endereco;
          var linhaEnd = [e.logradouro || e.rua, e.numero, e.complemento, e.bairro, e.cidade, e.uf, e.cep]
            .filter(Boolean).join(", ");
          cli.appendChild(linhaDado("Endereço", linhaEnd));
        }
        cli.appendChild(linhaDado("Consentimento", c.consentiu ? "sim" : "não"));
        cont.appendChild(cli);
      })
      .catch(function () { cont.appendChild(vazio("Não deu para carregar. Recarregue a página.")); });
  }

  // ── ORÇAMENTOS — lista ────────────────────────────────────────────────────
  function telaOrcamentos(cont) {
    var filtro = qs("filtro");
    cont.textContent = "";
    cabecalho(cont, "Orçamentos", "Carregando…");
    cont.appendChild(filtros(
      [["", "Todos"], ["novo", "Novos"], ["respondido", "Respondidos"], ["orcado", "Orçados"], ["fechado", "Fechados"], ["perdido", "Perdidos"]],
      filtro,
      function (f) { location.href = "/admin/orcamentos" + (f ? "?filtro=" + f : ""); }
    ));
    var lista = el("div", "alista");
    cont.appendChild(lista);
    fetch("/api/admin/orcamentos" + (filtro ? "?filtro=" + encodeURIComponent(filtro) : ""))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var orcs = (d && d.orcamentos) || [];
        cont.querySelector(".apage-sub").textContent =
          orcs.length === 0 ? "Nenhum orçamento por aqui ainda." :
          orcs.length === 1 ? "1 orçamento" : orcs.length + " orçamentos";
        if (!orcs.length) { lista.appendChild(vazio("Os pedidos do Projeto Exclusivo chegam aqui.")); return; }
        orcs.forEach(function (o) {
          var a = el("a", "aitem avenda");
          a.href = "/admin/orcamento?id=" + encodeURIComponent(o.id);
          var esq = el("div");
          esq.appendChild(el("div", "aitem-nome", o.ref + (o.nome ? " · " + o.nome : "")));
          var meta = el("div", "aitem-meta");
          meta.appendChild(el("span", null, dataBr(o.criado_em)));
          meta.appendChild(el("span", null, o.contato || "—"));
          if (o.qtd_anexos) meta.appendChild(el("span", null, o.qtd_anexos === 1 ? "1 anexo" : o.qtd_anexos + " anexos"));
          esq.appendChild(meta);
          var dir = el("div", "aitem-side");
          dir.appendChild(badge(ST_ORC, o.status));
          a.appendChild(esq);
          a.appendChild(dir);
          lista.appendChild(a);
        });
      })
      .catch(function () { lista.appendChild(vazio("Não deu para carregar. Recarregue a página.")); });
  }

  // ── ORÇAMENTO — detalhe ───────────────────────────────────────────────────
  function telaOrcamento(cont) {
    var id = qs("id");
    cont.textContent = "";
    if (!id) { location.href = "/admin/orcamentos"; return; }
    fetch("/api/admin/orcamento?id=" + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { cont.appendChild(vazio("Orçamento não encontrado.")); return; }
        var o = d.orcamento;
        var head = cabecalho(cont, o.ref + (o.nome ? " · " + o.nome : ""), dataBr(o.criado_em), "/admin/orcamentos", "Orçamentos");
        head.appendChild(badge(ST_ORC, o.status));

        // status — os mesmos passos do funil, um clique cada
        var st = el("div", "asec");
        st.appendChild(el("div", "asec-title", "Situação"));
        var row = el("div", "afiltros");
        ["novo", "respondido", "orcado", "fechado", "perdido"].forEach(function (s) {
          var b = el("button", "afiltro" + (o.status === s ? " on" : ""), ST_ORC[s][0]);
          b.type = "button";
          b.disabled = o.status === s;
          b.addEventListener("click", function () {
            fetch("/api/admin/orcamento/status", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: o.id, status: s }),
            }).then(function (r) { return r.json(); }).then(function (rr) {
              if (rr && rr.ok) location.reload();
            });
          });
          row.appendChild(b);
        });
        st.appendChild(row);
        if (o.respondido_em) st.appendChild(linhaDado("Respondido em", dataBr(o.respondido_em)));
        cont.appendChild(st);

        // o pedido em si
        var ped = el("div", "asec");
        ped.appendChild(el("div", "asec-title", "Pedido"));
        if (o.brief) {
          var b = el("p", "abrief");
          b.textContent = o.brief; // textContent: brief é texto do cliente
          ped.appendChild(b);
        } else {
          ped.appendChild(el("p", "apage-sub", "Sem briefing — só o contato."));
        }
        if (o.anexos && o.anexos.length) {
          var ax = el("div", "aanexos");
          o.anexos.forEach(function (a) {
            var l = el("a", "aanexo", a.name || "anexo");
            l.href = a.url; // link já assinado pelo servidor (HMAC)
            l.target = "_blank";
            l.rel = "noopener";
            ax.appendChild(l);
          });
          ped.appendChild(ax);
        }
        cont.appendChild(ped);

        // contato — o bloco de PII
        var cli = el("div", "asec");
        cli.appendChild(el("div", "asec-title", "Contato"));
        cli.appendChild(linhaDado("Nome", o.nome));
        cli.appendChild(linhaDado("Contato", o.contato));
        cli.appendChild(linhaDado("Origem", o.origem));
        cli.appendChild(linhaDado("Consentimento", o.consentiu ? "sim (" + (o.consent_versao || "?") + ")" : "não"));
        cont.appendChild(cli);
      })
      .catch(function () { cont.appendChild(vazio("Não deu para carregar. Recarregue a página.")); });
  }

  var alvo;
  if ((alvo = document.getElementById("pedidos"))) telaPedidos(alvo);
  else if ((alvo = document.getElementById("abandonados"))) telaPedidos(alvo, true);
  else if ((alvo = document.getElementById("pedido"))) telaPedido(alvo);
  else if ((alvo = document.getElementById("orcamentos"))) telaOrcamentos(alvo);
  else if ((alvo = document.getElementById("orcamento"))) telaOrcamento(alvo);
})();
