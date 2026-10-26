# Demo video script (target 2:50, hard limit 3:00)

Record at 1080p. Use a narrated voice-over (AI narration is allowed), no music or only royalty-free, and no third-party logos besides GitLab and Google Cloud UI. Speed up waits (pipelines, the soak) with on-screen "⏩ 3 min soak" captions.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:12 | **Card 01-hook** (0:00–0:04) → Probation Board, the trust chart climbing then dropping | "Code generation is solved. But nobody lets an AI *delete* code, and nobody lets an AI ship to production alone. So we put one on probation." |
| 0:12–0:30 | Tallybook repo: `legacy/`, flags, `package.json` with moment/lodash | "This is Tallybook, an invoicing app with years of debt: dead API versions, stale flags, unused packages. Every line costs build time, image size, cold starts, and carbon." |
| 0:30–0:50 | Pipeline schedule → `census:collect` log → issue list of 🪦 candidates with evidence | "Every night a census reads Cloud Run's request logs and files a grave for each piece of code that production proves is dead. Evidence, not guesses." |
| 0:50–1:15 | Undertaker flow session → MR with epitaph → Coroner's report → gate note **🧑‍⚖️ Assisted** → **Card 02-ladder** (1:09–1:15) | "Undertaker is a GitLab Duo flow that can only delete. It digs the grave, opens a minimal MR, then a coroner step attacks its own work. It can't merge. A deterministic gate decides, and a new agent starts on Assisted: a human approves." |
| 1:15–1:35 | Merge → child pipeline: staging → canary → soak → promote → MR note "+10 → Supervised" → 🎖️ promotion issue | "Every change ships through a canary and a soak. Survive production, earn trust, per code zone." |
| 1:35–1:50 | ⏩ montage: act 2 auto-merge + one prod click, act 3 → 🎖️ **Hands-off** | "Supervised: it merges itself; I approve production. Two graves later, it's Hands-off in the legacy zone." |
| 1:50–2:25 | Act 4: issue → MR → 🟢 gate auto-merge → canary → soak log: `bookkeeping-partner-monthly-export → 404` → **Card 03-rollback** (2:06–2:11) → rollback job → revert commit → ⬇️ demotion issue → candidate labelled do-not-bury | "Now nobody's watching. It buries the CSV export: zero hits in seven days. But our bookkeeping partner calls it once a month. The canary soak catches the 404, traffic rolls back, the commit is reverted, and Undertaker loses 40 points. Back to Assisted. That grave is never touched again." |
| 2:25–2:40 | MR 🌱 SCI note (size and SCI Δ) → board stats with the SCI sparkline → **Card 04-stages** (2:33–2:40) | "Every MR is measured in gCO₂e per thousand requests with the SCI spec. Plan, create, verify, package, secure, release, configure, monitor, govern: all nine stages, on GitLab and Cloud Run." |
| 2:40–2:52 | Board with the climb-and-fall chart → **Card 05-end** (2:46–2:52, hold to the end) | "Autonomy you can earn, and lose. Probation." |

**Title cards** (1920×1080, light paper look, no third-party logos): `docs/media/cards/*.html`, rendered to `docs/media/cards/png/*.png` by `node scripts/render-media.ts` (uses the globally installed Playwright + Chromium; it also writes `docs/media/board-light.png` and `docs/media/board-dark-mobile.png` from the mock ledger). Cut each card in with a 200 ms cross-fade, no motion on the card itself.

| Card | Line on screen | Where |
|---|---|---|
| `01-hook` | "Code generation is solved. Deletion isn't." | 0:00 |
| `02-ladder` | Assisted ≥ 0 → Supervised ≥ 10 → Hands-off ≥ 30; rollback −40 (from `policy.yml`) | 1:09 |
| `03-rollback` | "Hands-off. No human. The canary caught it." with `bookkeeping-partner-monthly-export` → 404 | 2:06 |
| `04-stages` | The nine stages and what runs in each | 2:33 |
| `05-end` | "Autonomy you can earn — and lose." · Probation · GitLab Duo Agent Platform · Google Cloud Run | 2:46 |

**Before recording:**
- Run `node scripts/render-media.ts` if a card or the board changed, so the PNGs match.
- Run `npm run demo:mock` to rehearse the narration against `.out/board.html`.
- Pre-open the tabs: the issue list, MR !n (one per act), the child pipeline logs, the board, and the Cloud Run revisions page.
