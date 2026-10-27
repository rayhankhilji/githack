# Probation + Undertaker — Design System

> Version: 1.0 · Updated: 2026-10-26.
>
> **Scope:** two server-rendered pages (the Probation Board and the Tallybook dashboard) plus the developer experience of the CI messages, which matters as much as the pages here. MR notes, issue bodies and CLI output are the product's main UI.

## 1. Design Direction

- **Personality:** an official record that is calm, precise and a little wry. A parole board's file crossed with a churchyard register. It is **not** playful neon AI, and not a corporate dashboard.
- **References:**
  - Court and municipal records: monospaced ledgers, ruled lines, stamps.
  - Old-style serif headings from print almanacs.
  - Stripe's changelog for restraint.
- **Principles:**
  1. **Evidence first.** Every claim (score, verdict, SCI) shows its source (MR, pipeline, rule file).
  2. **State is color.** Three level colors carry meaning everywhere: Assisted amber, Supervised blue, Hands-off green. Red means only a rollback or block.
  3. **Quiet until it matters.** Promotions and demotions get bold weight; routine rows stay plain.

## 2. Color Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#f4f1ea` | `#12110f` | Page background |
| `--card` | `#fbf9f4` | `#1a1916` | Cards, chart and table surfaces |
| `--ink` | `#1c1a17` | `#ebe6db` | Primary text |
| `--muted` | `#6d675d` | `#9c958a` | Secondary text, rules |
| `--line` | `#d9d3c6` | `#2d2a25` | Borders, dividers |
| `--assisted` | `#b45309` | `#f59e0b` | Assisted level |
| `--supervised` | `#1d4ed8` | `#60a5fa` | Supervised level |
| `--hands` | `#15803d` | `#4ade80` | Hands-off level, positive points |
| `--bad` | `#b91c1c` | `#f87171` | Rollback, negative points, exhumed |

Dark mode applies through `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and through `:root[data-theme="dark"]`. Body text contrast is ≥ 7:1 in both themes, and level colors are ≥ 4.5:1 on `--card`.

## 3. Typography

| Role | Font | Size / line height | Weight |
|---|---|---|---|
| Display (h1) | Fraunces (Google Fonts), Georgia fallback | 40 / 44px | 600 |
| Section (h2) | Fraunces | 22 / 26px | 600 |
| Body and data | IBM Plex Mono, `ui-monospace` fallback | 14 / 22px | 400 |
| Stat figure | IBM Plex Mono | 26px | 600 |
| Caption | IBM Plex Mono | 12px | 400 |

Numbers use `font-variant-numeric: tabular-nums`.

## 4. Spacing, Layout & Grid

- **Scale:** 4, 8, 10, 12, 14, 16, 24, 28, 40, 48, 64 px.
- **Container:** max 1040px, centred, 16px side gutter.
- **Grids:**
  - stats `repeat(auto-fit, minmax(180px, 1fr))`;
  - zones `minmax(130px, 1fr)`;
  - graves `minmax(200px, 1fr)`.
- **Mobile:** the ledger table scrolls horizontally inside `.table-wrap`; the page itself never does.

## 5. Shape, Elevation & Effects

- **Radius:** 6px for cards. Tombstones use `90px 90px 6px 6px`.
- **No shadows.** Elevation comes from a 1px `--line` border on `--card`.
- **Zone cards** carry a 4px top border in the level color. Forbidden zones use a dashed muted border at 60% opacity.

## 6. Motion

- **Duration tokens:** instant 80ms, base 400ms (card rise).
- **Easing:** emphasized `cubic-bezier(.2,.8,.2,1)`.
- **Pattern:** stats, zone cards and tombstones rise 6px and fade in on load, using CSS keyframes and transform/opacity only.
- **Reduced motion:** the animation is wrapped in `@media (prefers-reduced-motion: no-preference)`, so there is no motion otherwise.
- **The chart is static.** Change is shown by the step line itself, not by animation.

## 7. Iconography & Imagery

- Emoji are used as stamps in CI text only: 🪦 candidate, ⚰️ dig started, 🟢🟡🧑‍⚖️⛔ gate verdicts, ✅🚨 settle, 🎖️⬇️ promotion and demotion, 🌱 SCI.
- Each is always followed by words, so meaning never relies on the emoji alone.

## 8. Components

| Component | Anatomy | States |
|---|---|---|
| Stat tile | figure + caption | value · "—" when unknown |
| Zone card | name, level, points | assisted · supervised · hands_off · forbidden |
| Trust chart | SVG step line per touched zone, dashed threshold rules with labels, dots per event | positive dot (hollow) · negative dot (filled red) · empty (flat line at 0) |
| Tombstone | R.I.P. or EXHUMED, title, −lines · zone · SCI Δ, date | buried · exhumed (red border) |
| Ledger table | when, zone, event, pts, score, level (bold on change), MR link | populated · empty message |
| Gate note (MR) | verdict line, per-zone reasons, diff size, footer pointing to the rule source | block · needs_human · merge_supervised · merge_hands_off |
| SCI note (MR) | table per component with main / this MR / Δ, size and cold start line | no baseline (— columns) · with baseline |

## 9. Patterns & Screen Specs

**Probation Board** (`public/index.html`, F-07):
1. Header: h1, then a one-paragraph explanation naming the policy file.
2. Stats row: graves dug, lines removed, rollbacks, SCI change.
3. Autonomy by zone: neutral zones are hidden.
4. Trust over time, with a link to the ledger replay.
5. Graveyard, newest first.
6. Nine stages, one lifecycle: what Probation runs in each DevSecOps stage.
7. Ledger, the last 30 events, newest first.
8. Footer with the generation time.
- **Empty state:** "No graves yet…" and "No scored events yet." The chart is a flat axis.
- **Error state:** the board is static, so a failed `pages` job keeps the last published version.

**Ledger replay** (`public/replay.html`, F-07): the same ledger re-told one event at a time, linked from the board. Controls: play/pause, step, speed; keyboard space, ← and →, Home; `?autoplay=1&speed=1.5&theme=dark` query options. Steps are computed in `probation/src/replay.ts`; the inline script only animates, with motion behind `prefers-reduced-motion: no-preference`.

**Tallybook dashboard** (`/`, F-08): title, outstanding totals per currency, and an invoice table with status pills. The optional holiday banner sits at the top behind `holidayBanner2024`. With no invoices, the outstanding line reads "Outstanding: nothing".

## 10. Content & Voice

Short, factual and dry, with gallows humour kept to labels (Undertaker, graves, exhumed, coroner). Every bot message:
1. states the verdict first;
2. explains it in one line per reason;
3. points to the file that encodes the rule.

Never "I think". Use "Decided by `probation/src/gate.ts` from `policy.yml`".

## 11. Accessibility

- WCAG 2.2 AA:
  - text contrast ≥ 4.5:1;
  - the SVG has `role="img"` and an `aria-label`, and each dot has a `<title>`;
  - the table has a `<thead>`;
  - links are underlined by default (inherit color).
- Meaning never uses color alone: levels are also written as words, and negative points carry a "−" sign.
- CLI output: no color codes; status uses words and symbols (`✖`, `ok`).

## 12. Responsive & Platform

- Tested at 390px and 1100px widths.
- The grids collapse with `auto-fit`, and the table scrolls inside its wrapper.

## 13. Implementation

- Tokens are defined in the `<style>` of `probation/src/board.ts`, and a subset in `app/src/routes/ui.ts`.
- Fonts load from Google Fonts with `display=swap`. The system monospace fallback keeps the layout stable.
