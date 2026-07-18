# Auditoria — Tokenização da loja (reancoragem no design system)

**Data:** 2026-07-17 · **Branch:** `ds-tokenizacao`

## Estado inicial
Loja real (`index.html`) = **arquivo único, ~2211 linhas**, com **4 blocos `<style>`** inline (fontes base64 + `:root` + CSS de componentes), **~85 cores hex cravadas na mão**, sem tokenização e sem folhas de estilo externas.

## O que foi feito
1. **Extração** — os 4 blocos `<style>` viraram `css/tokens.css` (paleta + semântico + tokens do brandbook, reutilizada da fase de DS) + `css/components.css` (todo o CSS de componente). As fontes `@font-face` e o `:root` do bloco 1 foram descartados (a `tokens.css` já os cobre; fontes idênticas por md5). `index.html` passou a carregar as duas folhas via `<link>`.
2. **Tokenização** — **todo hex de cor** virou `var(--token)`; resultado: **0 hex fora de `css/tokens.css`**. Tokens novos criados:
   - Impressão (`@media print`): `--print-ink:#000`, `--print-line:#CCC`, `--print-muted`.
   - `--hint-ok-text:#3F6F4A` (texto de cupom OK), `--mask-ink:#000` (stop de mask-image), `--mizu-text-alt:#2C4A44` (teal quase-duplicado em CSS órfão do Projeto Exclusivo).
   - Nenhum token pré-existente teve o valor alterado.
3. **Fixes de UI** — removido o **box de escassez** (`.scarce`, função + chamada + CSS); os badges de estado (`.pbadge.last/.presale/.soldout`) permanecem. Botão secundário (transparente) e botão do buyCard (primário) já estavam corretos na live — sem mudança.
4. **Migração semântica** (dark-ready, claro idêntico) — superfícies e texto de corpo passaram a usar tokens semânticos: `background:var(--white)`→`--surface`, `--warm`→`--raised`, `color:var(--ink)`→`--text`. Fills de botão, bordas e texto-sobre-fill foram deixados para a fase de tema escuro (0.5b).

## Harness (anti-regressão)
- **stylelint** `color-no-hex` (0 hex em CSS, exceto `tokens.css`) + **guard grep** (`scripts/check-no-hardcoded-color.sh`) para HTML/JS/SVG.
- **pre-commit** (husky) + **CI** (`.github/workflows/ds-guard.yml`) rodam `npm run lint`. Hook verificado bloqueando um hex plantado.
- **Exceção documentada:** `Suzu_sininho.svg` (ilustração autoral carregada via `<img src>`, fora do DOM — `var(--token)` não alcança) é excluída do guard. Alternativa futura: inlinar o SVG para tokenizar seus 26 fills. **Precisa do aval do dono do DS.**

## Resultado
`npm run lint` **verde**; loja renderiza **idêntica à live** no tema claro (cada troca foi para um token de mesmo valor). Loja pronta para o tema escuro (0.5b).

## Pendências (fora do escopo desta reancoragem)
- **Aval do dono do DS** sobre a exceção do `Suzu_sininho.svg` (ou inlinar o SVG).
- Limpeza de paleta: 3 teals quase-idênticos (`--mizu-text #233F3D`, `--coinfo-text #2C4744`, `--mizu-text-alt #2C4A44`) e `#000` sob dois nomes (`--print-ink`/`--mask-ink`) — decidir consolidação.
- CSS órfão `.exreassure`/`.exrq` (não referenciado no `index.html`).
- **Tema escuro (0.5b)** e demais itens do `GAP_Brandbook_DS.md` (tipografia, espaçamento, movimento, doc de logo/ícones/padrões).
