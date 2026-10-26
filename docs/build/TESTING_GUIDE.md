# Probation + Undertaker — Testing Guide

> Version: 1.0 · Updated: 2026-10-26

## 1. Strategy

| Layer | What | Tool | Where |
|---|---|---|---|
| Unit (pure) | gate, ledger, zones, census, SCI, security diff, board, MR helpers, release plan, soak loop | Vitest | `probation/test/*.test.ts` |
| Integration (in-process HTTP) | Tallybook routes, auth, validation, census lines, route inventory | Vitest + `fastify.inject` | `app/test/server.test.ts` |
| CLI smoke | replay, census (dry run), SCI, release-plan, board, mock story | Node | §8 below |
| Pipeline E2E | The real flow, MR gate, release and rollback on GitLab + GCP | GitLab CI | RUNBOOK §4–5 |

The pure core is fully deterministic and unit-tested. Anything that needs GitLab or GCP is exercised through the CLI smoke steps with fixtures, and then once for real on GitLab.

## 2. Setup

```bash
npm run setup        # npm ci at the root and in app/
npm run check        # lint + typecheck + tests
```

You need Node ≥ 22.18. SCI measurement needs Linux (`/proc`).

## 3. Commands

```bash
npm test                                   # all suites
npx vitest run probation/test/gate.test.ts # one suite
npm run demo:mock                          # offline end-to-end story
npm run replay                             # traffic replay against the fixture
npm run census -- --log .out/census-log.json --dry-run
SCI_DURATION=3 npm run sci -- --no-comment
node probation/src/cli/release-plan.ts && cat .out/release.yml
```

## 4. Mock Data & Fixtures

- **Policy:** `probation/test/helpers.ts` loads the real `policy.yml`. `ledgerWith()` builds score maps; `del()` and `edit()` build file diffs.
- **Traffic:** `probation/fixtures/traffic.json` holds production-like route hits with no legacy traffic.
- **Census log:** the snippet in §8 generates `.out/census-log.json` (479 synthetic lines).
- **GitLab:** CLIs are not mocked. The pure functions they call are tested, and the CLIs run with `LEDGER_FILE` and `--dry-run` / `--no-comment` / `--offline` to avoid the API.
- **Time:** ledger events accept an `at` override. The mock story uses a fixed clock starting at 2026-10-27T00:00Z.
- **Soak:** `soak()` takes an injected `fetcher`, and its interval and minutes are set to 0 in tests.

## 5. Test Suites

| Suite | File | Covers |
|---|---|---|
| Gate | `probation/test/gate.test.ts` | F-03 |
| Ledger | `probation/test/ledger.test.ts` | F-04 |
| Census | `probation/test/census.test.ts` | F-01 |
| SCI | `probation/test/sci.test.ts` | F-06 |
| Security | `probation/test/security.test.ts` | F-02, F-03 |
| Release / soak | `probation/test/release.test.ts`, `soak.test.ts` | F-05 |
| Board | `probation/test/board.test.ts` | F-07 |
| MR helpers | `probation/test/mr.test.ts` | F-02 |
| Tallybook | `app/test/server.test.ts` | F-08 |
| CLI end-to-end story | `probation/test/e2e/story.test.ts` (real CLIs against `probation/sim/gitlab-fake.ts`) | F-01–F-05, F-09, F-10 |
| Setup + doctor | `probation/test/e2e/setup.test.ts` | P0.T9 |
| Canary signal, stale reset | `probation/test/soak.test.ts`, `sweep.test.ts` | F-05, F-10 |
| Replay | `probation/test/replay.test.ts` | F-07 |
| MCP server | `probation/test/mcp.test.ts` | Clerk / MCP |

## 6. Acceptance Test Matrix

