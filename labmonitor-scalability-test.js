/**
 * LarcK6Test / Performance
 * labmonitor-scalability-test.js
 *
 * Purpose
 * -------
 * Addresses a reviewer comment on the LARC monitoring paper:
 *   "The system was tested only in two rooms with two nodes (EnviBox1 and
 *   EnviBox2). ... It is necessary to demonstrate the operation of the
 *   system in a real heterogeneous environment with dozens of nodes."
 *
 * This script load-tests the real backoffice dashboard
 *   http://larcmonitor.up.ac.th/backoffice/labmonitor
 * with two concurrent scenarios:
 *
 *   1. node_ingestion   - simulates dozens of HETEROGENEOUS EnviBox-style
 *                         sensor nodes (different sensor types, firmware
 *                         versions, and rooms) submitting telemetry at
 *                         once, well beyond the original 2-node setup.
 *   2. dashboard_load   - simulates several staff/operators concurrently
 *                         viewing the backoffice/labmonitor dashboard from
 *                         different browsers, while ingestion is happening.
 *
 * ============================================================================
 * ACTION NEEDED BEFORE RUNNING (I could not reach the site to inspect it,
 * so these are configurable placeholders - fill them in from your backend
 * source or your browser's DevTools > Network tab):
 *
 *   1. LOGIN_PATH, USERNAME_FIELD, PASSWORD_FIELD  - the real login form
 *      endpoint/field names for the backoffice.
 *   2. NODE_INGEST_PATH and the payload shape in buildNodePayload() - the
 *      real endpoint your EnviBox nodes POST readings to. The current
 *      value is a best-guess placeholder.
 *
 * Everything else (VU counts, ramp durations, thresholds) can be tuned via
 * environment variables - see README.md.
 * ============================================================================
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.4/index.js';

// ---------------------------------------------------------------------------
// Configuration (override any of these with `-e NAME=value` on the CLI, or
// environment variables)
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || 'http://larcmonitor.up.ac.th';
const DASHBOARD_PATH = __ENV.DASHBOARD_PATH || '/backoffice/labmonitor';

// --- Login (CONFIGURE ME) ---------------------------------------------------
const LOGIN_PATH = __ENV.LOGIN_PATH || '/backoffice/login';
const USERNAME_FIELD = __ENV.USERNAME_FIELD || 'superadmin';
const PASSWORD_FIELD = __ENV.PASSWORD_FIELD || 'chaow!@#chaow';
const LARC_USERNAME = __ENV.LARC_USERNAME || '';
const LARC_PASSWORD = __ENV.LARC_PASSWORD || '';

// --- Node ingestion endpoint (CONFIGURE ME) ---------------------------------
const NODE_INGEST_PATH = __ENV.NODE_INGEST_PATH || '/backoffice/labmonitor/api/data';

// --- Scale: this is what answers the reviewer's "dozens of nodes" comment --
const NODE_VUS = Number(__ENV.NODE_VUS || 50); // simulated concurrent sensor nodes
const DASHBOARD_VUS = Number(__ENV.DASHBOARD_VUS || 15); // simulated concurrent viewers
const RAMP_UP = __ENV.RAMP_UP || '2m';
const STEADY = __ENV.STEADY || '3m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '1m';

// ---------------------------------------------------------------------------
// Heterogeneous simulated environment: several node/device types, several
// rooms, several firmware versions, several client browsers - not just
// "EnviBox1 in room A" and "EnviBox2 in room B".
// ---------------------------------------------------------------------------
const NODE_PROFILES = [
  { type: 'EnviBox-TempHumidity', firmware: 'v1.2.0', fields: () => ({
      temperature: +(24 + Math.random() * 6).toFixed(1),
      humidity: +(40 + Math.random() * 30).toFixed(1),
    }) },
  { type: 'EnviBox-CO2', firmware: 'v1.0.4', fields: () => ({
      co2_ppm: Math.round(400 + Math.random() * 800),
    }) },
  { type: 'EnviBox-AirQuality', firmware: 'v2.1.0', fields: () => ({
      pm25: +(5 + Math.random() * 40).toFixed(1),
      pm10: +(10 + Math.random() * 60).toFixed(1),
    }) },
  { type: 'EnviBox-Light', firmware: 'v1.5.1', fields: () => ({
      lux: Math.round(100 + Math.random() * 900),
    }) },
  { type: 'EnviBox-Noise', firmware: 'v1.1.0', fields: () => ({
      db_level: +(30 + Math.random() * 40).toFixed(1),
    }) },
];

const ROOMS = [
  'CE-Lab-101', 'CE-Lab-102', 'CE-Lab-103', 'IT-Lab-201', 'IT-Lab-202',
  'Faculty-Meeting-Room', 'Library-StudyRoom-1', 'Library-StudyRoom-2',
  'Server-Room', 'Lecture-Hall-A', 'Lecture-Hall-B', 'Workshop-1',
];

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
const nodeIngestDuration = new Trend('node_ingest_duration', true);
const nodeIngestSuccess = new Counter('node_ingest_success_total');
const nodeIngestFailure = new Counter('node_ingest_failure_total');
const dashboardLoadDuration = new Trend('dashboard_load_duration', true);
const loginFailureRate = new Rate('login_failure_rate');

// ---------------------------------------------------------------------------
// k6 scenarios / options
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    // Scenario 1: dozens of heterogeneous EnviBox-style nodes reporting at once
    node_ingestion: {
      executor: 'ramping-vus',
      exec: 'nodeIngestionScenario',
      startVUs: 0,
      stages: [
        { duration: RAMP_UP, target: NODE_VUS },
        { duration: STEADY, target: NODE_VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
      gracefulRampDown: '30s',
      tags: { scenario: 'node_ingestion' },
    },
    // Scenario 2: staff/operators concurrently watching the live dashboard
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
    'node_ingest_duration': ['p(95)<2000'],
    'dashboard_load_duration': ['p(95)<2500'],
    'login_failure_rate': ['rate<0.05'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

// ---------------------------------------------------------------------------
// Login helper - each VU logs in once (own cookie jar) and reuses the
// session for every iteration that follows.
// ---------------------------------------------------------------------------
const loggedInVUs = {};

function ensureLoggedIn() {
  if (loggedInVUs[__VU]) return true;
  if (!LARC_USERNAME || !LARC_PASSWORD) {
    // No credentials configured - proceed unauthenticated (useful once you've
    // confirmed the endpoint under test doesn't require a session, or while
    // you're still wiring up LOGIN_PATH/fields).
    loggedInVUs[__VU] = true;
    return true;
  }

  const loginPageRes = http.get(`${BASE_URL}${LOGIN_PATH}`, {
    tags: { name: 'GET login page' },
  });

  // Best-effort CSRF token extraction (covers common Laravel/PHP patterns:
  // <input type="hidden" name="_token" value="...">). Remove if not needed.
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
// Scenario 1: heterogeneous node data ingestion
// ---------------------------------------------------------------------------
export function nodeIngestionScenario() {
  group('node_ingestion', () => {
    ensureLoggedIn();

    const profile = NODE_PROFILES[__VU % NODE_PROFILES.length];
    const room = ROOMS[__VU % ROOMS.length];
    const nodeId = `${profile.type}-${room}-${__VU}`;

    const payload = JSON.stringify({
      node_id: nodeId,
      device_type: profile.type,
      firmware: profile.firmware,
      room: room,
      timestamp: new Date().toISOString(),
      ...profile.fields(),
    });

    const res = http.post(`${BASE_URL}${NODE_INGEST_PATH}`, payload, {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST node reading' },
    });

    nodeIngestDuration.add(res.timings.duration);
    const ok = check(res, {
      'ingest accepted (2xx)': (r) => r.status >= 200 && r.status < 300,
    });
    ok ? nodeIngestSuccess.add(1) : nodeIngestFailure.add(1);

    // Simulated nodes report periodically, not in a tight loop.
    sleep(Math.random() * 3 + 2); // 2-5s between readings per simulated node
  });
}

// ---------------------------------------------------------------------------
// Scenario 2: concurrent dashboard viewers
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
// Summary output - written to summary.json (and a text summary to console)
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  return {
    'summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}
