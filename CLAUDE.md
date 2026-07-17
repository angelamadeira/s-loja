# Loja Suzu — regras para edições

Esta loja segue o Brandbook Suzu (regra de ouro) e um design system tokenizado.

## Ao editar qualquer arquivo:
- **Nunca** escreva cor hex fora de `css/tokens.css`. Use `var(--token)`.
- Se precisar de uma cor que não existe, **adicione o token em `css/tokens.css` primeiro** (valor confirmado no brandbook), depois referencie por `var()`.
- Tipografia: só Jost (`--sans`); Cormorant itálico (`--serif`) apenas para detalhe.
- Componentes novos vão em `css/components.css` e devem aparecer em `design-system.html`.
- Antes de finalizar: rode `npm run lint` (precisa passar).

## Verificação
`npm run lint` = stylelint (CSS) + guarda grep (HTML/JS). O CI e o git hook rodam o mesmo.

## Camadas de token (0.5a)
- `css/tokens.css` tem 2 camadas: PALETA (bruta, nunca troca) e SEMÂNTICO (papéis).
- Em componentes, use os SEMÂNTICOS para superfície/texto (`--surface`, `--raised`, `--text`, `--line`…), não os de paleta (`--white`, `--ink`) — é o que faz o tema escuro (0.5b) funcionar.
- Valores α (rgba) são tokens legítimos; **nunca achate um α em hex sólido** (regra do brandbook).
