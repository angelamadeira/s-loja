/* Catálogo no Admin — lista de produtos e formulário de edição.
   Tudo montado com DOM (textContent), nunca innerHTML com dado do banco.
   Preço: a pessoa digita em REAIS; o servidor recebe CENTAVOS (conversão aqui). */
(function () {
  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  var LIMIAR = 5; // "últimas unidades" a partir daqui pra baixo (ajustável em Config)
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
        dir.appendChild(el("span", "achip " + (est === 0 ? "achip-off" : est <= LIMIAR ? "achip-low" : "achip-ok"),
          est === 0 ? "esgotado" : est <= LIMIAR ? "últimas " + est + " unidades" : est + " em estoque"));
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
    var p = { id: "", nome: "", slug: "", descricao: "", status: "rascunho", destaque: 0, ordem: 0, preco: 0, preco_promo: null, tipo_variacao: '', opcoes: [], variantes: [], categorias: [], galeria: [] };

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


      // mídia (imagem OU vídeo)
      var sM = el("section", "asec");
      sM.appendChild(el("h2", "asec-title", "Fotos e vídeos"));
      sM.appendChild(el("p", "ahint", "Imagem ou vídeo. O primeiro item é a capa que aparece na vitrine."));
      var galWrap = el("div", "agal");
      sM.appendChild(galWrap);
      var fInp = document.createElement("input");
      fInp.type = "file"; fInp.accept = "image/*,video/*"; fInp.hidden = true;
      var bUp = el("button", "btn ghost abtn-full", "Adicionar foto ou vídeo");
      bUp.type = "button";
      bUp.addEventListener("click", function () { fInp.click(); });
      fInp.addEventListener("change", function () {
        var f = fInp.files && fInp.files[0];
        if (!f) return;
        bUp.disabled = true; bUp.textContent = "Enviando…";
        var fd = new FormData(); fd.append("arquivo", f);
        fetch("/api/admin/midia", { method: "POST", body: fd })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            bUp.disabled = false; bUp.textContent = "Adicionar foto ou vídeo";
            fInp.value = "";
            if (d && d.ok) { p.galeria.push({ asset_id: d.id, tipo: d.tipo }); pintarGaleria(); }
            else { aviso(d && d.erro === "grande" ? "Arquivo muito grande (imagem até 10 MB, vídeo até 50 MB)." : "Não deu para enviar.", true); }
          })
          .catch(function () { bUp.disabled = false; bUp.textContent = "Adicionar foto ou vídeo"; aviso("Falha no envio.", true); });
      });
      sM.appendChild(bUp); sM.appendChild(fInp);
      raiz.appendChild(sM);

      function pintarGaleria() {
        galWrap.textContent = "";
        p.galeria.forEach(function (g, i) {
          var cel = el("div", "agal-item");
          var midia;
          if (String(g.tipo || "").indexOf("video") === 0) {
            midia = document.createElement("video");
            midia.src = "/midia/" + g.asset_id; midia.muted = true; midia.loop = true;
            midia.autoplay = true; midia.playsInline = true;
          } else {
            midia = document.createElement("img");
            midia.src = "/midia/" + g.asset_id; midia.alt = "";
          }
          cel.appendChild(midia);
          if (i === 0) cel.appendChild(el("span", "agal-capa", "capa"));
          var rm = el("button", "agal-rm", "×");
          rm.type = "button"; rm.title = "remover";
          rm.addEventListener("click", function () { p.galeria.splice(i, 1); pintarGaleria(); });
          cel.appendChild(rm);
          galWrap.appendChild(cel);
        });
      }

      // categorias
      var sC = el("section", "asec");
      sC.appendChild(el("h2", "asec-title", "Categorias"));
      var catWrap = el("div", "acats");
      sC.appendChild(catWrap);
      var linkCats = el("a", "apage-sub-link", "Criar ou organizar categorias →");
      linkCats.href = "/admin/categorias";
      sC.appendChild(linkCats);
      raiz.appendChild(sC);
      fetch("/api/admin/categorias").then(function (r) { return r.json(); }).then(function (d) {
        var cs = (d && d.categorias) || [];
        catWrap.textContent = "";
        if (!cs.length) { catWrap.appendChild(el("p", "ahint", "Nenhuma categoria criada ainda.")); return; }
        var porPai = {};
        cs.forEach(function (c) { (porPai[c.pai_id || ""] = porPai[c.pai_id || ""] || []).push(c); });
        function nivel(paiId, prof) {
          (porPai[paiId] || []).forEach(function (c) {
            var l = el("label", "acheck" + (prof ? " acheck-filha" : ""));
            var cb = document.createElement("input");
            cb.type = "checkbox";
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
        }
        nivel("", 0);
      });

      // VERSÕES — uma tabela só: cada linha é uma versão real, com tudo junto.
      var sV = el("section", "asec");
      sV.appendChild(el("h2", "asec-title", "Versões e estoque"));
      var iTipo = inp("text", p.tipo_variacao || "", "Tamanho, Cor, Sabor…");
      sV.appendChild(campo("O que muda entre as versões?", iTipo));
      iTipo.addEventListener("input", function () { p.tipo_variacao = iTipo.value; });
      sV.appendChild(el("p", "ahint", "Deixe em branco se a peça for única. Preço, estoque, peso e medidas são de cada versão — é o que calcula o frete e gera a etiqueta."));
      var varWrap = el("div", "avars");
      sV.appendChild(varWrap);
      var addV = el("button", "btn ghost abtn-full", "Adicionar versão");
      addV.type = "button";
      addV.addEventListener("click", function () {
        p.variantes.push({ nome: "", preco: 0, preco_promo: null, estoque: 0, peso_g: 0, comp_cm: 0, larg_cm: 0, alt_cm: 0, ativo: true });
        pintarVariantes();
      });
      sV.appendChild(addV);
      raiz.appendChild(sV);

      // salvar
      var s5 = el("section", "asec");
      var msg = el("div", "amsg"); msg.hidden = true;
      s5.appendChild(msg);
      var salvar = el("button", "btn abtn-full", "Salvar produto");
      salvar.type = "button";
      s5.appendChild(salvar);
      raiz.appendChild(s5);

      function aviso(t, erro) { msg.hidden = false; msg.className = erro ? "amsg err" : "amsg"; msg.textContent = t; }


      function pintarVariantes() {
        varWrap.textContent = "";
        if (!p.variantes.length) {
          p.variantes.push({ nome: "", preco: 0, preco_promo: null, estoque: 0, peso_g: 0, comp_cm: 0, larg_cm: 0, alt_cm: 0, ativo: true });
        }
        p.variantes.forEach(function (v, idx) {
          var box = el("div", "avar");
          var topo = el("div", "avar-topo");
          var iN = inp("text", v.nome || "", p.tipo_variacao ? ("Ex.: " + (idx === 0 ? "Médio" : "Grande")) : "Peça única");
          iN.className = "avar-nomeinp";
          iN.addEventListener("input", function () { v.nome = iN.value; });
          topo.appendChild(iN);
          if (p.variantes.length > 1) {
            var rm = el("button", "apk-rm", "remover");
            rm.type = "button";
            rm.addEventListener("click", function () { p.variantes.splice(idx, 1); pintarVariantes(); });
            topo.appendChild(rm);
          }
          box.appendChild(topo);
          var g = el("div", "agrid");
          function add(rot, tipo, val, set, ph) {
            var i = inp(tipo, val, ph);
            if (tipo === "text") i.inputMode = "decimal";
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
          box.appendChild(g);
          var lv = el("label", "acheck");
          var cv = document.createElement("input"); cv.type = "checkbox"; cv.checked = v.ativo !== false;
          cv.addEventListener("change", function () { v.ativo = cv.checked; });
          lv.appendChild(cv); lv.appendChild(el("span", null, "À venda"));
          box.appendChild(lv);
          varWrap.appendChild(box);
        });
      }

      salvar.addEventListener("click", function () {
        p.nome = iNome.value; p.descricao = iDesc.value; p.status = iStatus.value;
        // preço do PRODUTO = o menor das versões (a vitrine mostra "a partir de")
        var precos = p.variantes.map(function (v) { return Number(v.preco) || 0; }).filter(function (n) { return n > 0; });
        p.preco = precos.length ? Math.min.apply(null, precos) : 0;
        p.preco_promo = null;
        // a combinação guarda {tipo: nome} — o que a loja usa pra montar o seletor
        var tipo = (p.tipo_variacao || "").trim();
        p.variantes.forEach(function (v) {
          var n = (v.nome || "").trim();
          v.combinacao = (tipo && n) ? (function () { var o = {}; o[tipo] = n; return o; })() : {};
        });
        salvar.disabled = true; salvar.textContent = "Salvando…";
        fetch("/api/admin/produto", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: p.id || "", nome: p.nome, slug: p.slug, descricao: p.descricao, status: p.status, destaque: p.destaque, ordem: p.ordem, preco: p.preco, preco_promo: p.preco_promo, opcoes: (p.tipo_variacao || '').trim() ? [{ nome: p.tipo_variacao.trim(), valores: p.variantes.map(function (v) { return (v.nome || '').trim(); }).filter(Boolean) }] : [], variantes: p.variantes, categorias: p.categorias, galeria: p.galeria }),
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

      pintarGaleria();
      pintarVariantes();
    }

    if (novo) { pintar(); return; }
    fetch("/api/admin/produto?id=" + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok) {
        var x = d.produto;
        p = { id: x.id, nome: x.nome, slug: x.slug, descricao: x.descricao || "", status: x.status, destaque: x.destaque, ordem: x.ordem, preco: x.preco, preco_promo: x.preco_promo, opcoes: x.opcoes || [], variantes: (x.variantes || []).map(function (v) { return { id: v.id, nome: Object.keys(v.combinacao || {}).length ? v.combinacao[Object.keys(v.combinacao)[0]] : '', combinacao: v.combinacao, preco: v.preco, preco_promo: v.preco_promo, estoque: v.estoque, peso_g: v.peso_g, comp_cm: v.comp_cm, larg_cm: v.larg_cm, alt_cm: v.alt_cm, ativo: !!v.ativo }; }), tipo_variacao: ((x.opcoes || [])[0] || {}).nome || '', categorias: x.categorias || [], galeria: (x.galeria || []).map(function (g) { return { asset_id: g.asset_id, tipo: g.tipo }; }) };
      }
      pintar();
    });
  }

  if (document.getElementById("lista")) renderLista();
  if (document.getElementById("form")) renderForm();
})();

