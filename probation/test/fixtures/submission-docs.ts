// A frozen copy of the ✏️ placeholders in README.md and docs/SUBMISSION.md as they were before the final-hour fill,
// so the submission tests keep passing after the real docs are filled. Verbatim lines; surrounding prose trimmed.
export const FIXTURE_DOCS: Record<string, string> = {
  'README.md': `# Probation

> ✏️ **Working title.** Pick the final project name yourself before submitting (the hackathon FAQ asks for a human-chosen name), then replace "Probation" here, in \`docs/SUBMISSION.md\` and in the video cards.

**An AI that deletes dead code, and has to earn the right to ship it.**

GitLab Transcend "Life After Code" hackathon entry · Path A (Start Fresh) · Category: Hands-off · Special prizes: Most Stages Covered, Most Environmentally Impactful.

- **Undertaker** is a GitLab Duo Agent Platform flow that can only *delete*, and only code that production telemetry proves is dead.
- **Probation** is the deterministic CI system that decides how much autonomy Undertaker has, per code zone. Autonomy is earned through deploys that survive a production canary soak, and lost on rollback.

## ▶ Watch it

| | |
|---|---|
| 🎬 Demo video (under 3 min) | ✏️ YouTube link |
| 🪦 Probation Board (live ledger) | ✏️ GitLab Pages URL |
| 🧾 Tallybook on Cloud Run | ✏️ \`https://tallybook-….run.app\` |
| 📄 Devpost page | ✏️ link |
| 📼 Ledger replay (30 s, offline story) | [\`docs/media/replay.webm\`](docs/media/replay.webm) · live as \`replay.html\` next to the board |

\`measure:sci\` posts a 🌱 before/after note on each MR, and the board tracks the change since the first measurement. Deleting dead code mostly shrinks the image and the cold start, not the per-request CPU, and the note says so. ✏️ Measured result from the dependency burial: SCI −X% (copy from that MR's 🌱 note). Method, coefficients and limits: [\`docs/SCI.md\`](docs/SCI.md).

## License

MIT. See [LICENSE](LICENSE).
`,
  'docs/SUBMISSION.md': `# Devpost submission draft

> Replace every line marked ✏️ before you submit. Pick the final name yourself (the FAQ asks for a human-chosen name, not an AI-chosen one). "Probation" is a working title. Numbers in this file are only ones the code or a cited source gives; every measured result is a ✏️ until you copy it from a real pipeline.

**Name:** Probation ✏️
**Tagline:** An AI that deletes dead code, and has to earn the right to ship it.
**Path:** A: Start Fresh · **Category:** Hands-off · **Special prizes:** Most Stages Covered, Most Environmentally Impactful
**Links:**
- ✏️ GitLab repo
- ✏️ Tallybook on Cloud Run
- ✏️ Probation Board (GitLab Pages)
- ✏️ YouTube video (under 3 minutes)
- ✏️ Ledger replay (\`replay.html\` on the Pages site; a 30-second recording is in \`docs/media/replay.webm\`)


## Environmental impact (Most Environmentally Impactful)

**Measured results:**
- ✏️ Dependency burial (moment + lodash): app layer ✏️ X MB → ✏️ Y MB, cold start ✏️ a ms → ✏️ b ms, SCI ✏️ −X% (copy from that MR's 🌱 note).
- ✏️ All burials since the first measurement: SCI ✏️ −X% (board stat "SCI change").
- ✏️ Optional scale-up: at ✏️ N requests a month, that is ✏️ g CO₂e a year (show the arithmetic).

## Image gallery

11. ✏️ Screenshots from the live project: the gate note at Hands-off, the \`soak:canary\` 404 log, Cloud Run revisions with traffic split, a 🌱 SCI note.
`,
  'docs/STAGES.md': `# Stages

| Stage | What | Evidence |
|---|---|---|
| **Create** | The flow. ✏️ Screenshot the trigger once it is configured in the project. | The session log. |
`,
  'docs/SCI.md': '# How Probation measures Software Carbon Intensity\n',
};
