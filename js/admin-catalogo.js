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
