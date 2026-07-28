/* Configurações da loja — regras que valem para a loja inteira, não para um
   produto. Anatomia do "Settings" do Shopify: seções por assunto, e cada regra
   com o efeito explicado do lado (aqui, mostrando o selo que ela produz).
   DOM/textContent sempre; nunca innerHTML com dado do banco. */
(function () {
  var raiz = document.getElementById("config");
  if (!raiz) return;

  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function card(titulo) {
    var c = el("div", "acard-b");
    if (titulo) c.appendChild(el("h2", "acard-b-title", titulo));
    return c;
  }

  var cfg = { limiar_ultimas_unidades: 8 };

  function pintar() {
    raiz.textContent = "";

    var head = el("div", "apage-head");
    var tit = el("div");
    var volta = el("a", "apage-sub-link", "← Admin");
    volta.href = "/admin";
    tit.appendChild(volta);
    tit.appendChild(el("h1", null, "Configurações"));
    head.appendChild(tit);
    var acoes = el("div", "apage-acoes");
    var salvar = el("button", "btn", "Salvar");
    salvar.type = "button";
    acoes.appendChild(salvar);
    head.appendChild(acoes);
    raiz.appendChild(head);

    var cols = el("div", "acols");
    var main = el("div", "acol-main");
    var side = el("div", "acol-side");
    cols.appendChild(main); cols.appendChild(side);
    raiz.appendChild(cols);

    // ── Vitrine
    var cV = card("Vitrine");
    var lim = document.createElement("input");
    lim.type = "number"; lim.min = "1"; lim.max = "99";
    lim.value = cfg.limiar_ultimas_unidades;
    var campo = el("label", "afield");
    campo.appendChild(el("span", null, "Avisar “Últimas unidades” a partir de"));
    campo.appendChild(lim);
    var dica = el("small", "ahint");
    campo.appendChild(dica);
    cV.appendChild(campo);

    // O efeito da regra, escrito por extenso: é o que evita descobrir o número
    // errado só depois, olhando a loja.
    var exemplo = el("div", "aprev");
    exemplo.appendChild(el("div", "aprev-tit", "Como fica na loja"));
    var selos = el("div", "aprev-selos");
    exemplo.appendChild(selos);
    var regra = el("p", "ahint");
    exemplo.appendChild(regra);
    cV.appendChild(exemplo);
    main.appendChild(cV);

    function atualiza() {
      var n = Math.round(Number(lim.value) || 0);
      var valido = n >= 1 && n <= 99;
      dica.textContent = valido
        ? "Vale para todos os produtos. Para peça artesanal em tiragem pequena, um número baixo (3) deixa o aviso mais verdadeiro."
        : "Escolha um número de 1 a 99. Estoque zero já tem o selo próprio (“Esgotado”).";
      dica.classList.toggle("ahint-err", !valido);
      lim.classList.toggle("ainp-err", !valido);
      selos.textContent = "";
      regra.textContent = "";
      if (!valido) return;
      // só os selos que a loja MOSTRA de verdade — "Edição limitada" está oculto
      // por CSS na vitrine (toda peça é de tiragem limitada; a tag era redundante)
      selos.appendChild(el("span", "aprev-selo", "Esgotado"));
      selos.appendChild(el("span", "aprev-selo", "Últimas unidades"));
      regra.textContent =
        "Esgotado com 0 · Últimas unidades de 1 a " + n + " · a partir de " + (n + 1) + " a peça aparece sem selo.";
      return valido;
    }
    lim.addEventListener("input", atualiza);
    atualiza();

    var msg = el("div", "amsg"); msg.hidden = true;
    side.appendChild(msg);
    function aviso(t, erro) { msg.hidden = false; msg.className = erro ? "amsg err" : "amsg"; msg.textContent = t; }

    salvar.addEventListener("click", function () {
      var n = Math.round(Number(lim.value) || 0);
      if (!(n >= 1 && n <= 99)) { aviso("Escolha um número de 1 a 99.", true); lim.focus(); return; }
      salvar.disabled = true; salvar.textContent = "Salvando…";
      fetch("/api/admin/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limiar_ultimas_unidades: n }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          salvar.disabled = false; salvar.textContent = "Salvar";
          if (d && d.ok) { cfg = d.config; aviso("Configurações salvas. A loja passa a usar esse limite."); }
          else aviso("Não deu para salvar.", true);
        })
        .catch(function () { salvar.disabled = false; salvar.textContent = "Salvar"; aviso("Falha de rede.", true); });
    });
  }

  fetch("/api/admin/config")
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.ok && d.config) cfg = d.config; })
    .catch(function () { /* fica no padrão */ })
    .then(pintar);
})();
