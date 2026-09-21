# LarcK6Test / Performance

k6 load/scalability test for `http://larcmonitor.up.ac.th/backoffice/labmonitor`,
written to answer this reviewer comment on the LARC monitoring paper:

> The system was tested only in two rooms with two nodes EnviBox1 and
> EnviBox2. Are two devices not enough to confirm the scalability of the
> system? It is necessary to demonstrate the operation of the system in a
> real heterogeneous environment with dozens of nodes. The limited scale of
> deployment is a drawback.

## What this script does

`labmonitor-scalability-test.js` runs two scenarios **at the same time**
against the real system:

1. **`node_ingestion`** - ramps up to **50 concurrent simulated sensor
   nodes** (configurable), spread across 5 different device profiles
   (temperature/humidity, CO2, air quality, light, noise) and 12 different
   simulated rooms, each on a different firmware version - i.e. a
   heterogeneous fleet, not two identical boxes in two rooms.
2. **`dashboard_load`** - simultaneously simulates 15 concurrent
   staff/operators viewing the live `backoffice/labmonitor` dashboard from
   different browsers/devices (desktop Chrome/Firefox, mobile Safari/Chrome).

Each ramps 0 -> target over 2 minutes, holds for 3 minutes, then ramps back
down over 1 minute (all tunable). Results (latency percentiles, error rate,
throughput) give you concrete numbers to cite in the rebuttal/revision,
e.g. "the system was load-tested with 50 concurrent heterogeneous nodes
across 12 rooms and N simultaneous dashboard viewers, sustaining a p95
response time of X ms with an error rate of Y%."

## Before you run it - two things I could not verify myself

I wasn't able to reach `larcmonitor.up.ac.th` directly to inspect it, so
two parts of the script are configurable placeholders you'll need to fill
in:

1. **Login.** The backoffice needs a login. Open the login page in your
   browser, open DevTools > Network, log in, and find the actual request:
   - `LOGIN_PATH` (e.g. `/backoffice/login`)
   - the form field names for username/password (`USERNAME_FIELD`,
     `PASSWORD_FIELD`)
   - if the login form has a hidden CSRF token input, the script already
     tries to auto-detect one named `_token` or `csrf_token` - adjust the
     regex in `ensureLoggedIn()` if yours is named differently.
2. **Node ingestion endpoint.** `NODE_INGEST_PATH` and the JSON payload
   shape in `buildNodePayload()`/`nodeIngestionScenario()` are a best-guess
   placeholder. Check your backend source (the route that EnviBox1/EnviBox2
   actually POST readings to) or capture a real request in DevTools while a
   physical node reports, and update the path + payload fields to match.

If you'd rather not simulate ingestion until that endpoint is confirmed,
you can just run the `dashboard_load` scenario alone (see below) - that one
targets the real, given URL and needs no guessing.

## Install k6

- Windows: `winget install k6` or `choco install k6`, or download from
  https://k6.io/docs/get-started/installation/

## Running it

From this folder:

```bash
# Full test (both scenarios), 50 nodes + 15 dashboard viewers, using env vars for credentials
k6 run labmonitor-scalability-test.js `
  -e LARC_USERNAME="your_username" `
  -e LARC_PASSWORD="your_password" `
  -e LOGIN_PATH="/backoffice/login" `
  -e USERNAME_FIELD="username" `
  -e PASSWORD_FIELD="password" `
  -e NODE_INGEST_PATH="/backoffice/labmonitor/api/data"
```

Only the dashboard-viewing scenario, skipping the (unverified) ingestion endpoint:

```bash
k6 run labmonitor-scalability-test.js --include-system-env `
  -e LARC_USERNAME="your_username" -e LARC_PASSWORD="your_password" `
  --tag scenario=dashboard_load
```
(k6 doesn't natively filter by scenario at the CLI in older versions - if
`--tag` filtering isn't available in your k6 version, temporarily comment
out the `node_ingestion` entry in the `scenarios` object in the script.)

Useful overrides:

```bash
k6 run labmonitor-scalability-test.js -e NODE_VUS=100 -e DASHBOARD_VUS=25 -e STEADY=5m
```

## Output

- A live text summary prints to the console (latency percentiles, error
  rate, throughput, checks passed/failed, per scenario).
- A full `summary.json` is written to this folder after each run - useful
  for pulling exact numbers/tables into the paper's revision.

## Credentials

Credentials are read from environment variables (`LARC_USERNAME`,
`LARC_PASSWORD`), never hardcoded in the script - don't commit real
credentials into git.
