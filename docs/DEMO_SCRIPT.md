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

## If live footage is short: the replay cut

`docs/media/replay.webm` (and `replay.mp4` for editors) is a ~31 s, 1920×1080 recording of the ledger replay page (`replay.html`, published next to the board) playing the mock story at 1×. It shows the same five acts as the live demo, drawn from the ledger, so it can stand in for any act whose live footage is missing or too slow. Clip times:

| Clip | Shows | Replaces |
|---|---|---|
| 0:00–0:03 | "undertaker starts on probation · legacy at 0 · Assisted" | Card 02-ladder, or the end of 0:50–1:15 |
| 0:03–0:08 | !1 survived the soak · +10 → Supervised (badge turns blue, first tombstone) | 1:15–1:35 (MR note and promotion issue) |
| 0:08–0:17 | !2 and !3 survive · 30 pts → Hands-off (green) | 1:35–1:50 montage |
| 0:17–0:23 | !4 rolled back: red flash, "−40 · rolled back" stamp, the line drops, tombstone EXHUMED | 2:11–2:25, after Card 03-rollback: rollback job, revert and demotion issue (keep the live soak-log 404 if you have it) |
| 0:23–0:31 | !5 survives back to Supervised, then "4 graves buried · 1 exhumed" and "Autonomy you can earn, and lose." | 2:40–2:46, before Card 05-end |

Cut the replay in hard (no transition) and narrate over it as written; its captions match the voice-over. Key frames for the README or slides: `docs/media/replay-frames/01.png` (start), `02.png` (Hands-off reached), `03.png` (rollback flash), `04.png` (closing record).

Regenerate after any change to the replay page or the mock story: `node scripts/record-replay.ts` (about 3 minutes; `--frames-only` for just the PNGs). It uses the globally installed Playwright + Chromium and the system `ffmpeg`. To show it live instead, open `replay.html?autoplay=1&speed=1.5` from the published board (space pauses, ← and → step).

**Before recording:**
- Run `npm run doctor` against the GitLab project; it must exit 0 before you spend credits on a live act.
- Drive the live acts with `npm run demo -- status|dig|approve|promote|watch` (RUNBOOK §5) instead of clicking through GitLab.
- Run `node scripts/render-media.ts` if a card or the board changed, so the PNGs match.
- Run `npm run demo:mock` to rehearse the narration against `.out/board.html`.
- Pre-open the tabs: the issue list, MR !n (one per act), the child pipeline logs, the board, the board's `replay.html`, and the Cloud Run revisions page.

## Fallback rough cut (if live runs fail)

`docs/media/demo-rough-cut.mp4` is a complete 2:50, 1920×1080 H.264 cut of this script (about 10 MB, silent), and `docs/media/demo-rough-cut.srt` holds its captions. It is a **fallback**: submit your live GitLab and Cloud Run recording when you have one. Use the rough cut only when live footage is missing or broken, either whole or as filler for the acts you could not record.

It is built only from real artifacts:
- the title cards;
- the replay clip;
- the board and the diagrams;
- terminal scenes that show the real stdout of `npm run demo:mock`, of the Probation CLIs (census, start-flow, gate, release-plan, soak, settle) and of `npm run demo -- status`, all run against the GitLab API simulator in `probation/sim` and seeded the way the e2e story test seeds it;
- the gate notes that `gate.ts` posted to that simulator, shown as MR comments.

A label in the top corner of every frame reads "Offline rehearsal · GitLab API simulator + mock ledger · live runs: see repo", so judges are never misled. There is no voice: no local TTS is available, so the voice-over lines are burned in as captions. To add narration, record or generate it against the `.srt` timings.

Regenerate with `node scripts/render-video.ts`. It takes about 4 minutes and uses the global Playwright + Chromium and the system `ffmpeg`, like the other media scripts. Intermediate files go to `.out/video/`. With `--reuse-clips` it keeps the scene clips and only re-assembles the cut, which is useful after a caption change.

| Time | Scene | Splice live footage here |
|---|---|---|
| 0:00–0:04 | Card 01-hook | — |
| 0:04–0:12 | Board: trust chart | Live board |
| 0:12–0:28 | Repo: `ls`, `wc -l`, grep for moment and lodash | Tallybook repo in GitLab |
| 0:28–0:48 | census stdout + `npm run demo -- status` | `census:collect` log + 🪦 issue list |
| 0:48–0:54 | Architecture diagram, push-in | Undertaker flow session |
| 0:54–1:02 | start-flow + gate stdout | Flow session → MR |
| 1:02–1:09 | Gate note 🧑‍⚖️ Assisted (MR !1) | Live MR note |
| 1:09–1:15 | Card 02-ladder | — |
| 1:15–1:28 | release-plan + settle survived + status | Child pipeline: staging → canary → soak → promote |
| 1:28–1:33 | Replay 0:03–0:08 | MR note "+10 → Supervised", 🎖️ issue |
| 1:33–1:40 | `demo:mock` acts 2–3 | Act 2–3 ⏩ montage |
| 1:40–1:48 | Replay 0:08.5–0:16.5 (Hands-off) | 🎖️ Hands-off issue |
| 1:48–1:54 | Gate note 🟢 Hands-off (MR !4) | Live MR !4 note |
| 1:54–2:04 | gate + `soak --signal` FAIL (404) | Live soak log with the 404 |
| 2:04–2:09 | Card 03-rollback | — |
| 2:09–2:17 | settle rolled_back + revert + status | Rollback job, revert commit |
| 2:17–2:23 | Replay 0:17–0:23 (rollback) | ⬇️ demotion issue, do-not-bury label |
| 2:23–2:29 | Board stats + SCI sparkline | MR 🌱 SCI note |
| 2:29–2:35 | Stages diagram | — |
| 2:35–2:39 | Card 04-stages | — |
| 2:39–2:44 | Replay 0:24.4–0:30.4 (closing record) | Live board |
| 2:44–2:50 | Card 05-end | — |

To splice a live clip over a range, overlay it full-frame. The live frames then replace the label and the burned captions for that range, so upload the `.srt` to YouTube as subtitles to keep the captions everywhere. For example, to drop a 10 s live soak log over 1:54–2:04:

```bash
ffmpeg -i docs/media/demo-rough-cut.mp4 -i live-soak.mp4 -filter_complex \
  "[1:v]scale=1920:1080,setpts=PTS-STARTPTS+114.4/TB[l];[0:v][l]overlay=enable='between(t,114.4,124.4)':eof_action=pass[v]" \
  -map "[v]" -c:v libx264 -crf 20 -pix_fmt yuv420p spliced.mp4
```

Scene boundaries are exact to 0.1 s: the script prints them when it finishes. Keep any live footage you have; the rough cut only fills the gaps.

### Narrated rough cut

`docs/media/demo-rough-cut-narrated.mp4` is the same video with an AI voice-over (Piper TTS, voice `en_US-ryan-high`). Each caption cue in `docs/media/demo-rough-cut.srt` is spoken from its start time. A line longer than its cue is sped up by at most 1.25× and never runs into the next cue. Cues 24–25 (the nine stages) are one sentence, so they are spoken as one clip across both windows. The track is normalised to -16 LUFS and muxed with the video stream copied. Re-render it after any change to the rough cut. The Piper setup and the `TTS_CMD` variable are described at the top of `scripts/narrate-video.ts`:

```bash
TTS_CMD='piper -m en_US-ryan-high.onnx -f "$OUT" 2>/dev/null' node scripts/narrate-video.ts
```

The script prints a fit table per cue and fails if any line would overlap the next cue. Upload this file as the submission video when no live narrated recording exists.
