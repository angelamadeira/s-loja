#!/usr/bin/env bash
# Falha se houver px CRU em padding/margin/gap/border-radius fora de token.
# Espaçamento/raio só podem viver como var(--space-*) / var(--r-*) — a escala mora em css/tokens.css.
#
# PERMITIDO (não é drift): var(), 0, %, e px dentro de funções FLUIDAS/funcionais
# (clamp/calc/min/max/env) — espaçamento responsivo e insets de safe-area são intencionais.
# A escala (css/tokens.css) é a única exceção: é lá que os px viram token.
set -euo pipefail

files=$(git ls-files '*.css' '*.html' | { grep -vE '^css/tokens\.css$' || true; })
viol=""
for f in $files; do
  hits=$(perl -ne '
    while (/\b(padding[\w-]*|margin[\w-]*|gap|row-gap|column-gap|border-radius)\s*:\s*([^;}{"\x27]+)/g) {
      my ($p,$v)=($1,$2);
      my $s=$v;
      1 while $s =~ s/\b(?:clamp|calc|min|max|env|var)\([^()]*\)//g;  # remove funções (até aninhadas)
      if ($s =~ /-?\d+px/) { print "  $ARGV:$.  $p:$v\n"; }
    }
  ' "$f" 2>/dev/null || true)
  [ -n "$hits" ] && viol="${viol}${hits}"$'\n'
done

if [ -n "$(printf '%s' "$viol" | tr -d '[:space:]')" ]; then
  echo "✖ px cru em espaçamento/raio fora de token:"
  printf '%s\n' "$viol"
  echo "Use var(--space-*) ou var(--r-*). Se o degrau não existe, ajuste a escala em css/tokens.css."
  exit 1
fi
echo "✓ Espaçamento/raio: nenhum px cru fora de token."
