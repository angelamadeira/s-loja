# Loja Suzu — regras para edições

Esta loja segue o Brandbook Suzu (regra de ouro) e um design system tokenizado.

## Ao editar qualquer arquivo:
- **Nunca** escreva cor hex fora de `css/tokens.css`. Use `var(--token)`.
- Se precisar de uma cor que não existe, **adicione o token em `css/tokens.css` primeiro** (valor confirmado no brandbook), depois referencie por `var()`.
- **Nunca** escreva px cru em `padding`/`margin`/`gap`/`border-radius`. Use `var(--space-*)` (escala base 4px: `--space-2xs`=2, `--space-1`=4 … `--space-10`=64) e `var(--r-*)` (`--r-xs`…`--r-2xl`, `--r-pill`, `--r-round`). Se o degrau não existe, ajuste a escala em `css/tokens.css` primeiro. **Exceção permitida:** px dentro de `clamp/calc/min/max/env` (espaçamento fluido/insets) — não é drift.
- Tipografia: só Jost (`--sans`); Cormorant itálico (`--serif`) apenas para detalhe.
- Componentes novos vão em `css/components.css` e devem aparecer em `design-system.html`.
- Antes de finalizar: rode `npm run lint` (precisa passar).

## Verificação
`npm run lint` = stylelint (cor) + guarda de cor (HTML/JS) + guarda de espaçamento/raio (`check-no-hardcoded-space.sh`). O CI e o git hook rodam o mesmo.

## Camadas de token (0.5a)
- `css/tokens.css` tem 2 camadas: PALETA (bruta, nunca troca) e SEMÂNTICO (papéis).
- Em componentes, use os SEMÂNTICOS para superfície/texto (`--surface`, `--raised`, `--text`, `--line`…), não os de paleta (`--white`, `--ink`) — é o que faz o tema escuro (0.5b) funcionar.
- Valores α (rgba) são tokens legítimos; **nunca achate um α em hex sólido** (regra do brandbook).
