#!/usr/bin/env bash
# Falha se houver cor hex hardcoded em HTML/JS. Hex só pode viver em css/tokens.css.
set -euo pipefail

# Arquivos a checar: HTML/JS/SVG rastreados fora de css/ (o CSS é coberto pelo stylelint).
# NUL-delimitado + loop para ser robusto a nomes de arquivo com espaços.
# Regex de hex; ignoramos linhas com base64 de fonte (contêm 'base64' ou 'd09GMg').
hits=$(
  git ls-files -z '*.html' '*.js' '*.svg' \
    | { grep -zv '^css/' || true; } \
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
