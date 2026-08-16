/* Site no Admin (F2) — Página inicial (barra de anúncio) e Páginas de
   conteúdo (Termos/Trocas/Entrega/Privacidade) com rascunho→publicado.
   Edição ESTRUTURADA: texto com convenções, nunca HTML — quem monta é a
   vitrine, escapando tudo. REGRA DE OURO: dado do banco só via textContent. */
(function () {
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function qs(nome) { return new URLSearchParams(location.search).get(nome) || ""; }
  function dataBr(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) + " · " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
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
  function aviso(cont, t, erro) {
    var m = cont.querySelector(".amsg") || cont.appendChild(el("div", "amsg"));
    m.className = erro ? "amsg err" : "amsg";
    m.textContent = t;
    m.hidden = false;
    clearTimeout(aviso._t);
    aviso._t = setTimeout(function () { m.hidden = true; }, 4000);
  }

  var ESTADO = {
    publicada: ["No ar", "ok"],
    rascunho: ["Rascunho guardado", "espera"],
    codigo: ["Texto original do site", "neutro"],
  };

  // ── PÁGINAS — lista ───────────────────────────────────────────────────────
  function telaPaginas(cont) {
    cont.textContent = "";
    cabecalho(cont, "Páginas", "Os textos do site — editar aqui dispensa mexer no código.");
    var lista = el("div", "alista");
    cont.appendChild(lista);
    fetch("/api/admin/paginas")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        ((d && d.paginas) || []).forEach(function (p) {
          var a = el("a", "aitem avenda");
          a.href = "/admin/pagina?slug=" + encodeURIComponent(p.slug);
          var esq = el("div");
          esq.appendChild(el("div", "aitem-nome", p.titulo));
          var meta = el("div", "aitem-meta");
          meta.appendChild(el("span", null, "/" + p.slug));
          if (p.atualizado_em) meta.appendChild(el("span", null, "editada " + dataBr(p.atualizado_em)));
          esq.appendChild(meta);
          var dir = el("div", "aitem-side");
          var st = ESTADO[p.estado] || [p.estado, "neutro"];
          dir.appendChild(el("span", "abadge abadge-" + st[1], st[0]));
          a.appendChild(esq);
          a.appendChild(dir);
          lista.appendChild(a);
        });
      })
      .catch(function () { lista.appendChild(el("div", "avazio", "Não deu para carregar. Recarregue a página.")); });
  }

  // ── PÁGINA — editor ───────────────────────────────────────────────────────
  function telaPagina(cont) {
    var slug = qs("slug");
    if (!slug) { location.href = "/admin/paginas"; return; }
    cont.textContent = "";
    fetch("/api/admin/paginas")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var p = ((d && d.paginas) || []).find(function (x) { return x.slug === slug; });
        if (!p) { cont.appendChild(el("div", "avazio", "Página não encontrada.")); return; }
        var head = cabecalho(cont, p.titulo, "/" + p.slug, "/admin/paginas", "Páginas");
        var st = ESTADO[p.estado] || [p.estado, "neutro"];
        head.appendChild(el("span", "abadge abadge-" + st[1], st[0]));

        var sec = el("div", "asec");
        var lT = el("label", "afield");
        lT.appendChild(el("span", null, "Título"));
        var iT = document.createElement("input");
        iT.type = "text"; iT.value = p.titulo; iT.maxLength = 120;
        lT.appendChild(iT);
        sec.appendChild(lT);

        var lC = el("label", "afield");
        lC.appendChild(el("span", null, "Texto da página"));
        var iC = document.createElement("textarea");
        iC.className = "apag-corpo";
        iC.value = p.corpo || "";
        iC.placeholder = "O texto da página. Se ficar vazio, o site continua mostrando o texto original.";
        lC.appendChild(iC);
        sec.appendChild(lC);

        var dica = el("p", "ahint");
        dica.textContent = "Como formatar: \"### \" no começo da linha vira um título de seção · \"- \" vira item de lista · **palavra** vira negrito · linha em branco separa parágrafos. Links e e-mails escritos por extenso viram clicáveis sozinhos.";
        sec.appendChild(dica);
        cont.appendChild(sec);

        var acoes = el("div", "apag-acoes");
        var bRasc = el("button", "btn ghost", "Salvar rascunho");
        var bPub = el("button", "btn", p.estado === "publicada" ? "Publicar alterações" : "Publicar no site");
        acoes.appendChild(bRasc);
        acoes.appendChild(bPub);
        if (p.estado === "publicada") {
          var bDes = el("button", "btn ghost", "Tirar do ar (volta o texto original)");
          bDes.addEventListener("click", function () {
            if (!confirm("Tirar esta versão do ar? O site volta a mostrar o texto original do código.")) return;
            fetch("/api/admin/pagina/despublicar", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ slug: slug }),
            }).then(function (r) { return r.json(); }).then(function (rr) {
              if (rr && rr.ok) location.reload();
            });
          });
          acoes.appendChild(bDes);
        }
        cont.appendChild(acoes);

        function salva(publicar) {
          var corpo = iC.value;
          if (publicar && !corpo.trim()) { aviso(cont, "A página está vazia — escreva o texto antes de publicar.", true); iC.focus(); return; }
          bRasc.disabled = bPub.disabled = true;
          fetch("/api/admin/pagina", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ slug: slug, titulo: iT.value, corpo: corpo, publicado: !!publicar }),
          }).then(function (r) { return r.json(); }).then(function (rr) {
            bRasc.disabled = bPub.disabled = false;
            if (rr && rr.ok) {
              aviso(cont, publicar ? "Publicado — o site atualiza em até meio minuto." : "Rascunho guardado.");
              if (publicar) setTimeout(function () { location.reload(); }, 900);
            } else {
              aviso(cont, rr && rr.erro === "vazia" ? "A página está vazia — escreva o texto antes de publicar." : "Não deu para salvar.", true);
            }
          }).catch(function () {
            bRasc.disabled = bPub.disabled = false;
            aviso(cont, "Sem conexão — tente de novo.", true);
          });
        }
        bRasc.addEventListener("click", function () { salva(false); });
        bPub.addEventListener("click", function () { salva(true); });
      })
      .catch(function () { cont.appendChild(el("div", "avazio", "Não deu para carregar. Recarregue a página.")); });
  }

  // ── PÁGINA INICIAL — barra de anúncio ─────────────────────────────────────
  function telaHome(cont) {
    cont.textContent = "";
    cabecalho(cont, "Página inicial", "O que dá para mudar sem mexer no código.");
    fetch("/api/admin/config")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var cfg = (d && d.config) || {};
        var av = cfg.aviso || { ligado: false, texto: "", link: "" };

        var sec = el("div", "asec");
        sec.appendChild(el("div", "asec-title", "Barra de anúncio"));
        sec.appendChild(el("p", "apage-sub", "Troca o texto da faixa do topo da loja — frete grátis, coleção nova, pausa de férias. Desligada, a faixa volta ao texto padrão."));

        var lig = el("label", "apag-toggle");
        var chk = document.createElement("input");
        chk.type = "checkbox"; chk.checked = !!av.ligado;
        lig.appendChild(chk);
        lig.appendChild(el("span", null, "Mostrar a barra na loja"));
        sec.appendChild(lig);

        var lTx = el("label", "afield");
        lTx.appendChild(el("span", null, "Texto (até 140)"));
        var iTx = document.createElement("input");
        iTx.type = "text"; iTx.maxLength = 140; iTx.value = av.texto || "";
        iTx.placeholder = "Frete grátis acima de R$ 150 🌸";
        lTx.appendChild(iTx);
        sec.appendChild(lTx);

        var lLk = el("label", "afield");
        lLk.appendChild(el("span", null, "Link (opcional — para onde a barra leva)"));
        var iLk = document.createElement("input");
        iLk.type = "text"; iLk.value = av.link || "";
        iLk.placeholder = "/produtos ou https://…";
        lLk.appendChild(iLk);
        sec.appendChild(lLk);

        var b = el("button", "btn", "Salvar");
        b.addEventListener("click", function () {
          if (chk.checked && !iTx.value.trim()) { aviso(cont, "Escreva o texto da barra antes de ligar.", true); iTx.focus(); return; }
          b.disabled = true;
          fetch("/api/admin/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ aviso: { ligado: chk.checked, texto: iTx.value, link: iLk.value } }),
          }).then(function (r) { return r.json(); }).then(function (rr) {
            b.disabled = false;
            if (rr && rr.ok) aviso(cont, "Salvo — a loja atualiza em até meio minuto.");
            else aviso(cont, "Não deu para salvar.", true);
          }).catch(function () { b.disabled = false; aviso(cont, "Sem conexão — tente de novo.", true); });
        });
        sec.appendChild(b);
        cont.appendChild(sec);

        var nota = el("div", "asec");
        nota.appendChild(el("div", "asec-title", "Destaques e ordem da vitrine"));
        var pn = el("p", "apage-sub");
        pn.textContent = "O carrossel e a ordem da home vêm dos produtos: marque \"Destaque\" e arraste a ordem em ";
        var lk = el("a", "apage-sub-link", "Produtos");
        lk.href = "/admin/produtos";
        pn.appendChild(lk);
        pn.appendChild(document.createTextNode("."));
        nota.appendChild(pn);
        cont.appendChild(nota);
      })
      .catch(function () { cont.appendChild(el("div", "avazio", "Não deu para carregar. Recarregue a página.")); });
  }

  var alvo;
  if ((alvo = document.getElementById("paginas"))) telaPaginas(alvo);
  else if ((alvo = document.getElementById("pagina"))) telaPagina(alvo);
  else if ((alvo = document.getElementById("home"))) telaHome(alvo);
})();
