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
  function caixa(rotulo, marcado, aoMudar) {
    var l = el("label", "acheck");
    var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!marcado;
    cb.addEventListener("change", function () { aoMudar(cb.checked); });
    l.appendChild(cb); l.appendChild(el("span", null, rotulo));
    return l;
  }
  function slugifica(n) {
    return slugLeve(n).replace(/^-+|-+$/g, "").slice(0, 80);
  }
  // Enquanto DIGITA não dá para cortar o hífen do fim — senão é impossível
  // escrever "tablete-ursinho" (o hífen sumiria a cada tecla). Arruma no blur.
  function slugLeve(n) {
    return String(n || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-").slice(0, 80);
  }
  function corta(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // ── a etiqueta de desconto que vai sair na vitrine ────────────────────────
  // A porcentagem não se digita em lugar nenhum: ela É a conta entre o preço
  // cheio e o promocional. Mostrar aqui, enquanto se digita, evita a surpresa de
  // descobrir só depois que "R$ 92,80" virou um −20% na loja.
  // MESMA fórmula do arredondamento da vitrine — se divergir, o admin mente.
  function pctDesconto(cheio, promo) {
    if (!cheio || promo == null || promo <= 0 || promo >= cheio) return 0;
    return Math.round((1 - promo / cheio) * 100);
  }
  function mostraEtiqueta(alvo, cheio, promo) {
    var pct = pctDesconto(cheio, promo);
    if (promo == null || promo === "" || promo >= cheio) { alvo.hidden = true; return; }
    alvo.hidden = false;
    // menos de 0,5% arredonda pra zero: a etiqueta sairia "−0%", que é pior que
    // etiqueta nenhuma. A loja não mostra, e aqui a gente avisa por quê.
    alvo.textContent = pct >= 1
      ? "Na vitrine vai aparecer a etiqueta −" + pct + "%"
      : "Desconto pequeno demais para virar etiqueta — a vitrine não vai mostrar porcentagem.";
    alvo.classList.toggle("aetiq-off", pct < 1);
  }

  var id = new URLSearchParams(location.search).get("id") || "";
  var novo = !id;
  var p = {
    id: "", slug: "", nome: "", descricao: "", legenda: "", status: "rascunho",
    // `gtin` (código de barras) NÃO tem campo na tela: é um número da GS1, que
    // só existe pra quem registra produto lá — inventar um seria pior que não
    // ter. A coluna e o vaivém continuam aqui pra não perder dado se um dia
    // fizer sentido (venda em marketplace grande, por exemplo).
    preco: 0, preco_promo: null, estoque: 0, vender_sem_estoque: false, sku: "", gtin: "",
    peso_g: 0, comp_cm: 0, larg_cm: 0, alt_cm: 0,
    opcoes: [], variantes: [], categorias: [], galeria: [], video_asset: null,
    video_links: { instagram: "", tiktok: "" },
    seo: { titulo: "", descricao: "" }, tags: [],
  };
  var categoriasTodas = [];
  // LIMIAR de "Últimas unidades" — vem de Configurações (uma verdade só para o
  // admin e a loja). O 8 é só o valor de partida enquanto a config não chega.
  var LIMIAR_ULTIMAS = 8;
  var slugTocado = false; // enquanto falso, o endereço acompanha o nome (padrão Shopify)

  // ── monta a página ────────────────────────────────────────────────────────
  function pintar() {
    raiz.textContent = "";

    // ── barra de ALTERAÇÕES NÃO SALVAS (padrão Shopify: gruda no topo e some ao
    // salvar; o navegador também avisa se tentar sair). Fica antes do cabeçalho
    // pra empurrar o conteúdo em vez de tapar.
    var sujo = false;
    var barra = el("div", "abarra");
    barra.hidden = true;
    barra.appendChild(el("span", "abarra-txt", "Alterações não salvas"));
    var bDescartar = el("button", "btn ghost abarra-btn", "Descartar");
    bDescartar.type = "button";
    var bSalvarBarra = el("button", "btn abarra-btn", "Salvar");
    bSalvarBarra.type = "button";
    var acoesBarra = el("div", "abarra-acoes");
    acoesBarra.appendChild(bDescartar); acoesBarra.appendChild(bSalvarBarra);
    barra.appendChild(acoesBarra);
    raiz.appendChild(barra);

    function marcaSujo() {
      if (sujo) return;
      sujo = true; barra.hidden = false;
      window.addEventListener("beforeunload", avisaSaida);
    }
    function limpaSujo() {
      sujo = false; barra.hidden = true;
      window.removeEventListener("beforeunload", avisaSaida);
    }
    function avisaSaida(e) { e.preventDefault(); e.returnValue = ""; return ""; }
    // qualquer digitação/mudança dentro do formulário conta — inclusive nos
    // campos criados depois (o listener é na raiz, na fase de captura).
    raiz.addEventListener("input", marcaSujo, true);
    raiz.addEventListener("change", marcaSujo, true);
    bDescartar.addEventListener("click", function () {
      if (!confirm("Descartar as alterações e voltar ao que está salvo?")) return;
      limpaSujo(); location.reload();
    });

    var head = el("div", "apage-head");
    var tit = el("div");
    var volta = el("a", "apage-sub-link", "← Produtos");
    volta.href = "/admin/produtos";
    tit.appendChild(volta);
    tit.appendChild(el("h1", null, novo ? "Novo produto" : p.nome || "Produto"));
    head.appendChild(tit);
    var acoes = el("div", "apage-acoes");
    if (!novo && p.slug) {
      // "Ver na loja" — padrão Shopify/Nuvemshop. Abre em nova aba.
      var verLoja = el("a", "alink", "Ver na loja ↗");
      verLoja.href = "/p/" + p.slug;
      verLoja.target = "_blank";
      verLoja.rel = "noopener";
      acoes.appendChild(verLoja);
    }
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

    // ── Básico
    var cB = card();
    var iNome = inp("text", p.nome, "Tablete Ursinho");
    cB.appendChild(campo("Nome", iNome));
    var iLeg = inp("text", p.legenda, "Tablete · 12 gomos");
    cB.appendChild(campo("Legenda curta", iLeg, "A linha miúda acima do nome, no card da vitrine. Pode ficar vazia."));
    var iDesc = document.createElement("textarea");
    iDesc.rows = 5; iDesc.value = p.descricao || "";
    cB.appendChild(campo("Descrição", iDesc));
    main.appendChild(cB);

    // ── Mídia (com REORDENAR: arrastar ou setas; a 1ª é a capa)
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
          if (d && d.ok) { p.galeria.push({ asset_id: d.id, tipo: d.tipo }); pintarGaleria(); marcaSujo(); }
          else aviso(d && d.erro === "grande" ? "Arquivo grande demais (imagem até 10 MB, vídeo até 50 MB)." : "Não deu para enviar.", true);
        })
        .catch(function () { bUp.disabled = false; bUp.textContent = "Adicionar imagem ou vídeo"; aviso("Falha no envio.", true); });
    });
    cM.appendChild(bUp); cM.appendChild(fInp);
    cM.appendChild(el("p", "ahint", "A primeira mídia é a capa que aparece na vitrine. Arraste para reordenar (ou use ‹ ›)."));
    main.appendChild(cM);

    function thumb(assetId, tipo) {
      var m;
      if (String(tipo || "").indexOf("video") === 0) {
        m = document.createElement("video");
        m.src = "/midia/" + assetId; m.muted = true; m.loop = true; m.autoplay = true; m.playsInline = true;
      } else { m = document.createElement("img"); m.src = "/midia/" + assetId; m.alt = ""; }
      return m;
    }
    function move(de, para) {
      if (para < 0 || para >= p.galeria.length || de === para) return;
      var it = p.galeria.splice(de, 1)[0];
      p.galeria.splice(para, 0, it);
      pintarGaleria(); marcaSujo();
    }
    var arrastando = -1;
    function pintarGaleria() {
      gal.textContent = "";
      p.galeria.forEach(function (g, i) {
        var cel = el("div", "agal-item");
        cel.draggable = true;
        cel.addEventListener("dragstart", function (e) {
          arrastando = i; cel.classList.add("agal-drag");
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }
        });
        cel.addEventListener("dragend", function () { arrastando = -1; cel.classList.remove("agal-drag"); });
        cel.addEventListener("dragover", function (e) { e.preventDefault(); cel.classList.add("agal-alvo"); });
        cel.addEventListener("dragleave", function () { cel.classList.remove("agal-alvo"); });
        cel.addEventListener("drop", function (e) {
          e.preventDefault(); cel.classList.remove("agal-alvo");
          if (arrastando >= 0) move(arrastando, i);
        });
        cel.appendChild(thumb(g.asset_id, g.tipo));
        if (i === 0) cel.appendChild(el("span", "agal-capa", "capa"));
        var setas = el("div", "agal-setas");
        var ant = el("button", "agal-seta", "‹"); ant.type = "button"; ant.title = "mover para trás";
        ant.disabled = i === 0;
        ant.addEventListener("click", function () { move(i, i - 1); });
        var pro = el("button", "agal-seta", "›"); pro.type = "button"; pro.title = "mover para frente";
        pro.disabled = i === p.galeria.length - 1;
        pro.addEventListener("click", function () { move(i, i + 1); });
        setas.appendChild(ant); setas.appendChild(pro);
        cel.appendChild(setas);
        var rm = el("button", "agal-rm", "×"); rm.type = "button"; rm.title = "remover";
        rm.addEventListener("click", function () {
          // se alguma variante usava esta mídia, o vínculo cai junto
          p.variantes.forEach(function (v) { if (v.imagem_asset === g.asset_id) v.imagem_asset = null; });
          p.galeria.splice(i, 1); pintarGaleria(); pintarTabela(); marcaSujo();
        });
        cel.appendChild(rm);
        gal.appendChild(cel);
      });
    }

    // ── Vídeo do produto (o "reel" do botão flutuante da vitrine — separado da galeria)
    var cVid = card("Vídeo do produto");
    var vidPrev = el("div", "avid"); cVid.appendChild(vidPrev);
    var vInp = document.createElement("input");
    vInp.type = "file"; vInp.accept = "video/*"; vInp.hidden = true;
    var bVid = el("button", "btn ghost abtn-full", "Enviar vídeo");
    bVid.type = "button";
    bVid.addEventListener("click", function () { vInp.click(); });
    vInp.addEventListener("change", function () {
      var f = vInp.files && vInp.files[0]; if (!f) return;
      bVid.disabled = true; bVid.textContent = "Enviando…";
      var fd = new FormData(); fd.append("arquivo", f);
      fetch("/api/admin/midia", { method: "POST", body: fd })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          bVid.disabled = false; bVid.textContent = "Enviar vídeo"; vInp.value = "";
          if (d && d.ok) { p.video_asset = d.id; pintarVideo(); marcaSujo(); }
          else aviso(d && d.erro === "grande" ? "Vídeo grande demais (até 50 MB)." : "Não deu para enviar.", true);
        })
        .catch(function () { bVid.disabled = false; bVid.textContent = "Enviar vídeo"; aviso("Falha no envio.", true); });
    });
    cVid.appendChild(bVid); cVid.appendChild(vInp);
    cVid.appendChild(el("p", "ahint", "É o vídeo que toca no botão flutuante da página do produto — o mesmo das redes."));

    // Link do POST — o arquivo acima é o que toca na loja; o link é o caminho
    // opcional pro post real (curtidas e comentários), como botão dentro do vídeo.
    var iIG = inp("url", (p.video_links && p.video_links.instagram) || "", "https://www.instagram.com/reel/…");
    var iTT = inp("url", (p.video_links && p.video_links.tiktok) || "", "https://www.tiktok.com/@somos.suzu/video/…");
    var campoIG = campo("Link do post no Instagram", iIG);
    var campoTT = campo("Link do vídeo no TikTok", iTT);
    var erroIG = el("small", "ahint ahint-err"); erroIG.hidden = true; campoIG.appendChild(erroIG);
    var erroTT = el("small", "ahint ahint-err"); erroTT.hidden = true; campoTT.appendChild(erroTT);
    cVid.appendChild(campoIG);
    cVid.appendChild(campoTT);
    cVid.appendChild(el("p", "ahint", "Opcional. Vira um botão “ver no Instagram / TikTok” dentro do vídeo, na loja."));
    main.appendChild(cVid);

    // mesma lista de permissão do servidor — aqui só pra avisar cedo, não é a trava
    var HOSTS = {
      instagram: ["instagram.com", "www.instagram.com"],
      tiktok: ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
    };
    function checaLink(campo, entrada, alerta, rede) {
      var s = entrada.value.trim();
      var bom = true;
      if (s) {
        try {
          var u = new URL(s);
          bom = u.protocol === "https:" && HOSTS[rede].indexOf(u.hostname.toLowerCase()) >= 0;
        } catch (_) { bom = false; }
      }
      alerta.hidden = bom;
      if (!bom) alerta.textContent = "Cole o endereço completo do post, começando com https:// e no domínio do " + (rede === "tiktok" ? "TikTok" : "Instagram") + ".";
      entrada.classList.toggle("ainp-err", !bom);
      return bom;
    }
    iIG.addEventListener("input", function () { checaLink(campoIG, iIG, erroIG, "instagram"); });
    iTT.addEventListener("input", function () { checaLink(campoTT, iTT, erroTT, "tiktok"); });
    function pintarVideo() {
      vidPrev.textContent = "";
      if (!p.video_asset) return;
      var v = document.createElement("video");
      v.src = "/midia/" + p.video_asset; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.controls = true;
      vidPrev.appendChild(v);
      var rm = el("button", "alink alink-del", "Remover vídeo"); rm.type = "button";
      rm.addEventListener("click", function () { p.video_asset = null; pintarVideo(); marcaSujo(); });
      vidPrev.appendChild(rm);
    }

    // ── Preço / Estoque / Envio (somem quando há variantes — padrão Shopify)
    var cP = card("Preço");
    var iPreco = inp("text", deCents(p.preco), "0,00"); iPreco.inputMode = "decimal";
    var iComp = inp("text", deCents(p.preco_promo), "sem promoção"); iComp.inputMode = "decimal";
    var gp = el("div", "agrid2");
    gp.appendChild(campo("Preço (R$)", iPreco, "Preço cheio, de tabela."));
    var campoPromo = campo("Preço promocional (R$)", iComp, "O que a cliente paga. Vazio = sem promoção.");
    gp.appendChild(campoPromo);
    cP.appendChild(gp);
    // Validação INLINE, enquanto digita — não um "não" na cara depois de Salvar.
    // A regra existe por CDC: o preço riscado tem de ser um preço real praticado;
    // promocional MAIOR mostraria um "desconto" que é aumento.
    var alertaPromo = el("small", "ahint ahint-err");
    alertaPromo.hidden = true;
    campoPromo.appendChild(alertaPromo);
    var etiqPromo = el("small", "ahint aetiq");
    etiqPromo.hidden = true;
    campoPromo.appendChild(etiqPromo);
    function checaPromo() {
      var cheio = paraCents(iPreco.value), promo = iComp.value.trim() === "" ? null : paraCents(iComp.value);
      var ruim = promo !== null && cheio > 0 && promo > cheio;
      alertaPromo.hidden = !ruim;
      if (ruim) alertaPromo.textContent = "Precisa ser menor que " + BRL(cheio / 100) + " — senão o desconto seria um aumento.";
      iComp.classList.toggle("ainp-err", ruim);
      mostraEtiqueta(etiqPromo, cheio, ruim ? null : promo);
      return !ruim;
    }
    iPreco.addEventListener("input", checaPromo);
    iComp.addEventListener("input", checaPromo);
    main.appendChild(cP);

    var cE = card("Estoque");
    var iEst = inp("number", p.estoque);
    var iSku = inp("text", p.sku, "");
    var ge = el("div", "agrid2");
    ge.appendChild(campo("Quantidade", iEst));
    ge.appendChild(campo("SKU (código interno)", iSku, "Não precisa mexer. É um apelido seu, tipo TAB-M, pra achar a peça quando forem muitos moldes."));
    cE.appendChild(ge);
    cE.appendChild(caixa("Continuar vendendo quando esgotar", p.vender_sem_estoque, function (v) { p.vender_sem_estoque = v; }));
    cE.appendChild(el("p", "ahint", "Desmarcado, a loja para de vender ao chegar em zero."));
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
      pintarOpcoes(); regenera(); marcaSujo();
    });
    cV.appendChild(addOp);
    var tabWrap = el("div", "avtab"); cV.appendChild(tabWrap);
    main.appendChild(cV);

    // ── SEO: como o produto aparece no Google (padrão Shopify: prévia + 3 campos)
    var cSeo = card("Buscadores");
    var prev = el("div", "aseo-prev");
    var prevUrl = el("div", "aseo-prev-url");
    var prevTit = el("div", "aseo-prev-tit");
    var prevDesc = el("div", "aseo-prev-desc");
    prev.appendChild(prevUrl); prev.appendChild(prevTit); prev.appendChild(prevDesc);
    cSeo.appendChild(prev);
    var iSeoT = inp("text", (p.seo && p.seo.titulo) || "", "");
    var iSeoD = document.createElement("textarea");
    iSeoD.rows = 3; iSeoD.value = (p.seo && p.seo.descricao) || "";
    var iSlug = inp("text", p.slug, "");
    var campoT = campo("Título da página", iSeoT, "Vazio = usa o nome do produto.");
    var contT = el("small", "ahint aseo-cont"); campoT.appendChild(contT);
    var campoD = campo("Descrição no Google", iSeoD, "Vazio = usa o começo da descrição.");
    var contD = el("small", "ahint aseo-cont"); campoD.appendChild(contD);
    cSeo.appendChild(campoT);
    cSeo.appendChild(campoD);
    var slugBox = el("div", "aslug");
    slugBox.appendChild(el("span", "aslug-pre", location.host + "/p/"));
    slugBox.appendChild(iSlug);
    var campoSlug = el("label", "afield");
    campoSlug.appendChild(el("span", null, "Endereço da página"));
    campoSlug.appendChild(slugBox);
    var avisoSlug = el("small", "ahint");
    campoSlug.appendChild(avisoSlug);
    cSeo.appendChild(campoSlug);
    main.appendChild(cSeo);

    var slugSalvo = p.slug;
    iSlug.addEventListener("input", function () { slugTocado = true; iSlug.value = slugLeve(iSlug.value); pintarSeo(); });
    iSlug.addEventListener("blur", function () { iSlug.value = slugifica(iSlug.value); pintarSeo(); });
    iSeoT.addEventListener("input", pintarSeo);
    iSeoD.addEventListener("input", pintarSeo);
    iNome.addEventListener("input", function () {
      if (!slugTocado) iSlug.value = slugifica(iNome.value);
      pintarSeo();
    });
    iDesc.addEventListener("input", pintarSeo);
    function pintarSeo() {
      var t = iSeoT.value.trim() || iNome.value.trim() || "Produto";
      var d = iSeoD.value.trim() || iDesc.value.trim();
      prevUrl.textContent = location.host + " › p › " + (iSlug.value || slugifica(iNome.value));
      prevTit.textContent = corta(t, 60);
      prevDesc.textContent = d ? corta(d, 160) : "Sem descrição — o Google vai inventar um trecho da página.";
      contT.textContent = iSeoT.value.length + " de 60 caracteres";
      contT.classList.toggle("ahint-err", iSeoT.value.length > 60);
      contD.textContent = iSeoD.value.length + " de 160 caracteres";
      contD.classList.toggle("ahint-err", iSeoD.value.length > 160);
      // trocar o endereço quebra links já compartilhados — avisa, não impede.
      var mudou = !novo && slugSalvo && iSlug.value !== slugSalvo;
      avisoSlug.textContent = mudou
        ? "Atenção: o endereço antigo (/p/" + slugSalvo + ") deixa de funcionar."
        : "É o link do produto. Sai do nome, mas você pode ajustar.";
      avisoSlug.classList.toggle("ahint-err", mudou);
    }

    // ── barra lateral: Situação + Organização + Tags
    var cSt = card("Situação");
    var iStatus = document.createElement("select");
    [["ativo", "Ativo"], ["rascunho", "Rascunho"], ["arquivado", "Arquivado"]].forEach(function (o) {
      var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1];
      if (p.status === o[0]) op.selected = true; iStatus.appendChild(op);
    });
    cSt.appendChild(iStatus);
    cSt.appendChild(el("p", "ahint", "Rascunho não aparece na loja. Arquivado sai da loja mas guarda o histórico."));

    // ── "Como vai aparecer na loja" ──────────────────────────────────────────
    // Os selos da vitrine (Esgotado / Últimas unidades / Edição limitada) e a
    // etiqueta de −X% não são escolhidos em lugar nenhum: SAEM DAS CONTAS de
    // estoque e preço. Sem isto, a única forma de saber qual selo saiu era abrir
    // a loja e olhar. Aqui a regra fica à vista e o resultado, ao vivo.
    var prevBox = el("div", "aprev");
    prevBox.appendChild(el("div", "aprev-tit", "Como vai aparecer na loja"));
    var prevSelos = el("div", "aprev-selos");
    prevBox.appendChild(prevSelos);
    var prevRegra = el("p", "ahint");
    prevBox.appendChild(prevRegra);
    cSt.appendChild(prevBox);
    side.appendChild(cSt);

    function estadoVitrine() {
      var temVar = p.variantes.length > 0;
      var estoque = 0, promoAtiva = false, cheio = 0, promo = null;
      if (temVar) {
        p.variantes.forEach(function (v) {
          if (v.ativo === false) return;
          estoque += Math.max(0, Number(v.estoque) || 0);
          if (v.preco_promo != null && v.preco_promo > 0 && v.preco_promo < v.preco) promoAtiva = true;
        });
        // a etiqueta da vitrine sai do tamanho mostrado por padrão (o 1º à venda)
        var v0 = p.variantes.filter(function (v) { return v.ativo !== false; })[0];
        if (v0) { cheio = v0.preco; promo = v0.preco_promo; }
      } else {
        estoque = Number(iEst.value) || 0;
        cheio = paraCents(iPreco.value);
        promo = iComp.value.trim() === "" ? null : paraCents(iComp.value);
        promoAtiva = promo != null && promo > 0 && promo < cheio;
      }
      return { estoque: estoque, promoAtiva: promoAtiva, pct: pctDesconto(cheio, promo), status: iStatus.value };
    }
    // Mostra SÓ o que a loja mostra de verdade. "Edição limitada" não entra:
    // está oculto por CSS na vitrine inteira (.pbadge.limited{display:none} —
    // toda peça é de tiragem limitada, a tag era redundante). Prévia que anuncia
    // um selo que não existe é pior que prévia nenhuma.
    // O texto só acompanha "Últimas unidades", porque só ali existe um número
    // (o limiar) que explica por que o aviso ligou.
    function atualizaVitrine() {
      var e = estadoVitrine();
      prevSelos.textContent = "";
      prevRegra.textContent = "";
      prevRegra.hidden = true;
      if (e.status !== "ativo") {
        prevSelos.appendChild(el("span", "aprev-selo aprev-selo-off", e.status === "rascunho" ? "Não aparece (rascunho)" : "Não aparece (arquivado)"));
        return;
      }
      if (e.estoque <= 0) {
        prevSelos.appendChild(el("span", "aprev-selo", "Esgotado"));
      } else if (e.estoque <= LIMIAR_ULTIMAS) {
        prevSelos.appendChild(el("span", "aprev-selo", "Últimas unidades"));
        prevRegra.hidden = false;
        prevRegra.textContent = "Restam " + e.estoque + " — o aviso liga com " + LIMIAR_ULTIMAS + " ou menos.";
      }
      if (e.promoAtiva && e.pct >= 1) prevSelos.appendChild(el("span", "aprev-selo aprev-selo-off", "−" + e.pct + "%"));
      if (!prevSelos.childNodes.length) prevSelos.appendChild(el("span", "aprev-selo aprev-selo-off", "Sem selo"));
    }
    iStatus.addEventListener("change", atualizaVitrine);
    // qualquer digitação no formulário pode mudar o selo (estoque, preço, variante)
    raiz.addEventListener("input", atualizaVitrine, true);
    raiz.addEventListener("change", atualizaVitrine, true);

    var cO = card("Organização");
    var catWrap = el("div", "acats"); cO.appendChild(catWrap);
    var linkCat = el("a", "alink", "Gerenciar categorias →");
    linkCat.href = "/admin/categorias";
    cO.appendChild(linkCat);
    side.appendChild(cO);
    pintarCategorias();

    // Tags — etiqueta livre, além das categorias (o Shopify tem os dois: a
    // categoria organiza a vitrine, a tag é o marcador solto pra você achar).
    var cTags = card("Tags");
    var tagsWrap = el("div", "achips");
    cTags.appendChild(tagsWrap);
    cTags.appendChild(el("p", "ahint", "Só para você organizar — não aparece na loja."));
    side.appendChild(cTags);
    function pintarTags() {
      tagsWrap.textContent = "";
      p.tags.forEach(function (t, i) {
        var ch = el("span", "achip-tag", t);
        var x = el("button", "achip-x", "×"); x.type = "button";
        x.addEventListener("click", function () { p.tags.splice(i, 1); pintarTags(); marcaSujo(); });
        ch.appendChild(x); tagsWrap.appendChild(ch);
      });
      var iT = inp("text", "", p.tags.length ? "adicionar" : "natal");
      iT.className = "achip-inp";
      function comita() {
        var v = iT.value.trim();
        if (v && p.tags.indexOf(v) < 0) { p.tags.push(v); pintarTags(); marcaSujo(); return true; }
        return false;
      }
      iT.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          if (comita()) tagsWrap.querySelector(".achip-inp").focus();
        } else if (e.key === "Backspace" && !iT.value && p.tags.length) {
          p.tags.pop(); pintarTags(); marcaSujo(); tagsWrap.querySelector(".achip-inp").focus();
        }
      });
      iT.addEventListener("blur", comita);
      tagsWrap.appendChild(iT);
    }
    pintarTags();

    var msg = el("div", "amsg"); msg.hidden = true;
    side.appendChild(msg);
    function aviso(t, erro) { msg.hidden = false; msg.className = erro ? "amsg err" : "amsg"; msg.textContent = t; }

    // ── Mais ações: Duplicar · Arquivar · Excluir (padrão Shopify: no rodapé da
    // página, com a destrutiva em tom de alerta e confirmação obrigatória)
    if (!novo) {
      var cAcoes = el("div", "aacoes");
      var bDup = el("button", "btn ghost", "Duplicar"); bDup.type = "button";
      bDup.addEventListener("click", function () {
        if (sujo && !confirm("Há alterações não salvas — elas NÃO entram na cópia. Duplicar mesmo assim?")) return;
        bDup.disabled = true; bDup.textContent = "Duplicando…";
        posta("/api/admin/produto/duplicar", { id: p.id }, function (d) {
          bDup.disabled = false; bDup.textContent = "Duplicar";
          if (d && d.ok) { limpaSujo(); location.href = "/admin/produto?id=" + encodeURIComponent(d.id); }
          else aviso("Não deu para duplicar.", true);
        });
      });
      var bArq = el("button", "btn ghost", p.status === "arquivado" ? "Arquivado" : "Arquivar");
      bArq.type = "button";
      bArq.disabled = p.status === "arquivado";
      bArq.addEventListener("click", function () {
        if (!confirm("Arquivar este produto? Ele sai da loja, mas continua aqui e pode voltar.")) return;
        bArq.disabled = true;
        posta("/api/admin/produto/arquivar", { id: p.id }, function (d) {
          if (d && d.ok) { p.status = "arquivado"; iStatus.value = "arquivado"; bArq.textContent = "Arquivado"; aviso("Produto arquivado."); }
          else { bArq.disabled = false; aviso("Não deu para arquivar.", true); }
        });
      });
      var bDel = el("button", "btn ghost aacoes-perigo", "Excluir"); bDel.type = "button";
      bDel.addEventListener("click", function () {
        if (!confirm('Excluir "' + (p.nome || "este produto") + '" para sempre?\n\nIsso não tem volta. As vendas já feitas ficam no histórico — se a ideia é só tirar da loja, use Arquivar.')) return;
        bDel.disabled = true; bDel.textContent = "Excluindo…";
        posta("/api/admin/produto/excluir", { id: p.id }, function (d) {
          if (d && d.ok) { limpaSujo(); location.href = "/admin/produtos"; }
          else { bDel.disabled = false; bDel.textContent = "Excluir"; aviso("Não deu para excluir.", true); }
        });
      });
      cAcoes.appendChild(bDup); cAcoes.appendChild(bArq); cAcoes.appendChild(bDel);
      main.appendChild(cAcoes);
    }
    function posta(url, corpo, pronto) {
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) })
        .then(function (r) { return r.json(); })
        .then(pronto)
        .catch(function () { pronto(null); });
    }

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
            x.addEventListener("click", function () { o.valores.splice(vi, 1); pintarChips(); regenera(); marcaSujo(); });
            ch.appendChild(x); chips.appendChild(ch);
          });
          var iV = inp("text", "", o.valores.length ? "adicionar" : "Médio");
          iV.className = "achip-inp";
          iV.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              var v = iV.value.trim();
              if (v && o.valores.indexOf(v) < 0) { o.valores.push(v); pintarChips(); regenera(); marcaSujo(); chips.querySelector(".achip-inp").focus(); }
            } else if (e.key === "Backspace" && !iV.value && o.valores.length) {
              o.valores.pop(); pintarChips(); regenera(); marcaSujo(); chips.querySelector(".achip-inp").focus();
            }
          });
          iV.addEventListener("blur", function () {
            var v = iV.value.trim();
            if (v && o.valores.indexOf(v) < 0) { o.valores.push(v); pintarChips(); regenera(); marcaSujo(); }
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
        rm.addEventListener("click", function () { p.opcoes.splice(idx, 1); pintarOpcoes(); regenera(); marcaSujo(); });
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
        return antes[chave(c)] || {
          combinacao: c, preco: p.preco, preco_promo: null, estoque: 0, vender_sem_estoque: false,
          sku: "", gtin: "", peso_g: p.peso_g, comp_cm: p.comp_cm, larg_cm: p.larg_cm, alt_cm: p.alt_cm,
          imagem_asset: null, ativo: true,
        };
      });
      // Shopify: com variantes, preço/estoque/envio saem do produto e vão pra tabela
      var temVar = p.variantes.length > 0;
      cP.hidden = temVar; cE.hidden = temVar; cS.hidden = temVar;
      pintarTabela();
      atualizaVitrine(); // criar/remover variante muda o estoque total e o selo
    }
    function rotulo(c) { return Object.keys(c).map(function (k) { return c[k]; }).join(" · "); }
    function pintarTabela() {
      tabWrap.textContent = "";
      if (!p.variantes.length) return;
      tabWrap.appendChild(el("div", "asec-title", "Variantes"));
      p.variantes.forEach(function (v) {
        var linha = el("div", "avlinha");
        var topo = el("div", "avlinha-topo");
        // imagem da variante: escolhe entre as mídias já enviadas do produto
        // (padrão Shopify — não é upload novo, é apontar pra galeria).
        var bImg = el("button", "avimg"); bImg.type = "button";
        bImg.title = "Imagem desta variante";
        var seletor = el("div", "avimg-lista"); seletor.hidden = true;
        function pintarImg() {
          bImg.textContent = "";
          if (v.imagem_asset) {
            var g = p.galeria.filter(function (x) { return x.asset_id === v.imagem_asset; })[0];
            bImg.appendChild(thumb(v.imagem_asset, g && g.tipo));
          } else bImg.appendChild(el("span", "avimg-vazio", "+"));
        }
        bImg.addEventListener("click", function () {
          seletor.hidden = !seletor.hidden;
          if (!seletor.hidden) pintarSeletor();
        });
        function pintarSeletor() {
          seletor.textContent = "";
          if (!p.galeria.length) { seletor.appendChild(el("p", "ahint", "Envie uma imagem em Mídia primeiro.")); return; }
          p.galeria.forEach(function (g) {
            var b = el("button", "avimg-op" + (v.imagem_asset === g.asset_id ? " avimg-op-on" : "")); b.type = "button";
            b.appendChild(thumb(g.asset_id, g.tipo));
            b.addEventListener("click", function () {
              v.imagem_asset = v.imagem_asset === g.asset_id ? null : g.asset_id;
              pintarImg(); pintarSeletor(); marcaSujo();
            });
            seletor.appendChild(b);
          });
          var lim = el("button", "alink", "Sem imagem própria"); lim.type = "button";
          lim.addEventListener("click", function () { v.imagem_asset = null; pintarImg(); seletor.hidden = true; marcaSujo(); });
          seletor.appendChild(lim);
        }
        pintarImg();
        topo.appendChild(bImg);
        topo.appendChild(el("span", "avlinha-nome", rotulo(v.combinacao || {})));
        var lv = el("label", "acheck");
        var cv = document.createElement("input"); cv.type = "checkbox"; cv.checked = v.ativo !== false;
        cv.addEventListener("change", function () { v.ativo = cv.checked; });
        lv.appendChild(cv); lv.appendChild(el("span", null, "À venda"));
        topo.appendChild(lv);
        linha.appendChild(topo);
        linha.appendChild(seletor);
        var g = el("div", "agrid");
        function add(rot, tipo, val, set, ph) {
          var i = inp(tipo, val, ph); if (tipo === "text") i.inputMode = "decimal";
          i.addEventListener("input", function () { set(i.value); });
          g.appendChild(campo(rot, i));
        }
        // preço e promocional andam juntos: a etiqueta de % sai da conta entre os
        // dois, então os dois campos atualizam o mesmo aviso.
        var etiqVar = el("small", "ahint aetiq");
        etiqVar.hidden = true;
        var iVp = inp("text", deCents(v.preco), "0,00"); iVp.inputMode = "decimal";
        var iVc = inp("text", deCents(v.preco_promo), "sem promoção"); iVc.inputMode = "decimal";
        function etiquetaVar() { mostraEtiqueta(etiqVar, v.preco, v.preco_promo); }
        iVp.addEventListener("input", function () { v.preco = paraCents(iVp.value); etiquetaVar(); });
        iVc.addEventListener("input", function () { v.preco_promo = iVc.value === "" ? null : paraCents(iVc.value); etiquetaVar(); });
        g.appendChild(campo("Preço (R$)", iVp));
        var campoVc = campo("Promocional (R$)", iVc);
        campoVc.appendChild(etiqVar);
        g.appendChild(campoVc);
        etiquetaVar();
        add("Estoque", "number", v.estoque, function (x) { v.estoque = Number(x) || 0; });
        add("Peso (g)", "number", v.peso_g, function (x) { v.peso_g = Number(x) || 0; });
        add("Compr. (cm)", "number", v.comp_cm, function (x) { v.comp_cm = Number(x) || 0; });
        add("Larg. (cm)", "number", v.larg_cm, function (x) { v.larg_cm = Number(x) || 0; });
        add("Alt. (cm)", "number", v.alt_cm, function (x) { v.alt_cm = Number(x) || 0; });
        // SKU não é número — entra sem o inputMode decimal dos campos acima
        var iS = inp("text", v.sku || "", "");
        iS.addEventListener("input", function () { v.sku = iS.value; });
        g.appendChild(campo("SKU", iS, "Não precisa mexer."));
        linha.appendChild(g);
        linha.appendChild(caixa("Continuar vendendo quando esgotar", v.vender_sem_estoque, function (x) { v.vender_sem_estoque = x; }));
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

    function salvarAgora() {
      p.nome = iNome.value; p.descricao = iDesc.value; p.legenda = iLeg.value.trim(); p.status = iStatus.value;
      p.seo = { titulo: iSeoT.value.trim(), descricao: iSeoD.value.trim() };
      p.slug = slugifica(iSlug.value) || slugifica(iNome.value);
      var okIG = checaLink(campoIG, iIG, erroIG, "instagram");
      var okTT = checaLink(campoTT, iTT, erroTT, "tiktok");
      if (!okIG || !okTT) {
        aviso("Confira o link do post — ele precisa ser o endereço completo do Instagram ou do TikTok.", true);
        (okIG ? iTT : iIG).focus();
        return;
      }
      p.video_links = { instagram: iIG.value.trim(), tiktok: iTT.value.trim() };
      if (!p.variantes.length) {
        if (!checaPromo()) { aviso("Confira o preço promocional.", true); iComp.focus(); return; }
        p.preco = paraCents(iPreco.value);
        p.preco_promo = iComp.value.trim() === "" ? null : paraCents(iComp.value);
        // igual ao cheio não é engano, é "sem promoção" — limpa em vez de brigar
        if (p.preco_promo !== null && p.preco_promo >= p.preco) p.preco_promo = null;
        p.estoque = Number(iEst.value) || 0;
        p.sku = iSku.value.trim();
        p.peso_g = Number(iPeso.value) || 0;
        p.comp_cm = Number(iC.value) || 0; p.larg_cm = Number(iL.value) || 0; p.alt_cm = Number(iA.value) || 0;
      } else {
        // com variantes: o preço do produto é o MENOR ("a partir de" da vitrine)
        p.variantes.forEach(function (v) {
          if (v.preco_promo !== null && v.preco_promo >= v.preco) v.preco_promo = null;
        });
        var ps = p.variantes.map(function (v) { return Number(v.preco) || 0; }).filter(function (n) { return n > 0; });
        p.preco = ps.length ? Math.min.apply(null, ps) : 0;
        p.preco_promo = null;
      }
      salvar.disabled = true; salvar.textContent = "Salvando…";
      bSalvarBarra.disabled = true; bSalvarBarra.textContent = "Salvando…";
      var corpo = {
        id: p.id || "", nome: p.nome, slug: p.slug, descricao: p.descricao, legenda: p.legenda, status: p.status,
        preco: p.preco, preco_promo: p.preco_promo, seo: p.seo, tags: p.tags,
        opcoes: p.opcoes, categorias: p.categorias, galeria: p.galeria,
        video_asset: p.video_asset, video_links: p.video_links,
        variantes: p.variantes.length ? p.variantes
          : [{
            combinacao: {}, preco: p.preco, preco_promo: p.preco_promo, estoque: p.estoque,
            vender_sem_estoque: p.vender_sem_estoque, sku: p.sku, gtin: p.gtin,
            peso_g: p.peso_g, comp_cm: p.comp_cm, larg_cm: p.larg_cm, alt_cm: p.alt_cm, ativo: true,
          }],
      };
      fetch("/api/admin/produto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          salvar.disabled = false; salvar.textContent = "Salvar";
          bSalvarBarra.disabled = false; bSalvarBarra.textContent = "Salvar";
          if (d && d.ok) {
            limpaSujo();
            aviso("Produto salvo.");
            p.slug = d.slug || p.slug;
            slugSalvo = p.slug;
            iSlug.value = p.slug;
            slugTocado = true; // já existe endereço salvo: não seguir mais o nome
            pintarSeo();
            if (!p.id) { p.id = d.id; history.replaceState(null, "", "/admin/produto?id=" + encodeURIComponent(d.id)); }
          } else aviso(d && d.erro === "promo_maior" ? "O preço promocional precisa ser MENOR que o preço cheio." : d && d.erro === "nome" ? "Dê um nome ao produto." : "Não deu para salvar.", true);
        })
        .catch(function () {
          salvar.disabled = false; salvar.textContent = "Salvar";
          bSalvarBarra.disabled = false; bSalvarBarra.textContent = "Salvar";
          aviso("Falha de rede.", true);
        });
    }
    salvar.addEventListener("click", salvarAgora);
    bSalvarBarra.addEventListener("click", salvarAgora);

    pintarGaleria();
    pintarVideo();
    pintarOpcoes();
    regenera();
    pintarSeo();
    limpaSujo(); // o desenho inicial dispara eventos; começa sempre "salvo"
  }

  // ── carrega dados e desenha ───────────────────────────────────────────────
  Promise.all([
    fetch("/api/admin/categorias").then(function (r) { return r.json(); }).catch(function () { return null; }),
    novo ? Promise.resolve(null) : fetch("/api/admin/produto?id=" + encodeURIComponent(id)).then(function (r) { return r.json(); }).catch(function () { return null; }),
    fetch("/api/admin/config").then(function (r) { return r.json(); }).catch(function () { return null; }),
  ]).then(function (res) {
    categoriasTodas = (res[0] && res[0].categorias) || [];
    var cfg = res[2];
    if (cfg && cfg.ok && cfg.config && cfg.config.limiar_ultimas_unidades) LIMIAR_ULTIMAS = cfg.config.limiar_ultimas_unidades;
    var d = res[1];
    if (d && d.ok) {
      var x = d.produto;
      var vs = (x.variantes || []).map(function (v) {
        return {
          id: v.id, combinacao: v.combinacao || {}, preco: v.preco, preco_promo: v.preco_promo,
          estoque: v.estoque, vender_sem_estoque: !!v.vender_sem_estoque, sku: v.sku || "", gtin: v.gtin || "",
          peso_g: v.peso_g, comp_cm: v.comp_cm, larg_cm: v.larg_cm, alt_cm: v.alt_cm,
          imagem_asset: v.imagem_asset || null, ativo: !!v.ativo,
        };
      });
      var unica = vs.length === 1 && !Object.keys(vs[0].combinacao || {}).length;
      slugTocado = true; // produto salvo já tem endereço próprio; não seguir o nome
      p = {
        id: x.id, slug: x.slug, nome: x.nome, descricao: x.descricao || "", legenda: x.legenda || "", status: x.status,
        preco: unica ? vs[0].preco : x.preco, preco_promo: unica ? vs[0].preco_promo : x.preco_promo,
        estoque: unica ? vs[0].estoque : 0,
        vender_sem_estoque: unica ? vs[0].vender_sem_estoque : false,
        sku: unica ? vs[0].sku : "", gtin: unica ? vs[0].gtin : "",
        peso_g: unica ? vs[0].peso_g : 0, comp_cm: unica ? vs[0].comp_cm : 0, larg_cm: unica ? vs[0].larg_cm : 0, alt_cm: unica ? vs[0].alt_cm : 0,
        opcoes: (x.opcoes || []).map(function (o) { return { nome: o.nome, valores: o.valores || [] }; }),
        variantes: unica ? [] : vs,
        categorias: x.categorias || [],
        galeria: (x.galeria || []).map(function (g) { return { asset_id: g.asset_id, tipo: g.tipo }; }),
        video_asset: x.video_asset || null,
        video_links: x.video_links && typeof x.video_links === "object"
          ? { instagram: x.video_links.instagram || "", tiktok: x.video_links.tiktok || "" }
          : { instagram: "", tiktok: "" },
        seo: x.seo && typeof x.seo === "object" ? { titulo: x.seo.titulo || "", descricao: x.seo.descricao || "" } : { titulo: "", descricao: "" },
        tags: Array.isArray(x.tags) ? x.tags : [],
      };
    }
    pintar();
  });
})();