/* ── CATEGORIAS (criar, renomear, aninhar, apagar) ───────────────────────── */
(function () {
  var raiz = document.getElementById("cats");
  if (!raiz) return;
  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  var todas = [];

  function salvar(cat) {
    return fetch("/api/admin/categoria", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cat) })
      .then(function (r) { return r.json(); }).then(carrega);
  }
  function apagar(id) {
    return fetch("/api/admin/categoria/apagar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: id }) })
      .then(function (r) { return r.json(); }).then(carrega);
  }

  function carrega() {
    return fetch("/api/admin/categorias").then(function (r) { return r.json(); }).then(function (d) {
      todas = (d && d.categorias) || [];
      pinta();
    });
  }

  function pinta() {
    raiz.textContent = "";
    var lista = el("div", "alista");
    var porPai = {};
    todas.forEach(function (c) { (porPai[c.pai_id || ""] = porPai[c.pai_id || ""] || []).push(c); });

    function nivel(paiId, prof) {
      (porPai[paiId] || []).forEach(function (c) {
        var it = el("div", "aitem acat" + (prof ? " acat-filha" : ""));
        var esq = el("div", "aitem-main");
        var nome = document.createElement("input");
        nome.type = "text"; nome.value = c.nome; nome.className = "acat-nome";
        nome.addEventListener("change", function () { salvar({ id: c.id, nome: nome.value, pai_id: c.pai_id, ordem: c.ordem }); });
        esq.appendChild(nome);
        esq.appendChild(el("div", "aitem-meta", c.n_produtos + (c.n_produtos === 1 ? " produto" : " produtos")));
        it.appendChild(esq);

        var dir = el("div", "aitem-side");
        // mãe: aninha esta categoria dentro de outra
        var sel = document.createElement("select");
        var op0 = document.createElement("option"); op0.value = ""; op0.textContent = "— categoria raiz —";
        sel.appendChild(op0);
        todas.forEach(function (o) {
          if (o.id === c.id) return;
          var op = document.createElement("option"); op.value = o.id; op.textContent = "dentro de " + o.nome;
          if (c.pai_id === o.id) op.selected = true;
          sel.appendChild(op);
        });
        sel.addEventListener("change", function () { salvar({ id: c.id, nome: c.nome, pai_id: sel.value, ordem: c.ordem }); });
        dir.appendChild(sel);
        var rm = el("button", "apk-rm", "apagar");
        rm.type = "button";
        rm.addEventListener("click", function () {
          if (confirm("Apagar a categoria “" + c.nome + "”? Os produtos não são apagados.")) apagar(c.id);
        });
        dir.appendChild(rm);
        it.appendChild(dir);
        lista.appendChild(it);
        nivel(c.id, prof + 1);
      });
    }
    nivel("", 0);
    raiz.appendChild(lista);

    var nova = el("section", "asec");
    nova.appendChild(el("h2", "asec-title", "Nova categoria"));
    var i = document.createElement("input");
    i.type = "text"; i.placeholder = "Ex.: Coleção de Páscoa";
    var l = el("label", "afield"); l.appendChild(el("span", null, "Nome")); l.appendChild(i);
    nova.appendChild(l);
    var b = el("button", "btn abtn-full", "Criar categoria");
    b.type = "button";
    b.addEventListener("click", function () {
      if (!i.value.trim()) return;
      salvar({ nome: i.value.trim() }).then(function () { i.value = ""; });
    });
    nova.appendChild(b);
    raiz.appendChild(nova);
  }

  carrega();
})();
