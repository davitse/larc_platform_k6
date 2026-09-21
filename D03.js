/**
 * LarcK6Test / D03.js
 *
 * Standalone dashboard-viewer concurrency test, split out from
 * labmonitor-scalability-test.js (which also covers node ingestion).
 *
 * Purpose
 * -------
 * Simulates several staff/operators concurrently viewing the real backoffice
 * dashboard at http://larcmonitor.up.ac.th/backoffice/labmonitor, from
 * different simulated browsers/devices, sustained over a ramp-up / steady /
 * ramp-down load profile. This is the scenario that produced clean results
 * in the last full run (542/542 requests succeeded, p95 ~80ms).
 *
 * This file does NOT touch node/sensor data ingestion - see
 * labmonitor-scalability-test.js for that (still pending a confirmed
 * ingestion endpoint).
 *
 * ============================================================================
 * ACTION NEEDED BEFORE RUNNING (if login is actually required):
 *   LOGIN_PATH, USERNAME_FIELD, PASSWORD_FIELD - confirm against the real
 *   backoffice login form (browser DevTools > Network tab). The last run had
 *   no credentials set, so login was never actually exercised - if the
 *   dashboard requires auth, set LARC_USERNAME / LARC_PASSWORD before running.
 * ============================================================================
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.4/index.js';

// ---------------------------------------------------------------------------
// Configuration (override with `-e NAME=value` on the CLI)
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || 'http://larcmonitor.up.ac.th';
const DASHBOARD_PATH = __ENV.DASHBOARD_PATH || '/backoffice/labmonitor';

// --- Login (CONFIGURE ME if the dashboard actually requires it) ------------
const LOGIN_PATH = __ENV.LOGIN_PATH || '/backoffice/login';
const USERNAME_FIELD = __ENV.USERNAME_FIELD || 'username';
const PASSWORD_FIELD = __ENV.PASSWORD_FIELD || 'password';
const LARC_USERNAME = __ENV.LARC_USERNAME || '';
const LARC_PASSWORD = __ENV.LARC_PASSWORD || '';

// --- Scale / timing ----------------------------------------------------------
const DASHBOARD_VUS = Number(__ENV.DASHBOARD_VUS || 15); // simulated concurrent viewers
const RAMP_UP = __ENV.RAMP_UP || '2m';
const STEADY = __ENV.STEADY || '3m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '1m';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/128.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const dashboardLoadDuration = new Trend('dashboard_load_duration', true);
const loginFailureRate = new Rate('login_failure_rate');

// ---------------------------------------------------------------------------
// k6 options - single scenario: concurrent dashboard viewers
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    dashboard_load: {
      executor: 'ramping-vus',
      exec: 'dashboardScenario',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: DASHBOARD_VUS },
        { duration: STEADY, target: DASHBOARD_VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '30s',
      tags: { scenario: 'dashboard_load' },
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<2000'],
    dashboard_load_duration: ['p(95)<2500'],
    login_failure_rate: ['rate<0.05'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ---------------------------------------------------------------------------
// Login helper - each VU logs in once (own cookie jar) and reuses the
// session for every iteration that follows. No-ops if no credentials are set.
// ---------------------------------------------------------------------------
const loggedInVUs = {};

function ensureLoggedIn() {
  if (loggedInVUs[__VU]) return true;
  if (!LARC_USERNAME || !LARC_PASSWORD) {
    loggedInVUs[__VU] = true;
    return true;
  }

  const loginPageRes = http.get(`${BASE_URL}${LOGIN_PATH}`, {
    tags: { name: 'GET login page' },
  });

  // Best-effort CSRF token extraction (common Laravel/PHP pattern). Remove if
  // not applicable to this backend.
  let extraFields = {};
  const tokenMatch = loginPageRes.body &&
    loginPageRes.body.match(/name=["'](?:_token|csrf_token)["']\s+value=["']([^"']+)["']/i);
  if (tokenMatch) {
    extraFields._token = tokenMatch[1];
  }

  const payload = Object.assign(
    {
      [USERNAME_FIELD]: LARC_USERNAME,
      [PASSWORD_FIELD]: LARC_PASSWORD,
    },
    extraFields
  );

  const loginRes = http.post(`${BASE_URL}${LOGIN_PATH}`, payload, {
    tags: { name: 'POST login' },
  });

  const ok = check(loginRes, {
    'login succeeded (2xx/3xx)': (r) => r.status >= 200 && r.status < 400,
  });
  loginFailureRate.add(!ok);
  loggedInVUs[__VU] = ok;
  return ok;
}

// ---------------------------------------------------------------------------
// Scenario: concurrent dashboard viewers
// ---------------------------------------------------------------------------
export function dashboardScenario() {
  group('dashboard_load', () => {
    ensureLoggedIn();

    const res = http.get(`${BASE_URL}${DASHBOARD_PATH}`, {
      headers: { 'User-Agent': pick(USER_AGENTS) },
      tags: { name: 'GET labmonitor dashboard' },
    });

    dashboardLoadDuration.add(res.timings.duration);
    check(res, {
      'dashboard loaded (200)': (r) => r.status === 200,
      'dashboard body not empty': (r) => r.body && r.body.length > 0,
    });

    // A human watching a live dashboard refreshes/glances periodically.
    sleep(Math.random() * 5 + 5); // 5-10s between views
  });
}

// ---------------------------------------------------------------------------
// Summary output - written to D03-summary.json (and a text summary to console)
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  return {
    'D03-summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
