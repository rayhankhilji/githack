# Devpost gallery images

Rendered by `node scripts/render-gallery.ts` from the media in `docs/media` (diagrams, title cards, board, replay frames, playground). All gallery images are 1800×1200 PNG (3:2, well under 5 MB). The YouTube thumbnail is 1280×720.

Upload in this order. Paste the alt text into Devpost's caption field.

| # | File | Alt text |
| - | ---- | -------- |
| 1 | `01-cover.png` | Title: "An AI that deletes dead code — and has to earn the right to ship it." Below, the autonomy ladder: Assisted (0 points, a human approves every merge and deploy), Supervised (10 points, the gate merges, a human approves production), Hands-off (30 points, merges and ships alone through canary and soak). A small ledger-replay frame shows a rolled-back deletion dropping its zone back to Assisted. |
| 2 | `02-architecture.png` | Architecture diagram: nightly census of Cloud Run logs files candidate issues; the Undertaker agent flow opens one deletion MR; verify, secure and SCI jobs feed a deterministic gate that reads a human-owned policy file and ledger; the release child pipeline deploys staging, canary and production, and a failed soak triggers rollback and a −40 penalty. |
| 3 | `03-gate.png` | The gate playground: the same decide() function that runs in CI, bundled for the browser. A legacy-zone deletion at 30 points is decided "Merge, hands-off". Legend of verdicts: needs_human, merge_supervised, merge_hands_off, block. |
| 4 | `04-rollback.png` | "The canary caught it." Ledger replay at step 4: the deletion of GET /api/v1/export.csv was rolled back when the monthly partner export failed on the canary; the legacy zone drops 40 points, from Hands-off back to Assisted. |
| 5 | `05-stages.png` | Nine stages, one deletion: Plan, Create, Verify, Package, Secure, Release, Configure, Monitor, Govern, each listing the GitLab CI jobs or Duo flow behind it. |
| 6 | `06-board.png` | The trust board published to GitLab Pages: graves dug, lines removed, rollbacks, SCI change and autonomy per zone, shown light on desktop and dark on a phone. |
| 7 | `07-sustainability.png` | The Software Carbon Intensity formula, SCI = ((E × I) + M) per R, with E measured per MR, I = 432 gCO₂e/kWh (Cloud Run us-central1, Google 2025 data) and M = 0.713 g per vCPU-hour. A bar shows moment + lodash at 10.2 of the 25.9 MB app layer. |

YouTube thumbnail: `youtube-thumbnail.png` (1280×720) — "AI on probation. It deletes dead code. It earns the right to ship." over the three ladder colours.

Sources for the numbers on image 7 are in [SCI.md](../../SCI.md).