| AC | Test ID | Type | Location |
|---|---|---|---|
| F-01.AC1 | T-F01-AC1 | unit | census.test.ts |
| F-01.AC2 | T-F01-AC2 | unit | census.test.ts |
| F-01.AC3 | T-F01-AC3 | unit | census.test.ts |
| F-01.AC4 | T-F01-AC4 | unit | census.test.ts |
| F-02.AC1 | T-F02-AC1 | pipeline E2E | RUNBOOK §5 run 1 |
| F-02.AC2 | T-F02-AC2 | pipeline E2E | RUNBOOK §5 (any weak candidate) |
| F-02.AC3 | T-F02-AC3 | unit | security.test.ts, gate.test.ts (T-F03-AC8) |
| F-02.AC4 | T-F02-AC4 | unit | mr.test.ts |
| F-03.AC1–AC9 | T-F03-AC1 … T-F03-AC9 | unit | gate.test.ts |
| F-04.AC1–AC4 | T-F04-AC1 … T-F04-AC4 | unit | ledger.test.ts |
| F-05.AC1–AC3 | T-F05-AC1 … T-F05-AC3 | unit | release.test.ts |
| F-05.AC4 | T-F05-AC4 | unit + pipeline E2E | soak.test.ts; RUNBOOK §5 run 4 |
| F-06.AC1–AC2 | T-F06-AC1, T-F06-AC2 | unit | sci.test.ts |
| F-07.AC1 | T-F07-AC1 | unit | board.test.ts |
| F-08 | T-F08-* | integration | app/test/server.test.ts (9 tests) |
| F-09.AC1 | T-F09-AC1 | unit | dig.test.ts |
| F-09.AC2 | T-F09-AC2 | pipeline E2E | RUNBOOK §5 |
| F-10.AC1 | T-F10-AC1 | unit | sweep.test.ts |

## 7. Expected Results

- `npm run check`: Biome 0 errors, tsc 0 errors, Vitest **114 passed**.
- `npm run demo:mock`: five acts ending with the lines below, and `.out/board.html` written.
  - `legacy -40 → 0 · Hands-off → Assisted` (act 4);
  - `Assisted → Supervised` (act 5).
- `npm run replay`: `replay: ok`.
- `census --dry-run` on the §8 log: 13 candidates, including `POST /api/fax-invoice`, `GET /api/v1/export.csv`, `moment` and `formatMoneyLegacy`, and **not** `readFlag` or `GET /healthz`.
- SCI: a total of about 0.01 gCO₂e per 1k requests locally, dominated by image transfer. `moment` and `lodash` removal should cut the deployable size by about 20%.

## 8. Verification Loop for Agents

After every change:
1. `npm run check`.
2. If you touched `probation/src/cli/*`, run that CLI locally with fixtures:
   ```bash
   node -e "const l=[];const a=(n,m,r,f={})=>{for(let i=0;i<n;i++)l.push(JSON.stringify({census:1,method:m,route:r,status:200,flags:f}))};a(220,'GET','/',{holidayBanner2024:false});a(180,'GET','/api/invoices',{newTotals:true});a(40,'GET','/api/invoices/:id');a(9,'GET','/api/invoices/:id/pdf',{legacyPdf:false});a(30,'GET','/healthz');require('fs').mkdirSync('.out',{recursive:true});require('fs').writeFileSync('.out/census-log.json',l.join('\n'))"
   npm run census -- --log .out/census-log.json --dry-run
   ```
3. If you touched the gate, ledger or board, run `npm run demo:mock` and open `.out/board.html`.
4. If you touched `.gitlab-ci.yml`, validate it in GitLab (Build → Pipeline editor → Validate) before pushing to main.

## 9. CI Pipeline

| Pipeline | Jobs | Required to merge |
|---|---|---|
| MR | `verify:check`, `verify:replay`, SAST, Secret Detection and Dependency Scanning templates, `secure:npm-audit`, `measure:sci`, `probation:gate` | all |
| main | the above (without the gate), `package:image`, `release:plan` → `release:run` (child), `govern:baseline`, `govern:release-notes`, `pages` | n/a |
| schedule | `census:collect`, `census:file`, `undertaker:dig`, `pages` | n/a |

## 10. Manual QA Checklist

- [ ] Board readable at 390px in dark mode, with no horizontal page scroll.
- [ ] Gate note on an Undertaker MR shows the verdict, zones, diff size and rule source.
- [ ] SCI note shows the main vs MR columns after the first baseline exists.
- [ ] Rollback run: traffic back on the previous revision, revert commit on main, demotion issue opened, candidate labelled do-not-bury.
