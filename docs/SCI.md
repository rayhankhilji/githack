# How Probation measures Software Carbon Intensity

Probation reports every change's carbon effect using the Green Software Foundation's **Software Carbon Intensity** specification (ISO/IEC 21031:2024):

```text
SCI = ((E × I) + M) per R
```

- **R (functional unit):** 1,000 HTTP requests served by Tallybook.
- **E (energy, kWh):** comes from a real measurement on every MR and main pipeline (`measure:sci`, `probation/src/cli/sci.ts`).
  1. Boot the app as a child process and time spawn → healthy (**cold start**).
  2. Drive a fixed request mix (`/api/invoices`, `/`, `/api/invoices/:id`) with autocannon: 10 connections for 10 s.
  3. Read the app process's CPU time (`utime + stime` from `/proc/<pid>/stat`) and sample RSS every 250 ms.
  4. Measure the **deployable size**: the `app/` directory as it ships, `src` plus production `node_modules`.
- **Energy is built from four parts** (coefficients in `probation/sci-coefficients.yml`):
  - **compute:** CPU-hours × 4.26 W per vCPU. This is CCF's GCP max per vCPU, used conservatively for busy CPU time.
  - **memory:** GB-hours × 0.000392 kWh/GB-h (CCF).
  - **image transfer:** deployable GB × 0.001 kWh/GB (CCF networking) × cold starts per 1k requests (1, because Cloud Run scales to zero at this traffic).
  - **cold start:** cold-start seconds × 4.26 W.
  - All of it is multiplied by **PUE 1.1** (CCF's GCP average PUE).
  - The 4.26 W and 0.71 W per vCPU (CCF's GCP medians), 0.000392 kWh/GB-h, 0.001 kWh/GB and PUE 1.1 were all checked against the [CCF methodology](https://www.cloudcarbonfootprint.org/docs/methodology/) on 2026-10-26.
- **I (grid intensity):** 432 gCO₂e/kWh. This is the location-based grid intensity for the Cloud Run region `us-central1` (Iowa) in Google's 2025 data (431.95 unrounded, 88% CFE). Sources: [Carbon free energy for Google Cloud regions](https://cloud.google.com/sustainability/region-carbon) and the [region-carbon-info dataset](https://github.com/GoogleCloudPlatform/region-carbon-info/blob/main/data/yearly/2025.csv), both checked 2026-10-26.
- **M (embodied):** 0.713 g per vCPU-hour of reserved time (CPU time plus cold start). That is 1,200 kgCO₂e of server embodied emissions amortised over 4 years and 48 vCPUs, using [CCF's embodied-emissions method](https://www.cloudcarbonfootprint.org/docs/embodied-emissions) (M = TE × TR/EL × RR/TR, EL = 4 years). The 1,200 kg host total and the 48-vCPU host size are our assumptions: CCF publishes per-machine-type totals rather than one figure.

## Why deletions reduce SCI

Unused dependencies and dead modules don't burn CPU per request, but they:
- inflate the image every cold start pulls (E_network);
- lengthen module loading at boot (E_coldstart and M);
- add build and scan minutes in CI. CI is excluded from R and noted as an additional, unquantified saving.

Probation reports these honestly. The per-request compute share barely moves; the size and cold-start shares do.

## Where to see it

- **On every MR:** a 🌱 note with main vs this MR per component, plus size and cold-start deltas.
- **After each surviving release:** the baseline is updated and the history is appended (`ledger.json → sci.history`).
- **On the Probation Board:** "SCI change since first measurement".

## Reproduce locally

```bash
npm run setup
SCI_DURATION=10 npm run sci -- --no-comment   # writes .out/sci.json and .out/sci.md
```

## Limits

- **CPU-time watts are an estimate,** not a power meter. A CI runner is not the Cloud Run host.
- **Deployable size counts the app layer only** (`src` + production `node_modules`), not the shared `node:22.23-slim` base layers every revision reuses. In this repo, `moment` and `lodash` alone are 10.4 MB of the 16 MB app layer.
- **Cold starts per 1k requests are an assumption.** It is tied to scale-to-zero and set in `sci-coefficients.yml`.
- **Results are comparative.** The same mix runs on the same runner type for main and the MR, which is what the decision needs.
