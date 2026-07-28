/* Catálogo no Admin — lista de produtos e formulário de edição.
   Tudo montado com DOM (textContent), nunca innerHTML com dado do banco.
   Preço: a pessoa digita em REAIS; o servidor recebe CENTAVOS (conversão aqui). */
(function () {
  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function reais(cents) { return BRL.format((Number(cents) || 0) / 100); }
  // "123,45" ou "123.45" → 12345 centavos
  function paraCents(str) {
    var s = String(str == null ? "" : str).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
    var n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function deCents(cents) {
    if (cents == null || cents === "") return "";
    return ((Number(cents) || 0) / 100).toFixed(2).replace(".", ",");
  }
  function campo(rotulo, input) {
    var l = el("label", "afield");
    l.appendChild(el("span", null, rotulo));
    l.appendChild(input);
    return l;
  }
  function inp(tipo, valor, ph) {
    var i = document.createElement("input");
    i.type = tipo || "text";
    if (valor != null) i.value = valor;
    if (ph) i.placeholder = ph;
    return i;
  }

  // ── LISTA ────────────────────────────────────────────────────────────────
  function renderLista() {
    var alvo = document.getElementById("lista");
    var cont = document.getElementById("contagem");
    fetch("/api/admin/produtos").then(function (r) { return r.json(); }).then(function (d) {
      var ps = (d && d.produtos) || [];
      cont.textContent = ps.length === 1 ? "1 produto" : ps.length + " produtos";
      alvo.textContent = "";
      if (!ps.length) {
        var v = el("div", "avazio");
        v.appendChild(el("p", null, "Nenhum produto ainda."));
        var a = el("a", "btn", "Cadastrar o primeiro");
        a.href = "/admin/produto";
        v.appendChild(a);
        alvo.appendChild(v);
        return;
      }
      ps.forEach(function (p) {
        var linha = el("a", "aitem");
        linha.href = "/admin/produto?id=" + encodeURIComponent(p.id);
        var esq = el("div", "aitem-main");
        esq.appendChild(el("div", "aitem-nome", p.nome));
        var meta = el("div", "aitem-meta");
        meta.appendChild(el("span", null, reais(p.preco_promo || p.preco)));
        if (p.preco_promo) meta.appendChild(el("span", "aitem-de", reais(p.preco)));
        meta.appendChild(el("span", null, p.n_variantes + (p.n_variantes === 1 ? " variação" : " variações")));
        esq.appendChild(meta);
        linha.appendChild(esq);
        var dir = el("div", "aitem-side");
        var est = Number(p.estoque_total) || 0;
        dir.appendChild(el("span", "achip " + (est === 0 ? "achip-off" : est <= 3 ? "achip-low" : "achip-ok"),
          est === 0 ? "esgotado" : est + " em estoque"));
        dir.appendChild(el("span", "achip achip-" + p.status, p.status));
        linha.appendChild(dir);
        alvo.appendChild(linha);
      });
    });
  }

  // ── FORMULÁRIO ───────────────────────────────────────────────────────────
  function renderForm() {
    var raiz = document.getElementById("form");
    var id = new URLSearchParams(location.search).get("id") || "";
    var novo = !id;
    var p = { id: "", nome: "", slug: "", descricao: "", status: "rascunho", destaque: 0, ordem: 0, preco: 0, preco_promo: null, opcoes: [], variantes: [] };

    function pintar() {
      raiz.textContent = "";
      var head = el("div", "apage-head");
      var tit = el("div");
      tit.appendChild(el("h1", null, novo ? "Novo produto" : p.nome || "Produto"));
      var volta = el("a", "apage-sub-link", "← Todos os produtos");
      volta.href = "/admin/produtos";
      tit.appendChild(volta);
      head.appendChild(tit);
      raiz.appendChild(head);

      // básico
      var s1 = el("section", "asec");
      s1.appendChild(el("h2", "asec-title", "Básico"));
      var iNome = inp("text", p.nome, "Tablete Seigaiha");
      s1.appendChild(campo("Nome", iNome));
      var iDesc = document.createElement("textarea");
      iDesc.rows = 4; iDesc.value = p.descricao || "";
      s1.appendChild(campo("Descrição", iDesc));
      var iStatus = document.createElement("select");
      [["rascunho", "Rascunho (não aparece na loja)"], ["ativo", "Ativo (à venda)"], ["arquivado", "Arquivado"]].forEach(function (o) {
        var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1];
        if (p.status === o[0]) op.selected = true; iStatus.appendChild(op);
      });
      s1.appendChild(campo("Situação", iStatus));
      raiz.appendChild(s1);

      // preço
      var s2 = el("section", "asec");
      s2.appendChild(el("h2", "asec-title", "Preço"));
      var iPreco = inp("text", deCents(p.preco), "0,00");
      iPreco.inputMode = "decimal";
      s2.appendChild(campo("Preço (R$)", iPreco));
      var iPromo = inp("text", deCents(p.preco_promo), "vazio = sem promoção");
      iPromo.inputMode = "decimal";
      s2.appendChild(campo("Preço promocional (R$)", iPromo));
      s2.appendChild(el("p", "ahint", "Com promoção, a loja mostra o preço cheio riscado. Precisa ser menor que o preço."));
      raiz.appendChild(s2);

      // variação
      var s3 = el("section", "asec");
      s3.appendChild(el("h2", "asec-title", "Variação"));
      s3.appendChild(el("p", "ahint", "Dê um nome ao tipo (Tamanho, Cor, Sabor…) e liste os valores separados por vírgula. Sem variação, o produto é peça única."));
      var opWrap = el("div", "aops");
      s3.appendChild(opWrap);
      var addOp = el("button", "btn ghost abtn-full", "Adicionar tipo de variação");
      addOp.type = "button";
      s3.appendChild(addOp);
      raiz.appendChild(s3);

      // variantes
      var s4 = el("section", "asec");
      s4.appendChild(el("h2", "asec-title", "Estoque e envio"));
      s4.appendChild(el("p", "ahint", "Cada combinação tem estoque, peso e medidas próprios — é o que calcula o frete e gera a etiqueta."));
      var varWrap = el("div", "avars");
      s4.appendChild(varWrap);
      raiz.appendChild(s4);

      // salvar
      var s5 = el("section", "asec");
      var msg = el("div", "amsg"); msg.hidden = true;
      s5.appendChild(msg);
      var salvar = el("button", "btn abtn-full", "Salvar produto");
      salvar.type = "button";
      s5.appendChild(salvar);
      raiz.appendChild(s5);

      // ---- opções
      function pintarOpcoes() {
        opWrap.textContent = "";
        p.opcoes.forEach(function (o, idx) {
          var box = el("div", "aop");
          var iN = inp("text", o.nome, "Tamanho");
          box.appendChild(campo("Tipo", iN));
          var iV = inp("text", (o.valores || []).join(", "), "Pequeno, Médio, Grande");
          box.appendChild(campo("Valores", iV));
          var rm = el("button", "apk-rm", "remover");
          rm.type = "button";
          rm.addEventListener("click", function () { p.opcoes.splice(idx, 1); sincroniza(); });
          box.appendChild(rm);
          iN.addEventListener("input", function () { o.nome = iN.value; });
          iV.addEventListener("change", function () {
            o.valores = iV.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
            sincroniza();
          });
          opWrap.appendChild(box);
        });
      }
      addOp.addEventListener("click", function () {
        if (p.opcoes.length >= 2) return;
        p.opcoes.push({ nome: "", valores: [] });
        sincroniza();
      });

      // ---- variantes: produto cartesiano das opções, preservando o que já existe
      function combinacoes() {
        var ops = p.opcoes.filter(function (o) { return o.nome && (o.valores || []).length; });
        if (!ops.length) return [{}];
        var res = [{}];
        ops.forEach(function (o) {
          var novo = [];
          res.forEach(function (base) {
            o.valores.forEach(function (v) {
              var c = {};
              Object.keys(base).forEach(function (k) { c[k] = base[k]; });
              c[o.nome] = v;
              novo.push(c);
            });
          });
          res = novo;
        });
        return res;
      }
      function chave(c) { return JSON.stringify(c); }
      function sincroniza() {
        var combos = combinacoes();
        var antigas = {};
        p.variantes.forEach(function (v) { antigas[chave(v.combinacao || {})] = v; });
        p.variantes = combos.map(function (c) {
          return antigas[chave(c)] || { combinacao: c, preco: null, preco_promo: null, estoque: 0, peso_g: 0, comp_cm: 0, larg_cm: 0, alt_cm: 0, ativo: true };
        });
        pintarOpcoes();
        pintarVariantes();
      }
      function rotuloCombo(c) {
        var ks = Object.keys(c);
        return ks.length ? ks.map(function (k) { return c[k]; }).join(" · ") : "Peça única";
      }
      function pintarVariantes() {
        varWrap.textContent = "";
        p.variantes.forEach(function (v) {
          var box = el("div", "avar");
          box.appendChild(el("div", "avar-nome", rotuloCombo(v.combinacao || {})));
          var g = el("div", "agrid");
          function add(rot, tipo, val, set, ph) {
            var i = inp(tipo, val, ph);
            if (tipo === "text") i.inputMode = "decimal";
            i.addEventListener("input", function () { set(i.value); });
            g.appendChild(campo(rot, i));
          }
          add("Preço (R$)", "text", deCents(v.preco), function (x) { v.preco = x === "" ? null : paraCents(x); }, "herda");
          add("Estoque", "number", v.estoque, function (x) { v.estoque = Number(x) || 0; });
          add("Peso (g)", "number", v.peso_g, function (x) { v.peso_g = Number(x) || 0; });
          add("Compr. (cm)", "number", v.comp_cm, function (x) { v.comp_cm = Number(x) || 0; });
          add("Larg. (cm)", "number", v.larg_cm, function (x) { v.larg_cm = Number(x) || 0; });
          add("Alt. (cm)", "number", v.alt_cm, function (x) { v.alt_cm = Number(x) || 0; });
          box.appendChild(g);
          varWrap.appendChild(box);
        });
      }

      salvar.addEventListener("click", function () {
        p.nome = iNome.value; p.descricao = iDesc.value; p.status = iStatus.value;
        p.preco = paraCents(iPreco.value);
        p.preco_promo = iPromo.value.trim() === "" ? null : paraCents(iPromo.value);
        salvar.disabled = true; salvar.textContent = "Salvando…";
        fetch("/api/admin/produto", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: p.id || "", nome: p.nome, slug: p.slug, descricao: p.descricao, status: p.status, destaque: p.destaque, ordem: p.ordem, preco: p.preco, preco_promo: p.preco_promo, opcoes: p.opcoes, variantes: p.variantes }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          salvar.disabled = false; salvar.textContent = "Salvar produto";
          msg.hidden = false;
          if (d && d.ok) {
            msg.className = "amsg"; msg.textContent = "Produto salvo.";
            if (!p.id) { p.id = d.id; history.replaceState(null, "", "/admin/produto?id=" + encodeURIComponent(d.id)); }
          } else {
            msg.className = "amsg err";
            msg.textContent = d && d.erro === "promo_maior" ? "O preço promocional precisa ser menor que o preço." :
              d && d.erro === "nome" ? "Dê um nome ao produto." : "Não deu para salvar agora.";
          }
        }).catch(function () {
          salvar.disabled = false; salvar.textContent = "Salvar produto";
          msg.hidden = false; msg.className = "amsg err"; msg.textContent = "Falha de rede.";
        });
      });

      sincroniza();
    }

    if (novo) { pintar(); return; }
    fetch("/api/admin/produto?id=" + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) {
        var x = d.produto;
        p = { id: x.id, nome: x.nome, slug: x.slug, descricao: x.descricao || "", status: x.status, destaque: x.destaque, ordem: x.ordem, preco: x.preco, preco_promo: x.preco_promo, opcoes: x.opcoes || [], variantes: (x.variantes || []).map(function (v) { return { id: v.id, combinacao: v.combinacao, preco: v.preco, preco_promo: v.preco_promo, estoque: v.estoque, peso_g: v.peso_g, comp_cm: v.comp_cm, larg_cm: v.larg_cm, alt_cm: v.alt_cm, ativo: !!v.ativo }; }) };
      }
      pintar();
    });
  }

  if (document.getElementById("lista")) renderLista();
  if (document.getElementById("form")) renderForm();
})();
