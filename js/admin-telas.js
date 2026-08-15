/* Telas de apoio do admin — Estoque, Clientes, Relatórios e Mídia.
   Estoque = a "Inventory" do Shopify (edição inline do número, só dele);
   Clientes = a lista do Shopify sem o que não precisamos carregar (agregado);
   Relatórios = números do NOSSO banco; Mídia = a biblioteca de arquivos.
   REGRA DE OURO: dado do banco entra na tela SÓ via textContent. */
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
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  }
  function cabecalho(cont, titulo, sub) {
    var head = el("div", "apage-head");
    var box = el("div");
    box.appendChild(el("h1", null, titulo));
    if (sub != null) box.appendChild(el("p", "apage-sub", sub));
    head.appendChild(box);
    cont.appendChild(head);
    return head;
  }
  function vazio(msg) { return el("div", "avazio", msg); }
  function falha(cont) { cont.appendChild(vazio("Não deu para carregar. Recarregue a página.")); }

  // ── ESTOQUE ───────────────────────────────────────────────────────────────
  function telaEstoque(cont) {
    cont.textContent = "";
    cabecalho(cont, "Estoque", "Carregando…");
    var lista = el("div", "alista");
    cont.appendChild(lista);
    fetch("/api/admin/estoque")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var linhas = (d && d.estoque) || [];
        cont.querySelector(".apage-sub").textContent = linhas.length
          ? "O número que a loja vende. Preço e medidas ficam no produto."
          : "Nenhuma variante ainda.";
        if (!linhas.length) { lista.appendChild(vazio("Cadastre um produto e as variantes aparecem aqui.")); return; }
        var porProduto = {};
        linhas.forEach(function (v) { (porProduto[v.produto_id] = porProduto[v.produto_id] || []).push(v); });
        Object.keys(porProduto).forEach(function (pid) {
          var vs = porProduto[pid];
          var bloco = el("div", "aitem aestq");
          var head = el("div", "aestq-prod");
          var nomeLink = el("a", "aestq-nome", vs[0].produto);
          nomeLink.href = "/admin/produto?id=" + encodeURIComponent(pid);
          head.appendChild(nomeLink);
          if (vs[0].produto_status !== "ativo") head.appendChild(el("span", "abadge abadge-neutro", vs[0].produto_status));
          bloco.appendChild(head);
          vs.forEach(function (v) {
            var row = el("div", "aestq-var");
            var esq = el("div", "aestq-rotulo");
            esq.appendChild(el("span", null, v.rotulo));
            if (v.sku) esq.appendChild(el("small", "aestq-sku", v.sku));
            if (!v.ativo) esq.appendChild(el("span", "abadge abadge-neutro", "inativa"));
            if (v.vender_sem_estoque) esq.appendChild(el("span", "abadge abadge-espera", "vende sem estoque"));
            row.appendChild(esq);
            var dir = el("div", "aestq-num");
            var inp = document.createElement("input");
            inp.type = "number"; inp.min = "0"; inp.step = "1";
            inp.value = v.estoque;
            inp.setAttribute("aria-label", "Estoque de " + v.produto + " " + v.rotulo);
            var ok = el("span", "aestq-ok", "");
            inp.addEventListener("change", function () {
              var n = parseInt(inp.value, 10);
              if (!(n >= 0)) { inp.value = v.estoque; return; }
              fetch("/api/admin/estoque", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: v.id, estoque: n }),
              }).then(function (r) { return r.json(); }).then(function (rr) {
                if (rr && rr.ok) {
                  v.estoque = rr.para;
                  ok.textContent = "salvo";
                  setTimeout(function () { ok.textContent = ""; }, 1600);
                } else {
                  inp.value = v.estoque;
                  ok.textContent = "não salvou";
                  setTimeout(function () { ok.textContent = ""; }, 2500);
                }
              }).catch(function () { inp.value = v.estoque; });
            });
            dir.appendChild(ok);
            dir.appendChild(inp);
            row.appendChild(dir);
            bloco.appendChild(row);
          });
          lista.appendChild(bloco);
        });
      })
      .catch(function () { falha(cont); });
  }

  // ── CLIENTES ──────────────────────────────────────────────────────────────
  function telaClientes(cont) {
    cont.textContent = "";
    cabecalho(cont, "Clientes", "Carregando…");
    var lista = el("div", "alista");
    cont.appendChild(lista);
    fetch("/api/admin/clientes")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var cls = (d && d.clientes) || [];
        cont.querySelector(".apage-sub").textContent =
          cls.length === 0 ? "Quem já comprou (pagamento aprovado) aparece aqui." :
          cls.length === 1 ? "1 cliente" : cls.length + " clientes";
        if (!cls.length) { lista.appendChild(vazio("A primeira venda aprovada cria o primeiro cliente.")); return; }
        cls.forEach(function (c) {
          var a = el("a", "aitem avenda");
          a.href = "/admin/pedidos?filtro=aprovado";
          var esq = el("div");
          esq.appendChild(el("div", "aitem-nome", c.contato_email));
          var meta = el("div", "aitem-meta");
          meta.appendChild(el("span", null, c.n_pedidos === 1 ? "1 pedido" : c.n_pedidos + " pedidos"));
          meta.appendChild(el("span", null, "última: " + dataBr(c.ultima)));
          esq.appendChild(meta);
          var dir = el("div", "aitem-side");
          dir.appendChild(el("b", null, reais(c.total_gasto)));
          a.appendChild(esq);
          a.appendChild(dir);
          lista.appendChild(a);
        });
      })
      .catch(function () { falha(cont); });
  }

  // ── RELATÓRIOS ────────────────────────────────────────────────────────────
  function telaRelatorios(cont) {
    cont.textContent = "";
    cabecalho(cont, "Relatórios", "Últimos 30 dias · números do banco da loja");
    fetch("/api/admin/relatorios")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { falha(cont); return; }
        var R = d.relatorios;

        var tiles = el("div", "atiles");
        function tile(rotulo, valor, nota) {
          var t = el("div", "atile");
          t.appendChild(el("span", "atile-r", rotulo));
          t.appendChild(el("b", "atile-v", valor));
          if (nota) t.appendChild(el("small", "atile-n", nota));
          return t;
        }
        function delta(atual, antes) {
          if (!antes) return atual ? "novo" : "";
          var pct = Math.round(((atual - antes) / antes) * 100);
          return (pct >= 0 ? "+" : "") + pct + "% vs 30 dias antes";
        }
        tiles.appendChild(tile("Receita", reais(R.receita), delta(R.receita, R.anterior.receita)));
        tiles.appendChild(tile("Vendas", String(R.vendas), delta(R.vendas, R.anterior.vendas)));
        tiles.appendChild(tile("Ticket médio", R.vendas ? reais(R.ticket) : "—"));
        tiles.appendChild(tile("Aguardando pagamento", String(R.aguardando)));
        cont.appendChild(tiles);

        var top = el("div", "asec");
        top.appendChild(el("div", "asec-title", "Mais vendidas"));
        if (!R.top.length) {
          top.appendChild(el("p", "apage-sub", "Sem venda aprovada na janela."));
        } else {
          R.top.forEach(function (t) {
            var row = el("div", "avenda-item");
            row.appendChild(el("span", null, t.nome + " — " + (t.pecas === 1 ? "1 peça" : t.pecas + " peças")));
            row.appendChild(el("b", null, reais(t.receita)));
            top.appendChild(row);
          });
        }
        cont.appendChild(top);

        var orc = el("div", "asec");
        orc.appendChild(el("div", "asec-title", "Orçamentos (todo o período)"));
        var mapa = [["novo", "Novos"], ["respondido", "Respondidos"], ["orcado", "Orçados"], ["fechado", "Fechados"], ["perdido", "Perdidos"]];
        mapa.forEach(function (par) {
          var row = el("div", "adado");
          row.appendChild(el("span", "adado-r", par[1]));
          row.appendChild(el("span", "adado-v", String(R.orcamentos[par[0]] || 0)));
          orc.appendChild(row);
        });
        cont.appendChild(orc);

        var nota = el("p", "apage-sub");
        nota.textContent = "Visitas e origem do tráfego entram quando o Cloudflare Web Analytics for ligado.";
        cont.appendChild(nota);
      })
      .catch(function () { falha(cont); });
  }

  // ── MÍDIA ─────────────────────────────────────────────────────────────────
  function telaMidia(cont) {
    cont.textContent = "";
    cabecalho(cont, "Mídia", "Carregando…");
    var grade = el("div", "amidia");
    cont.appendChild(grade);
    fetch("/api/admin/midia")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var mds = (d && d.midia) || [];
        cont.querySelector(".apage-sub").textContent = mds.length
          ? (mds.length === 1 ? "1 arquivo" : mds.length + " arquivos") + " · para subir mídia, use o formulário do produto"
          : "Nenhum arquivo ainda.";
        if (!mds.length) { grade.appendChild(vazio("As imagens e vídeos dos produtos moram aqui.")); return; }
        mds.forEach(function (a) {
          var card = el("div", "amidia-card");
          var thumb = el("div", "amidia-thumb");
          var ehVideo = (a.tipo || "").indexOf("video/") === 0;
          var img = document.createElement("img");
          img.loading = "lazy";
          img.alt = a.nome || "";
          img.src = "/midia/" + encodeURIComponent(ehVideo && a.poster_asset ? a.poster_asset : a.id);
          thumb.appendChild(img);
          if (ehVideo) thumb.appendChild(el("span", "amidia-play", "▶"));
          card.appendChild(thumb);
          var info = el("div", "amidia-info");
          info.appendChild(el("b", null, a.nome || "sem nome"));
          var m = [];
          if (a.largura && a.altura) m.push(a.largura + "×" + a.altura);
          if (a.bytes) m.push(Math.round(a.bytes / 1024) + " KB");
          info.appendChild(el("small", null, m.join(" · ") || a.tipo));
          if (a.usos.length) {
            a.usos.slice(0, 3).forEach(function (u) { info.appendChild(el("small", "amidia-uso", u)); });
            if (a.usos.length > 3) info.appendChild(el("small", "amidia-uso", "+" + (a.usos.length - 3)));
          } else {
            info.appendChild(el("small", "amidia-uso amidia-solto", "sem uso"));
          }
          card.appendChild(info);
          grade.appendChild(card);
        });
      })
      .catch(function () { falha(cont); });
  }

  var alvo;
  if ((alvo = document.getElementById("estoque"))) telaEstoque(alvo);
  else if ((alvo = document.getElementById("clientes"))) telaClientes(alvo);
  else if ((alvo = document.getElementById("relatorios"))) telaRelatorios(alvo);
  else if ((alvo = document.getElementById("midia"))) telaMidia(alvo);
})();
