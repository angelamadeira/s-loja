/* Formulário de produto — anatomia do admin do Shopify (padrão de mercado),
   traduzida para a linguagem da Suzu. Nada inventado aqui: duas colunas
   (conteúdo + barra lateral), cards por assunto, valores de opção em CHIPS e
   tabela de variantes editável na linha. Quando há variantes, os cards de
   Preço/Estoque/Envio somem — os valores passam a viver na tabela (é o que o
   Shopify faz, pra não ter dois lugares dizendo o preço).
   DOM/textContent sempre; nunca innerHTML com dado do banco. */
(function () {
  var raiz = document.getElementById("form");
  if (!raiz) return;

  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function paraCents(s) {
    var v = String(s == null ? "" : s).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
    var n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function deCents(c) { return c == null || c === "" ? "" : ((Number(c) || 0) / 100).toFixed(2).replace(".", ","); }
  function inp(tipo, val, ph) {
    var i = document.createElement("input"); i.type = tipo || "text";
    if (val != null) i.value = val; if (ph) i.placeholder = ph;
    return i;
  }
  function campo(rot, input, dica) {
    var l = el("label", "afield");
    l.appendChild(el("span", null, rot));
    l.appendChild(input);
    if (dica) l.appendChild(el("small", "ahint", dica));
    return l;
  }
  function card(titulo) {
    var c = el("div", "acard-b");
    if (titulo) c.appendChild(el("h2", "acard-b-title", titulo));
    return c;
  }

  var id = new URLSearchParams(location.search).get("id") || "";
  var novo = !id;
  var p = {
    id: "", nome: "", descricao: "", status: "rascunho",
    preco: 0, preco_promo: null, estoque: 0, peso_g: 0, comp_cm: 0, larg_cm: 0, alt_cm: 0,
    opcoes: [], variantes: [], categorias: [], galeria: [],
  };
  var categoriasTodas = [];

  // ── monta a página ────────────────────────────────────────────────────────
  function pintar() {
    raiz.textContent = "";

    var head = el("div", "apage-head");
    var tit = el("div");
    var volta = el("a", "apage-sub-link", "← Produtos");
    volta.href = "/admin/produtos";
    tit.appendChild(volta);
    tit.appendChild(el("h1", null, novo ? "Novo produto" : p.nome || "Produto"));
    head.appendChild(tit);
    var salvar = el("button", "btn", "Salvar");
    salvar.type = "button";
    head.appendChild(salvar);
    raiz.appendChild(head);

    var cols = el("div", "acols");
    var main = el("div", "acol-main");
    var side = el("div", "acol-side");
    cols.appendChild(main); cols.appendChild(side);
    raiz.appendChild(cols);

    // ── Básico
    var cB = card();
    var iNome = inp("text", p.nome, "Tablete Seigaiha");
    cB.appendChild(campo("Nome", iNome));
    var iDesc = document.createElement("textarea");
    iDesc.rows = 5; iDesc.value = p.descricao || "";
    cB.appendChild(campo("Descrição", iDesc));
    main.appendChild(cB);

    // ── Mídia
    var cM = card("Mídia");
    var gal = el("div", "agal"); cM.appendChild(gal);
    var fInp = document.createElement("input");
    fInp.type = "file"; fInp.accept = "image/*,video/*"; fInp.hidden = true;
    var bUp = el("button", "btn ghost abtn-full", "Adicionar imagem ou vídeo");
    bUp.type = "button";
    bUp.addEventListener("click", function () { fInp.click(); });
    fInp.addEventListener("change", function () {
      var f = fInp.files && fInp.files[0]; if (!f) return;
      bUp.disabled = true; bUp.textContent = "Enviando…";
      var fd = new FormData(); fd.append("arquivo", f);
      fetch("/api/admin/midia", { method: "POST", body: fd })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          bUp.disabled = false; bUp.textContent = "Adicionar imagem ou vídeo"; fInp.value = "";
          if (d && d.ok) { p.galeria.push({ asset_id: d.id, tipo: d.tipo }); pintarGaleria(); }
          else aviso(d && d.erro === "grande" ? "Arquivo grande demais (imagem até 10 MB, vídeo até 50 MB)." : "Não deu para enviar.", true);
        })
        .catch(function () { bUp.disabled = false; bUp.textContent = "Adicionar imagem ou vídeo"; aviso("Falha no envio.", true); });
    });
    cM.appendChild(bUp); cM.appendChild(fInp);
    cM.appendChild(el("p", "ahint", "A primeira mídia é a capa que aparece na vitrine."));
    main.appendChild(cM);
    function pintarGaleria() {
      gal.textContent = "";
      p.galeria.forEach(function (g, i) {
        var cel = el("div", "agal-item");
        var m;
        if (String(g.tipo || "").indexOf("video") === 0) {
          m = document.createElement("video");
          m.src = "/midia/" + g.asset_id; m.muted = true; m.loop = true; m.autoplay = true; m.playsInline = true;
        } else { m = document.createElement("img"); m.src = "/midia/" + g.asset_id; m.alt = ""; }
        cel.appendChild(m);
        if (i === 0) cel.appendChild(el("span", "agal-capa", "capa"));
        var rm = el("button", "agal-rm", "×"); rm.type = "button"; rm.title = "remover";
        rm.addEventListener("click", function () { p.galeria.splice(i, 1); pintarGaleria(); });
        cel.appendChild(rm);
        gal.appendChild(cel);
      });
    }

    // ── Preço / Estoque / Envio (somem quando há variantes — padrão Shopify)
    var cP = card("Preço");
    var iPreco = inp("text", deCents(p.preco), "0,00"); iPreco.inputMode = "decimal";
    var iComp = inp("text", deCents(p.preco_promo), "sem promoção"); iComp.inputMode = "decimal";
    var gp = el("div", "agrid2");
    gp.appendChild(campo("Preço (R$)", iPreco, "Preço cheio, de tabela."));
    gp.appendChild(campo("Preço promocional (R$)", iComp, "O que a cliente paga. Menor que o preço — a loja mostra o cheio riscado. Vazio = sem promoção."));
    cP.appendChild(gp);
    main.appendChild(cP);

    var cE = card("Estoque");
    var iEst = inp("number", p.estoque);
    cE.appendChild(campo("Quantidade", iEst));
    main.appendChild(cE);

    var cS = card("Envio");
    var iPeso = inp("number", p.peso_g), iC = inp("number", p.comp_cm), iL = inp("number", p.larg_cm), iA = inp("number", p.alt_cm);
    var gs = el("div", "agrid");
    gs.appendChild(campo("Peso (g)", iPeso));
    gs.appendChild(campo("Compr. (cm)", iC));
    gs.appendChild(campo("Larg. (cm)", iL));
    gs.appendChild(campo("Alt. (cm)", iA));
    cS.appendChild(gs);
    cS.appendChild(el("p", "ahint", "Usado para cotar o frete e gerar a etiqueta."));
    main.appendChild(cS);

    // ── Variações (opções com CHIPS + tabela de variantes)
    var cV = card("Variações");
    var opsWrap = el("div", "aops"); cV.appendChild(opsWrap);
    var addOp = el("button", "alink", "+ Adicionar opção como tamanho ou cor");
    addOp.type = "button";
    addOp.addEventListener("click", function () {
      if (p.opcoes.length >= 2) return;
      p.opcoes.push({ nome: "", valores: [] });
      pintarOpcoes(); regenera();
    });
    cV.appendChild(addOp);
    var tabWrap = el("div", "avtab"); cV.appendChild(tabWrap);
    main.appendChild(cV);

    // ── barra lateral: Situação + Organização
    var cSt = card("Situação");
    var iStatus = document.createElement("select");
    [["ativo", "Ativo"], ["rascunho", "Rascunho"], ["arquivado", "Arquivado"]].forEach(function (o) {
      var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1];
      if (p.status === o[0]) op.selected = true; iStatus.appendChild(op);
    });
    cSt.appendChild(iStatus);
    cSt.appendChild(el("p", "ahint", "Rascunho não aparece na loja."));
    side.appendChild(cSt);

    var cO = card("Organização");
    var catWrap = el("div", "acats"); cO.appendChild(catWrap);
    var linkCat = el("a", "alink", "Gerenciar categorias →");
    linkCat.href = "/admin/categorias";
    cO.appendChild(linkCat);
    side.appendChild(cO);
    pintarCategorias();

    var msg = el("div", "amsg"); msg.hidden = true;
    side.appendChild(msg);
    function aviso(t, erro) { msg.hidden = false; msg.className = erro ? "amsg err" : "amsg"; msg.textContent = t; }

    // ── opções com CHIPS (digita, Enter vira etiqueta) ──────────────────────
    function pintarOpcoes() {
      opsWrap.textContent = "";
      p.opcoes.forEach(function (o, idx) {
        var box = el("div", "aop");
        var iN = inp("text", o.nome, "Tamanho");
        iN.addEventListener("input", function () { o.nome = iN.value; regenera(); });
        box.appendChild(campo("Nome da opção", iN));

        var chips = el("div", "achips");
        function pintarChips() {
          chips.textContent = "";
          o.valores.forEach(function (v, vi) {
            var ch = el("span", "achip-tag", v);
            var x = el("button", "achip-x", "×"); x.type = "button";
            x.addEventListener("click", function () { o.valores.splice(vi, 1); pintarChips(); regenera(); });
            ch.appendChild(x); chips.appendChild(ch);
          });
          var iV = inp("text", "", o.valores.length ? "adicionar" : "Médio");
          iV.className = "achip-inp";
          iV.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              var v = iV.value.trim();
              if (v && o.valores.indexOf(v) < 0) { o.valores.push(v); pintarChips(); regenera(); chips.querySelector(".achip-inp").focus(); }
            } else if (e.key === "Backspace" && !iV.value && o.valores.length) {
              o.valores.pop(); pintarChips(); regenera(); chips.querySelector(".achip-inp").focus();
            }
          });
          iV.addEventListener("blur", function () {
            var v = iV.value.trim();
            if (v && o.valores.indexOf(v) < 0) { o.valores.push(v); pintarChips(); regenera(); }
          });
          chips.appendChild(iV);
        }
        pintarChips();
        var lv = el("label", "afield");
        lv.appendChild(el("span", null, "Valores"));
        lv.appendChild(chips);
        lv.appendChild(el("small", "ahint", "Digite e aperte Enter para virar etiqueta."));
        box.appendChild(lv);

        var rm = el("button", "alink alink-del", "Excluir opção"); rm.type = "button";
        rm.addEventListener("click", function () { p.opcoes.splice(idx, 1); pintarOpcoes(); regenera(); });
        box.appendChild(rm);
        opsWrap.appendChild(box);
      });
      addOp.hidden = p.opcoes.length >= 2;
    }

    // ── variantes: combinações das opções, preservando o já preenchido ──────
    function combos() {
      var ops = p.opcoes.filter(function (o) { return o.nome.trim() && o.valores.length; });
      if (!ops.length) return [];
      var res = [{}];
      ops.forEach(function (o) {
        var nv = [];
        res.forEach(function (b) {
          o.valores.forEach(function (v) {
            var c = {}; Object.keys(b).forEach(function (k) { c[k] = b[k]; }); c[o.nome.trim()] = v; nv.push(c);
          });
        });
        res = nv;
      });
      return res;
    }
    function chave(c) { return JSON.stringify(c); }
    function regenera() {
      var cs = combos();
      var antes = {}; p.variantes.forEach(function (v) { antes[chave(v.combinacao || {})] = v; });
      p.variantes = cs.map(function (c) {
        return antes[chave(c)] || { combinacao: c, preco: p.preco, preco_promo: null, estoque: 0, peso_g: p.peso_g, comp_cm: p.comp_cm, larg_cm: p.larg_cm, alt_cm: p.alt_cm, ativo: true };
      });
      // Shopify: com variantes, preço/estoque/envio saem do produto e vão pra tabela
      var temVar = p.variantes.length > 0;
      cP.hidden = temVar; cE.hidden = temVar; cS.hidden = temVar;
      pintarTabela();
    }
    function rotulo(c) { return Object.keys(c).map(function (k) { return c[k]; }).join(" · "); }
    function pintarTabela() {
      tabWrap.textContent = "";
      if (!p.variantes.length) return;
      tabWrap.appendChild(el("div", "asec-title", "Variantes"));
      p.variantes.forEach(function (v) {
        var linha = el("div", "avlinha");
        var topo = el("div", "avlinha-topo");
        topo.appendChild(el("span", "avlinha-nome", rotulo(v.combinacao || {})));
        var lv = el("label", "acheck");
        var cv = document.createElement("input"); cv.type = "checkbox"; cv.checked = v.ativo !== false;
        cv.addEventListener("change", function () { v.ativo = cv.checked; });
        lv.appendChild(cv); lv.appendChild(el("span", null, "À venda"));
        topo.appendChild(lv);
        linha.appendChild(topo);
        var g = el("div", "agrid");
        function add(rot, tipo, val, set, ph) {
          var i = inp(tipo, val, ph); if (tipo === "text") i.inputMode = "decimal";
          i.addEventListener("input", function () { set(i.value); });
          g.appendChild(campo(rot, i));
        }
        add("Preço (R$)", "text", deCents(v.preco), function (x) { v.preco = paraCents(x); }, "0,00");
        add("Promocional (R$)", "text", deCents(v.preco_promo), function (x) { v.preco_promo = x === "" ? null : paraCents(x); }, "sem promoção");
        add("Estoque", "number", v.estoque, function (x) { v.estoque = Number(x) || 0; });
        add("Peso (g)", "number", v.peso_g, function (x) { v.peso_g = Number(x) || 0; });
        add("Compr. (cm)", "number", v.comp_cm, function (x) { v.comp_cm = Number(x) || 0; });
        add("Larg. (cm)", "number", v.larg_cm, function (x) { v.larg_cm = Number(x) || 0; });
        add("Alt. (cm)", "number", v.alt_cm, function (x) { v.alt_cm = Number(x) || 0; });
        linha.appendChild(g);
        tabWrap.appendChild(linha);
      });
    }

    function pintarCategorias() {
      catWrap.textContent = "";
      if (!categoriasTodas.length) { catWrap.appendChild(el("p", "ahint", "Nenhuma categoria criada.")); return; }
      var porPai = {};
      categoriasTodas.forEach(function (c) { (porPai[c.pai_id || ""] = porPai[c.pai_id || ""] || []).push(c); });
      (function nivel(pai, prof) {
        (porPai[pai] || []).forEach(function (c) {
          var l = el("label", "acheck" + (prof ? " acheck-filha" : ""));
          var cb = document.createElement("input"); cb.type = "checkbox";
          cb.checked = p.categorias.indexOf(c.id) >= 0;
          cb.addEventListener("change", function () {
            var i = p.categorias.indexOf(c.id);
            if (cb.checked && i < 0) p.categorias.push(c.id);
            if (!cb.checked && i >= 0) p.categorias.splice(i, 1);
          });
          l.appendChild(cb); l.appendChild(el("span", null, c.nome));
          catWrap.appendChild(l);
          nivel(c.id, prof + 1);
        });
      })("", 0);
    }

    salvar.addEventListener("click", function () {
      p.nome = iNome.value; p.descricao = iDesc.value; p.status = iStatus.value;
      if (!p.variantes.length) {
        p.preco = paraCents(iPreco.value);
        p.preco_promo = iComp.value.trim() === "" ? null : paraCents(iComp.value);
        p.estoque = Number(iEst.value) || 0;
        p.peso_g = Number(iPeso.value) || 0;
        p.comp_cm = Number(iC.value) || 0; p.larg_cm = Number(iL.value) || 0; p.alt_cm = Number(iA.value) || 0;
      } else {
        // com variantes: o preço do produto é o MENOR ("a partir de" da vitrine)
        var ps = p.variantes.map(function (v) { return Number(v.preco) || 0; }).filter(function (n) { return n > 0; });
        p.preco = ps.length ? Math.min.apply(null, ps) : 0;
        p.preco_promo = null;
      }
      salvar.disabled = true; salvar.textContent = "Salvando…";
      var corpo = {
        id: p.id || "", nome: p.nome, descricao: p.descricao, status: p.status,
        preco: p.preco, preco_promo: p.preco_promo,
        opcoes: p.opcoes, categorias: p.categorias, galeria: p.galeria,
        variantes: p.variantes.length ? p.variantes
          : [{ combinacao: {}, preco: p.preco, preco_promo: p.preco_promo, estoque: p.estoque, peso_g: p.peso_g, comp_cm: p.comp_cm, larg_cm: p.larg_cm, alt_cm: p.alt_cm, ativo: true }],
      };
      fetch("/api/admin/produto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          salvar.disabled = false; salvar.textContent = "Salvar";
          if (d && d.ok) {
            aviso("Produto salvo.");
            if (!p.id) { p.id = d.id; history.replaceState(null, "", "/admin/produto?id=" + encodeURIComponent(d.id)); }
          } else aviso(d && d.erro === "promo_maior" ? "O preço promocional precisa ser MENOR que o preço cheio." : d && d.erro === "nome" ? "Dê um nome ao produto." : "Não deu para salvar.", true);
        })
        .catch(function () { salvar.disabled = false; salvar.textContent = "Salvar"; aviso("Falha de rede.", true); });
    });

    pintarGaleria();
    pintarOpcoes();
    regenera();
  }

  // ── carrega dados e desenha ───────────────────────────────────────────────
  Promise.all([
    fetch("/api/admin/categorias").then(function (r) { return r.json(); }).catch(function () { return null; }),
    novo ? Promise.resolve(null) : fetch("/api/admin/produto?id=" + encodeURIComponent(id)).then(function (r) { return r.json(); }).catch(function () { return null; }),
  ]).then(function (res) {
    categoriasTodas = (res[0] && res[0].categorias) || [];
    var d = res[1];
    if (d && d.ok) {
      var x = d.produto;
      var vs = (x.variantes || []).map(function (v) {
        return { id: v.id, combinacao: v.combinacao || {}, preco: v.preco, preco_promo: v.preco_promo, estoque: v.estoque, peso_g: v.peso_g, comp_cm: v.comp_cm, larg_cm: v.larg_cm, alt_cm: v.alt_cm, ativo: !!v.ativo };
      });
      var unica = vs.length === 1 && !Object.keys(vs[0].combinacao || {}).length;
      p = {
        id: x.id, nome: x.nome, descricao: x.descricao || "", status: x.status,
        preco: unica ? vs[0].preco : x.preco, preco_promo: unica ? vs[0].preco_promo : x.preco_promo,
        estoque: unica ? vs[0].estoque : 0,
        peso_g: unica ? vs[0].peso_g : 0, comp_cm: unica ? vs[0].comp_cm : 0, larg_cm: unica ? vs[0].larg_cm : 0, alt_cm: unica ? vs[0].alt_cm : 0,
        opcoes: (x.opcoes || []).map(function (o) { return { nome: o.nome, valores: o.valores || [] }; }),
        variantes: unica ? [] : vs,
        categorias: x.categorias || [],
        galeria: (x.galeria || []).map(function (g) { return { asset_id: g.asset_id, tipo: g.tipo }; }),
      };
    }
    pintar();
  });
})();
