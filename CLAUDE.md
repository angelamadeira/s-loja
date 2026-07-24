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

## Deploy — REGRA DE OURO (nunca pular)
O worker `s-loja` **é produção** (serve `studiosuzu.com.br`); `s-loja-preview` é a **prévia/staging**.

**INVARIANTE (nunca violar): staging ≥ prod.**
- Staging (`s-loja-preview`) PODE estar mais atualizado que prod (código novo em teste, ainda não promovido).
- Prod (`s-loja`) **NUNCA** pode estar mais atualizado que staging. Prod jamais recebe código que não passou por staging antes.
- Fluxo obrigatório de toda mudança: **editar → deploy em staging (`wrangler deploy --env preview`) → testar lá → só então promover pra prod (`wrangler deploy`)**. Nunca o inverso, nunca pulando o staging.
- Ao promover pra prod, deployar a MESMA versão em staging também (manter os dois em dia; staging nunca fica “atrás”).

Detalhes:
- **NUNCA** rodar `wrangler deploy` (prod) com mudança que não subiu e não foi testada em staging antes.
- Só promover pra produção depois de conferir, na prévia, TUDO que a mudança afeta (ex. Fase 3: pedido → e-mail no `somos.suzu@gmail` → registro no D1 → anexo no R2 + link abrindo).
- `npm run lint` verde é pré-requisito, não substitui o teste na prévia.
- `wrangler` não é global — usar **`npx wrangler ...`** (é devDependency local).
- **Cache de borda:** depois do deploy, o CSS/HTML novo pode não aparecer (Cloudflare serve o asset antigo do cache; `?v=`/`no-cache` não furam). Conferir com `md5 css/components.css` (local) vs md5 do servido — se batem, é só cache → **Purge Everything** no painel Cloudflare (passo manual da fundadora).

## Camadas de token (0.5a)
- `css/tokens.css` tem 2 camadas: PALETA (bruta, nunca troca) e SEMÂNTICO (papéis).
- Em componentes, use os SEMÂNTICOS para superfície/texto (`--surface`, `--raised`, `--text`, `--line`…), não os de paleta (`--white`, `--ink`) — é o que faz o tema escuro (0.5b) funcionar.
- Valores α (rgba) são tokens legítimos; **nunca achate um α em hex sólido** (regra do brandbook).
