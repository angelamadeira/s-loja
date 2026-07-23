# Auditoria — Espaçamento & Raio (para tokenização + harness)

**Data:** 2026-07-22
**Escopo:** `css/components.css` (+ inline em `index.html`)
**Natureza:** Relatório read-only. Nada foi alterado. Serve para você aprovar o **mapa** antes de qualquer refactor.
**Análoga a:** `AUDITORIA_tokens.md` (a que precedeu a tokenização de cor na Fase 0).

---

## 1. Números

| Categoria | px cru | Já em token | Tokens existentes |
|---|---:|---:|---|
| `padding` / `margin` / `gap` | **535** | 0 | `--space-1..8` (existe, **nunca usado**) |
| `border-radius` | **88** | 0 | **nenhum token de raio** |

**Total: 623 declarações** para decidir. A escala `--space` foi *aspiracional* — está definida mas não referenciada em lugar nenhum.

---

## 2. A descoberta central: a loja é 2px, não 8px

Frequência real dos valores de espaçamento (top):

| valor | freq | na grade 4/8? |
|---:|---:|:--|
| 12px | 61 | ✅ `--space-3` |
| 16px | 46 | ✅ `--space-4` |
| **14px** | **46** | ❌ +2 |
| **22px** | **45** | ❌ +2 |
| **10px** | **41** | ❌ +2 |
| **18px** | **39** | ❌ +2 |
| 8px | 38 | ✅ `--space-2` |
| **20px** | **34** | ❌ +4 |
| **6px** | **32** | ❌ +2 |
| **9px** | **28** | ❌ |
| 24px | 25 | ✅ `--space-5` |
| **11px** | **25** | ❌ |
| 4px | 21 | ✅ `--space-1` |

**On-grid (4/8/12/16/24/32/48/64):** ~204 declarações → trocáveis **1:1, zero mudança visual**.
**Off-grid:** ~331 declarações, concentradas em **6, 9, 10, 11, 14, 18, 20, 22, 26** — o design foi afinado num passo de **2px**, não de 4/8.

> Consequência: **não existe swap mecânico como foi na cor.** `#A6C9CC` *era* exatamente `--mizu`. `14px` **não é** `--space-4` (16px) — forçar move pixel, na tela, em ~220 lugares.

---

## 3. Fork de decisão — ESPAÇAMENTO (precisa de você)

| | **A · Preservar (escala 2px)** | **B · Normalizar (base 4px)** ⟵ recomendada |
|---|---|---|
| Escala | ~14 tokens: 2,4,6,8,10,12,14,16,18,20,22,24,26,32… | 10 tokens: 4,8,12,16,20,24,32,40,48,64 |
| Mudança visual | **Zero** (re-encoda cada valor) | ~220 spots deslocam ±2px |
| Qualidade de DS | Fraca — tantos passos que "sistema" vira lista | Forte — poucos passos, decisão clara |
| QA visual | Nenhum | 1 passada (claro + escuro, web + mobile) |

**Recomendação: B.** Um sistema com 10 degraus vale mais que fidelidade pixel-a-pixel a valores afinados na mão. Os ±2px somem individualmente; o ganho é ter um ritmo real que trava drift pra sempre. Mapa de snap proposto:

| px atual | → token | Δ |
|---:|:--|:--|
| 3, 4, 5 | `--space-1` (4px) | ±1 |
| 6, 7, 8, 9 | `--space-2` (8px) | ±2 |
| 10, 11, 12, 13 | `--space-3` (12px) | ±2 |
| 14, 15, 16, 17 | `--space-4` (16px) | ±2 |
| 18, 20, 22 | `--space-5` (20px)* | ±2 |
| 24, 26 | `--space-6` (24px) | ±2 |
| 28, 30, 32, 34 | `--space-7` (32px) | ±4 |
| 36–44 | `--space-8` (40px) | ±4 |
| 48, 52 | `--space-9` (48px) | ±4 |
| 56–72 | `--space-10` (64px) | ±8 |

\*Adiciona **20px** e **40px** à escala (hoje ausentes) porque 20px(34) e 40px são frequentes — evita snap grande no meio.
**2px** e **1px** *não* viram token de espaçamento: quase sempre são borda/ajuste óptico, não ritmo (ver §5).

---

## 4. RAIO — sem fork, dá pra fazer já

Raio **tolera arredondamento** (1–2px de raio é imperceptível). Valores atuais e escala proposta:

| freq | px atual | → token proposto |
|---:|---:|:--|
| 35 | `50%` | `--radius-circle` (avatares, dots) |
| 17 | `999px` | `--radius-pill` (chips, botões-pílula) |
| 11+8+8+1 | 12, 13, 11, 9 | `--radius-sm` (12px) |
| 10+8+8 | 14, 16, 18 | `--radius-md` (16px) |
| 7+8+4 | 20, 22, 24 | `--radius-lg` (22px) |
| 4 | 10 | `--radius-sm` (12px) |
| 1 | 3 | `--radius-xs` (4px) |

→ **5 tokens de raio** (`xs/sm/md/lg` + `pill` + `circle`) cobrem os 88 valores. Mudança visual: sub-1px, invisível.

---

## 5. O que NÃO vira token (e por que a trava precisa ser cirúrgica)

Diferente de cor, `px` é legítimo em vários contextos que **não** são design tokens. A regra do stylelint **não pode** ser "proíbe todo px" — mataria:

- **Bordas:** `border: 1px`, `2px` — largura de traço, não ritmo.
- **Breakpoints:** `@media (max-width: 980px)` — os `980`, `1028`, `330` na amostra são media queries.
- **Dimensões fixas:** `max-width: 400px`, avatar `44px`, alvo de toque.
- **Transforms / deslocamentos ópticos:** `translateY(1px)`.

Por isso a trava nova será **escopada a `padding`, `margin`, `gap`, `border-radius`** — não a `px` em geral. Fora dessas propriedades, px continua livre.

---

## 6. Plano de execução (depois do seu OK ao mapa)

1. **`tokens.css`** — adicionar `--space-9/10`, `--space-5:20px`, e os 6 tokens de raio (camada SEMÂNTICO).
2. **`components.css`** — refatorar 623 declarações para `var(--…)` conforme o mapa (§3 opção B + §4).
3. **`design-system.html`** — nova seção "Espaçamento & Raio" renderizando a escala.
4. **Harness** — 2ª regra: stylelint (via `declaration-property-value-disallowed-list`) barrando px cru em `padding|margin|gap|border-radius`; o script grep ganha o mesmo escopo pro HTML/JS.
5. **QA visual** — 1 passada claro/escuro × web/mobile validando os ±2px.
6. **`CLAUDE.md`** — regra: "espaçamento/raio só via `var(--space-*)` / `var(--radius-*)`".

**Risco:** só o passo 5 (visual). Reversível — o refactor é 1 commit, dá pra comparar antes/depois no design-system.

---

## 7. Decisão — APROVADA (2026-07-22)

- [x] **Espaçamento: opção B — normalizar (base 4px).** Escala de 10 degraus + QA visual.
- [x] **Raio: escala de 5 tokens do §4 — sim.**

Refactor + trava liberados. Executado na branch `ds-espacamento`.
