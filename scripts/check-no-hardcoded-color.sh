#!/usr/bin/env bash
# Falha se houver cor hex hardcoded em HTML/JS. Hex só pode viver em css/tokens.css.
set -euo pipefail

# Arquivos a checar: HTML/JS/SVG rastreados fora de css/ (o CSS é coberto pelo stylelint).
# NUL-delimitado + loop para ser robusto a nomes de arquivo com espaços.
# Regex de hex; ignoramos linhas com base64 de fonte (contêm 'base64' ou 'd09GMg').
#
# EXCEÇÃO: Suzu_sininho.svg é uma ilustração autoral (mascote/guizo) carregada via
# <img src="Suzu_sininho.svg">, não inline no DOM. custom properties (var(--token))
# não atravessam a fronteira de um <img> apontando pra um SVG externo — o navegador
# renderiza esse SVG como um documento isolado, sem herdar :root da página. Tokenizar
# os fills aqui não teria efeito nenhum (ou quebraria a ilustração pra preto sólido).
# Pra tokenizar de verdade, o SVG precisaria ser inlinado no HTML — fora do escopo
# desta task. Ver relatório da Task 2 do re-ancoramento do DS.
hits=$(
  git ls-files -z '*.html' '*.js' '*.svg' \
    | { grep -zv '^css/' || true; } \
    | { grep -zvF 'Suzu_sininho.svg' || true; } \
    | while IFS= read -r -d '' f; do
        grep -nHE '#[0-9a-fA-F]{3,6}\b' "$f" 2>/dev/null || true
      done \
    | grep -vE 'base64|d09GMg' || true
)

if [ -n "$hits" ]; then
  echo "✖ Cor hex hardcoded encontrada fora de css/tokens.css:"
  echo "$hits"
  echo ""
  echo "Use var(--token). Se o token não existe, adicione em css/tokens.css primeiro."
  exit 1
fi
echo "✓ Nenhuma cor hardcoded em HTML/JS."
