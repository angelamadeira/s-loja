/* Catálogo no Admin — lista de produtos e formulário de edição.
   Tudo montado com DOM (textContent), nunca innerHTML com dado do banco.
   Preço: a pessoa digita em REAIS; o servidor recebe CENTAVOS (conversão aqui). */
(function () {
  var BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  // "Últimas unidades" a partir daqui pra baixo. Vem de Configurações; o 8 aqui
  // é só o valor de partida enquanto a config não chega (é o mesmo padrão do
  // servidor). Antes isto era um 5 cravado — diferente do 8 da vitrine, ou seja,
  // a lista dizia "últimas unidades" numa hora em que a loja não dizia.
  var LIMIAR = 8;
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
  // Anatomia copiada da lista de produtos do SHOPIFY: miniatura + nome + selos
  // na linha do produto, e a linha ABRE (chevron) numa sub-lista com uma linha
  // por variante — cada uma com preço, estoque e disponibilidade próprios.
  // É a resposta do mercado pro problema de "o produto não tem UM preço": em vez
  // de espremer tudo numa linha só, o resumo fica em cima e o detalhe se revela.
  function pct(cheio, promo) {
    return promo && cheio && promo < cheio ? Math.round((1 - promo / cheio) * 100) : 0;
  }
  function rotuloVariante(v) {
    var vals = Object.keys(v.combinacao || {}).map(function (k) { return v.combinacao[k]; });
    return vals.length ? vals.join(" · ") : "Peça única";
  }
  // Os selos DA LOJA. Só existem "Esgotado" e "Últimas unidades" (+ a etiqueta de
  // %): "Edição limitada" está oculto por CSS na vitrine, então não entra aqui —
  // a lista tem de dizer a mesma coisa que a loja, senão não serve de nada.
  function selosDaLoja(estoque, cheio, promo, ativoNaLoja) {
    var out = [];
    if (!ativoNaLoja) return out;
    if (estoque <= 0) out.push(["achip achip-off", "esgotado"]);
    else if (estoque <= LIMIAR) out.push(["achip achip-low", "últimas unidades"]);
    var d = pct(cheio, promo);
    if (d >= 1) out.push(["achip", "−" + d + "%"]);
    return out;
  }
  function miniatura(assetId, nome) {
    var box = el("div", "amini");
    if (assetId) {
      var img = document.createElement("img");
      img.src = "/midia/" + assetId; img.alt = "";
      box.appendChild(img);
    } else {
      // sem foto: inicial do produto, pra linha não ficar com um buraco
      box.appendChild(el("span", "amini-vazio", String(nome || "?").trim().charAt(0).toUpperCase()));
    }
    return box;
  }

  function renderLista() {
    var alvo = document.getElementById("lista");
    var cont = document.getElementById("contagem");
    Promise.all([
      fetch("/api/admin/produtos").then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch("/api/admin/config").then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]).then(function (res) {
      var d = res[0], c = res[1];
      if (c && c.ok && c.config && c.config.limiar_ultimas_unidades) LIMIAR = c.config.limiar_ultimas_unidades;
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
      ps.forEach(function (p) { alvo.appendChild(linhaProduto(p)); });
    });
  }

  function linhaProduto(p) {
    var vars = p.variantes || [];
    var temVarias = vars.length > 1;
    var bloco = el("div", "aprod");

    var linha = el("div", "aitem aprod-topo");
    // abre/fecha as variantes — só existe quando há mais de uma
    var abrir = null;
    if (temVarias) {
      abrir = el("button", "aprod-abrir", "›");
      abrir.type = "button";
      abrir.setAttribute("aria-expanded", "false");
      abrir.setAttribute("aria-label", "Ver as variações de " + p.nome);
      linha.appendChild(abrir);
    } else {
      linha.appendChild(el("span", "aprod-abrir aprod-abrir-vazio"));
    }

    var link = el("a", "aprod-link");
    link.href = "/admin/produto?id=" + encodeURIComponent(p.id);
    link.appendChild(miniatura(p.capa_asset, p.nome));
    var esq = el("div", "aitem-main");
    esq.appendChild(el("div", "aitem-nome", p.nome));
    var meta = el("div", "aitem-meta");
    // faixa de preço: com variantes de preços diferentes, "de X a Y" é a verdade
    // (um preço só seria mentira sobre as outras variantes)
    if (p.preco_min != null) {
      meta.appendChild(el("span", null,
        p.preco_min === p.preco_max ? reais(p.preco_min) : reais(p.preco_min) + " – " + reais(p.preco_max)));
    }
    var est = Number(p.estoque_total) || 0;
    meta.appendChild(el("span", null, est + " em estoque"));
    if (vars.length) meta.appendChild(el("span", null, vars.length + (vars.length === 1 ? " variação" : " variações")));
    esq.appendChild(meta);
    link.appendChild(esq);
    linha.appendChild(link);

    var dir = el("div", "aitem-side");
    selosDaLoja(est, p.preco, p.preco_promo, p.status === "ativo").forEach(function (s) {
      dir.appendChild(el("span", s[0], s[1]));
    });
    dir.appendChild(el("span", "achip achip-" + p.status, p.status));
    linha.appendChild(dir);
    bloco.appendChild(linha);

    if (temVarias) {
      var sub = el("div", "avars");
      sub.hidden = true;
      vars.forEach(function (v) {
        var l = el("div", "avar-linha");
        l.appendChild(miniatura(v.imagem_asset || p.capa_asset, rotuloVariante(v)));
        var info = el("div", "aitem-main");
        info.appendChild(el("div", "avar-nome", rotuloVariante(v)));
        var m = el("div", "aitem-meta");
        m.appendChild(el("span", null, reais(v.preco_promo || v.preco)));
        if (v.preco_promo) m.appendChild(el("span", "aitem-de", reais(v.preco)));
        m.appendChild(el("span", null, (Number(v.estoque) || 0) + " em estoque"));
        if (v.sku) m.appendChild(el("span", null, v.sku));
        info.appendChild(m);
        l.appendChild(info);
        var lado = el("div", "aitem-side");
        // uma variante desmarcada de "à venda" não mostra selo de loja nenhum —
        // ela simplesmente não está lá
        if (!v.ativo) lado.appendChild(el("span", "achip achip-off", "fora de venda"));
        else selosDaLoja(Number(v.estoque) || 0, v.preco, v.preco_promo, p.status === "ativo").forEach(function (s) {
          lado.appendChild(el("span", s[0], s[1]));
        });
        l.appendChild(lado);
        sub.appendChild(l);
      });
      bloco.appendChild(sub);
      abrir.addEventListener("click", function () {
        sub.hidden = !sub.hidden;
        abrir.setAttribute("aria-expanded", sub.hidden ? "false" : "true");
        abrir.classList.toggle("aprod-abrir-on", !sub.hidden);
      });
    }
    return bloco;
  }

  if (document.getElementById("lista")) renderLista();
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
