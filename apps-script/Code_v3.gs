// =====================================================================
// ROOM INTELLIGENCE — Google Apps Script (v3.0.0)
// Code calculates, the model explains, the reed switch verifies.
//
// v3.0.0 — RING × ROOM. The report is built around one question: what did the room do, and what did
// your body do in the same minutes? Oura keeps 5-minute heart rate, HRV and sleep stage inside every
// sleep document; code lines every 5-minute point up with the bedroom readings from the same minutes
// (section "RING × ROOM FUSION"). After pasting, run fusionBacktest() once: it rebuilds the history
// in the "Fusion 5min" tab and checks the numbers against an independent calculation.
//
// No keys in code. Project Settings → Script properties:
//   OURA_CLIENT_ID, OURA_CLIENT_SECRET   Oura
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID Telegram bot
//   NEBIUS_API_KEY, NEBIUS_MODEL         Nebius Token Factory (Nemotron)
//   SECRET_KEY (optional)                must match SHARED_SECRET in the firmware's secrets.h
//
// Requires the OAuth2 library. After pasting: checkSetup(), setupTrigger(), setupCommands(),
// then Deploy → Manage deployments → New version.
// =====================================================================


// ========== SETTINGS ==========

const SENSOR_SHEET_NAME = 'Sensor Data'; // sensor tab (falls back to the first tab)
const OURA_SHEET_NAME   = 'Oura Sleep';
const REPORT_SHEET_NAME = 'Sleep Report';
const NIGHT_START_HOUR  = 23;              // night window without Oura: 23:00 …
const NIGHT_END_HOUR    = 7;               // … 07:00, project time zone
const DARK_THRESHOLD    = 50;              // brightness below this counts as dark
const CO2_HIGH          = 1000;            // stuffy threshold, ppm
const SLEEP_TEMP_MIN    = 16;              // general sleep guideline, °C (not medical advice)
const SLEEP_TEMP_MAX    = 20;
const HUM_MIN           = 40;              // %
const HUM_MAX           = 60;
const SLEEP_SHORT_MIN   = 420;             // under 7 h = short night
const CODE_VERSION      = '3.0.0';         // checked by Evals.gs
const LOW_SLEEP_MIN     = 180;             // under 3 h = too little sleep to link room and body
const RUN_LOG_SHEET_NAME = 'Run Log';
const ASK_LOG_SHEET_NAME = 'Ask Log';
const ASK_DAYS          = 21;              // nights the Q&A looks at

// Sensor tab columns (0-based): A Date, B Temp, C Humidity, D Brightness,
// E Window Open (legacy, empty), F Sound, G CO2, H Window Contact
const COL = { date: 0, temp: 1, hum: 2, light: 3, oldWindow: 4, sound: 5, co2: 6, contact: 7 };


// ========== HELPERS ==========

function prop_(name, required) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v && required) throw new Error('Missing Script property ' + name);
  return v;
}

function getSensorSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SENSOR_SHEET_NAME) || ss.getSheets()[0];
}

// '' / null / junk → null (Number('') is 0, which skewed averages)
function toNum(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function cell_(v) { return (v === null || v === undefined) ? '' : v; }

function dayStr_(offsetDays) {
  return Utilities.formatDate(new Date(Date.now() + offsetDays * 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function minFromSec_(sec) { return (sec === null || sec === undefined) ? null : Math.round(sec / 60); }


// ========== SENSOR DATA (web app) ==========

function doPost(e) {
  if (!e || !e.postData) return ContentService.createTextOutput('doPost is called by the board, not manually');

  let data;
  try { data = JSON.parse(e.postData.contents); }
  catch (err) { return ContentService.createTextOutput('Bad JSON'); }

  const secret = prop_('SECRET_KEY', false);
  if (secret && data.secret !== secret) return ContentService.createTextOutput('Forbidden');

  getSensorSheet().appendRow([
    new Date(),
    cell_(data.temp),
    cell_(data.humidity),
    cell_(data.brightness),
    '',                          // E: legacy camera window column
    cell_(data.sound),           // F: noise (signal swing over ~1 s)
    cell_(data.co2),             // G: CO2, ppm
    cell_(data.window_contact)   // H: "closed" / "open"
  ]);
  return ContentService.createTextOutput('OK');
}

// Run once: header row for the sensor tab
function setupSensorHeaders() {
  const sheet = getSensorSheet();
  if (sheet.getRange(1, 1).getValue() === 'Date') { Logger.log('Headers already exist.'); return; }
  sheet.insertRowBefore(1);
  sheet.getRange(1, 1, 1, 8).setValues([[
    'Date', 'Temp', 'Humidity', 'Brightness', 'Window Open', 'Sound', 'CO2', 'Window Contact'
  ]]);
  sheet.setFrozenRows(1);
  Logger.log('Headers added.');
}


// ========== OURA: AUTH ==========

function getOuraService() {
  return OAuth2.createService('oura')
    .setAuthorizationBaseUrl('https://cloud.ouraring.com/oauth/authorize')
    .setTokenUrl('https://api.ouraring.com/oauth/token')
    .setClientId(prop_('OURA_CLIENT_ID', true))
    .setClientSecret(prop_('OURA_CLIENT_SECRET', true))
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('email personal daily');
}

function authorize() {
  const service = getOuraService();
  if (service.hasAccess()) Logger.log('Already authorized.');
  else Logger.log('Open this link in a browser: ' + service.getAuthorizationUrl());
}

function authCallback(request) {
  const ok = getOuraService().handleCallback(request);
  return HtmlService.createHtmlOutput(ok ? 'Done! You can close this tab.' : 'Access denied.');
}


// ========== OURA: DATA ==========

// Never throws: logs the error and returns null
function ouraGet_(path, startDate, endDate) {
  const service = getOuraService();
  if (!service.hasAccess()) { Logger.log('Oura: no access, run authorize()'); return null; }
  const url = 'https://api.ouraring.com/v2/usercollection/' + path + '?start_date=' + startDate + '&end_date=' + endDate;
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('Oura ' + path + ': ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
    return null;
  }
  return JSON.parse(res.getContentText()).data || [];
}

// Last night from Oura (ended in the last 20 h), or null.
// Broken sleep comes as several pieces; pieces of one night are merged: the window runs from the first
// bedtime to the last wake-up and sleep durations are summed. Adds: pieces, partial (no piece is Oura's
// main sleep) and segments [{start, phases}] for the chart.
function getOuraSleep() {
  const items = ouraGet_('sleep', dayStr_(-2), dayStr_(1));
  if (!items || !items.length) return null;
  return mergeNight_(items, Date.now());
}

function mergeNight_(items, nowMs) {
  const since = nowMs - 20 * 3600 * 1000;
  const recent = items.filter(n => n.bedtime_start && n.bedtime_end && n.type !== 'deleted' && n.type !== 'rest' &&
                                   new Date(n.bedtime_end).getTime() > since);
  if (!recent.length) return null;
  recent.sort((a, b) => new Date(a.bedtime_start) - new Date(b.bedtime_start));
  const longs = recent.filter(n => n.type === 'long_sleep');
  const main = longs.length ? longs[longs.length - 1]
             : recent.reduce((a, b) => (Number(b.total_sleep_duration) || 0) > (Number(a.total_sleep_duration) || 0) ? b : a);
  const mainEnd = new Date(main.bedtime_end).getTime();
  // pieces of the same night: same Oura day, starting at most 14 h before the main piece ends
  // v3: and not later than 1 h after it ends (an afternoon nap is not part of the night)
  const pieces = recent.filter(n => n.day === main.day && new Date(n.bedtime_start).getTime() >= mainEnd - 14 * 3600000 &&
                                    new Date(n.bedtime_start).getTime() <= mainEnd + 3600000);
  const seg = n => ({ start: n.bedtime_start, phases: n.sleep_phase_5_min || '' });
  if (pieces.length < 2) {
    // v3: docs = the raw Oura pieces; ringSeries_() reads the 5-minute series from them
    return Object.assign({}, main, { pieces: 1, partial: main.type !== 'long_sleep', segments: [seg(main)], docs: [main] });
  }
  const sum = k => pieces.reduce((s, n) => s + (Number(n[k]) || 0), 0);
  const startMs = Math.min(...pieces.map(n => new Date(n.bedtime_start).getTime()));
  const endMs = Math.max(...pieces.map(n => new Date(n.bedtime_end).getTime()));
  const spanSec = Math.round((endMs - startMs) / 1000);
  const total = sum('total_sleep_duration');
  const wavg = k => {                                   // weighted by minutes of sleep
    let w = 0, s = 0;
    pieces.forEach(n => { const v = Number(n[k]); const ww = Number(n.total_sleep_duration) || 0;
                          if (n[k] !== null && n[k] !== undefined && !isNaN(v) && ww > 0) { s += v * ww; w += ww; } });
    return w ? s / w : null;
  };
  const hrs = pieces.map(n => n.lowest_heart_rate).filter(v => v !== null && v !== undefined);
  const first = pieces[0], last = pieces.reduce((a, b) => new Date(b.bedtime_end) > new Date(a.bedtime_end) ? b : a);
  return Object.assign({}, main, {
    bedtime_start: first.bedtime_start, bedtime_end: last.bedtime_end,
    total_sleep_duration: total,
    deep_sleep_duration: sum('deep_sleep_duration'),
    rem_sleep_duration: sum('rem_sleep_duration'),
    light_sleep_duration: sum('light_sleep_duration'),
    awake_time: Math.max(0, spanSec - total),          // all non-sleep time in the window, gaps included
    time_in_bed: spanSec,
    efficiency: spanSec > 0 ? Math.round(total / spanSec * 100) : null,
    latency: first.latency,
    lowest_heart_rate: hrs.length ? Math.min(...hrs) : null,
    average_hrv: wavg('average_hrv') === null ? null : Math.round(wavg('average_hrv')),
    average_breath: wavg('average_breath') === null ? null : Math.round(wavg('average_breath') * 10) / 10,
    sleep_phase_5_min: null,
    pieces: pieces.length,
    partial: !pieces.some(n => n.type === 'long_sleep'),
    segments: pieces.map(seg),
    docs: pieces                                         // v3: raw pieces, for the 5-minute series
  });
}

function getOuraReadiness() {
  const items = ouraGet_('daily_readiness', dayStr_(0), dayStr_(1));
  if (!items || !items.length) return null;
  const today = dayStr_(0);
  return items.filter(d => d.day === today)[0] || null;
}

// Oura nights → "Oura Sleep" tab, last 7 days, no duplicates (by id)
function saveOuraSleepToSheet() {
  const items = ouraGet_('sleep', dayStr_(-7), dayStr_(1));
  if (items === null) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(OURA_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(OURA_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['id', 'day', 'type', 'bedtime_start', 'bedtime_end', 'total_sleep_h', 'deep_h', 'rem_h',
                     'light_h', 'awake_min', 'efficiency', 'latency_min', 'avg_hrv', 'lowest_hr', 'avg_breath']);
    sheet.setFrozenRows(1);
  }

  const lastRow = sheet.getLastRow();
  const have = new Set(lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat() : []);
  const hours = s => (s === null || s === undefined) ? '' : Math.round(s / 360) / 10;

  let added = 0;
  items.forEach(s => {
    if (have.has(s.id)) return;
    sheet.appendRow([
      s.id, s.day, s.type, s.bedtime_start, s.bedtime_end,
      hours(s.total_sleep_duration), hours(s.deep_sleep_duration), hours(s.rem_sleep_duration), hours(s.light_sleep_duration),
      cell_(minFromSec_(s.awake_time)), cell_(s.efficiency), cell_(minFromSec_(s.latency)),
      cell_(s.average_hrv), cell_(s.lowest_heart_rate), cell_(s.average_breath)
    ]);
    added++;
  });
  Logger.log('Oura: added ' + added + ' of ' + items.length + ' rows');
}


// ========== ROOM: NIGHT STATS ==========

// Window state: reed switch (H); old rows fall back to column E
function rowWindowState_(row) {
  const h = String(row[COL.contact] || '').trim().toLowerCase();
  if (h === 'open' || h === 'closed') return h;
  const e = row[COL.oldWindow];
  if (e === true || e === 'true' || e === 'TRUE') return 'open';
  return null;
}

// start/end optional: defaults to 23:00–07:00
function getRoomStatsForNight(start, end, values) {
  values = values || getSensorSheet().getDataRange().getValues();   // pass rows in when computing many nights

  const now = new Date();
  const windowEnd = end || new Date(now.getFullYear(), now.getMonth(), now.getDate(), NIGHT_END_HOUR, 0, 0);
  const windowStart = start || new Date(windowEnd.getTime() - ((24 - NIGHT_START_HOUR) + NIGHT_END_HOUR) * 3600 * 1000);

  const temps = [], humids = [], lights = [], co2s = [];
  let darkCount = 0, total = 0;
  let prevState = null, prevTime = null, lastTime = null;
  const events = [];

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const t = new Date(row[COL.date]);
    if (isNaN(t.getTime())) continue;                 // header or junk
    const state = rowWindowState_(row);

    if (t < windowStart) { if (state) { prevState = state; prevTime = t; } continue; }
    if (t > windowEnd) continue;

    total++;
    lastTime = t;
    if (state) events.push({ t: t, s: state });

    const temp = toNum(row[COL.temp]), hum = toNum(row[COL.hum]), light = toNum(row[COL.light]), co2 = toNum(row[COL.co2]);
    if (temp !== null) temps.push(temp);
    if (hum !== null) humids.push(hum);
    if (light !== null) { lights.push(light); if (light < DARK_THRESHOLD) darkCount++; }
    if (co2 !== null && co2 > 0) co2s.push(co2);
  }

  if (total === 0 || !temps.length || !humids.length) return null;

  // window state from more than 12 h before the night is not trusted
  if (prevTime && (windowStart - prevTime) > 12 * 3600 * 1000) prevState = null;

  // % of time open, by time rather than row count (window events are extra rows)
  let openMs = 0, knownMs = 0, cursor = windowStart, cur = prevState, changes = 0;
  events.forEach(ev => {
    if (cur !== null) { const dt = ev.t - cursor; knownMs += dt; if (cur === 'open') openMs += dt; }
    if (cur !== null && ev.s !== cur) changes++;
    cursor = ev.t; cur = ev.s;
  });
  if (cur !== null && lastTime) {
    // extend the last state at most 5 min past the last row (the board may have stopped)
    const endT = Math.min(windowEnd.getTime(), lastTime.getTime() + 5 * 60 * 1000);
    const dt = endT - cursor.getTime();
    if (dt > 0) { knownMs += dt; if (cur === 'open') openMs += dt; }
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const avgTemp = avg(temps);
  const tempStdDev = Math.sqrt(temps.reduce((a, x) => a + Math.pow(x - avgTemp, 2), 0) / temps.length);

  return {
    avgTemp: avgTemp,
    minTemp: Math.min(...temps),
    maxTemp: Math.max(...temps),
    tempStdDev: tempStdDev,
    avgHumidity: avg(humids),
    avgBrightness: avg(lights),
    maxBrightness: lights.length ? Math.max(...lights) : 0,
    pctDark: lights.length ? darkCount / lights.length * 100 : 0,
    pctWindowOpen: knownMs > 0 ? openMs / knownMs * 100 : null,   // null = no reed data
    windowChanges: changes,
    avgCO2: co2s.length ? avg(co2s) : null,
    maxCO2: co2s.length ? Math.max(...co2s) : null,
    pctCO2High: co2s.length ? co2s.filter(c => c > CO2_HIGH).length / co2s.length * 100 : null,
    readingsCount: total
  };
}

function calculateRoomScore(room) {
  const tempScore = Math.max(0, 25 - Math.abs(room.avgTemp - 19) * 5);
  const humidityScore = Math.max(0, 25 - Math.abs(room.avgHumidity - 45) * 1.25);
  const darknessScore = (room.pctDark / 100) * 25;
  const stabilityScore = Math.max(0, 25 - room.tempStdDev * 10);
  return Math.round(tempScore + humidityScore + darknessScore + stabilityScore);
}


// ========== RING × ROOM FUSION (v3) ==========
// The heart of the project. The ring knows the body, the board knows the room; only together can they
// say what the room did to you. Oura keeps three 5-minute series inside every sleep document: heart rate,
// HRV and sleep stage. Code takes every 5-minute point, adds the bedroom readings from the same minutes
// and compares. Every number is computed here; Nemotron only explains them.

const FUSION_SHEET_NAME    = 'Fusion 5min'; // history: one row per 5-minute point, ring + room
const FUSE_WINDOW_MIN      = 3;             // room readings within ±3 min of a ring point (the board writes every 2 min)
const FUSION_WARM_C        = 22.5;          // "warm stretch", °C. Seen on the first 7 nights (exploratory): a hint to re-test, not a rule
const FUSION_MIN_POINTS    = 6;             // a comparison needs at least 6 points (30 min) on each side
const FUSION_MIN_REF       = 3;             // a sleep stage needs at least 3 reference points to be compared
const FUSION_HRV_TOL       = 0.10;          // HRV within 10 % = "about the same" (same tolerance as metricRows_)
const FUSION_HR_TOL        = 2;             // pulse within 2 bpm = "about the same" (same as "Lowest heart rate")
const FUSION_BACKTEST_DAYS = 28;            // fusionBacktest(): how many days of Oura nights to rebuild
const FUSION_STAGE   = { '1': 'deep', '2': 'light', '3': 'rem', '4': 'awake' };   // Oura stage codes
const FUSION_HEADERS = ['Day', 'SleepId', 'Time', 'Stage', 'HeartRate', 'HRV', 'Temp', 'CO2', 'Humidity', 'WindowOpen'];

function fMean_(arr) {                                               // mean of the numbers in a list, or null
  const v = arr.filter(x => x !== null && x !== undefined && !isNaN(x));   // drop empty values
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;       // the average, or null if nothing is left
}
function fR0_(x) { return String(Math.round(x)); }                   // whole number as text: 31.9 → "32"
function fT1_(x) { return (Math.round(x * 10) / 10).toFixed(1); }    // one decimal as text: 23.08 → "23.1"

// 1. THE RING: 5-minute points { t, hr, hrv, stage } from every Oura piece of the night
function ringSeries_(night) {
  const docs = night && night.docs && night.docs.length ? night.docs : (night ? [night] : []);   // raw pieces, or the night itself
  const out = [];                                                    // collected points
  docs.forEach(doc => {
    const hr = doc.heart_rate, hv = doc.hrv;                         // Oura series: { interval (s), items [...], timestamp }
    if (!hr || !hr.items || !hr.timestamp) return;                   // this piece has no heart-rate series
    const t0 = new Date(hr.timestamp).getTime();                     // time of the first heart-rate point, ms
    const step = (hr.interval || 300) * 1000;                        // step between points, ms (300 s = 5 min)
    const hrvAt = {};                                                // HRV by time, so the two series line up exactly
    if (hv && hv.items && hv.timestamp) {
      const h0 = new Date(hv.timestamp).getTime();                   // time of the first HRV point
      const hs = (hv.interval || 300) * 1000;                        // HRV step, ms
      hv.items.forEach((v, i) => { hrvAt[h0 + i * hs] = v; });       // every HRV value at its own time
    }
    const bs = new Date(doc.bedtime_start).getTime();                // the stage string starts at bedtime
    const phases = String(doc.sleep_phase_5_min || '');              // one character per 5 min: 1 deep, 2 light, 3 REM, 4 awake
    hr.items.forEach((v, i) => {
      const t = t0 + i * step;                                       // time of this point
      const code = phases.charAt(Math.floor((t - bs) / 300000));     // stage character for these 5 minutes
      out.push({ t: t, hr: toNum(v), hrv: toNum(hrvAt[t]), stage: FUSION_STAGE[code] || null });
    });
  });
  return out.filter(p => p.hr !== null && p.hrv !== null && p.hr > 0 && p.hrv > 0)   // keep points that have both values
            .sort((a, b) => a.t - b.t);                              // in time order
}

// 2. THE ROOM: bedroom rows between two moments, as { t, temp, hum, co2, win }
function sensorRowsBetween_(values, fromMs, toMs) {
  const rows = [];
  values.forEach(row => {
    const t = new Date(row[COL.date]).getTime();                     // time of the sensor row
    if (isNaN(t) || t < fromMs || t > toMs) return;                  // header, junk, or outside the night
    const co2 = toNum(row[COL.co2]);                                 // CO₂, ppm (0 = sensor not ready yet)
    rows.push({ t: t, temp: toNum(row[COL.temp]), hum: toNum(row[COL.hum]),
                co2: co2 !== null && co2 > 0 ? co2 : null, win: rowWindowState_(row) });
  });
  return rows;
}

// 3. FUSION: every ring point gets the mean of the room rows within ±FUSE_WINDOW_MIN minutes
function fusePoints_(ring, values) {
  if (!ring.length) return [];                                       // no ring series: nothing to fuse
  const w = FUSE_WINDOW_MIN * 60000;                                 // ±3 min in ms
  const rows = sensorRowsBetween_(values, ring[0].t - w, ring[ring.length - 1].t + w);   // only this night's rows
  return ring.map(p => {
    const near = rows.filter(r => Math.abs(r.t - p.t) <= w);         // room rows from the same minutes
    const temp = fMean_(near.map(r => r.temp));                      // room temperature at this point
    if (temp === null) return null;                                  // no room data for these minutes: skip the point
    return { t: p.t, hr: p.hr, hrv: p.hrv, stage: p.stage, temp: temp,
             co2: fMean_(near.map(r => r.co2)),                      // CO₂ at this point (null if the sensor was off)
             hum: fMean_(near.map(r => r.hum)),                      // humidity at this point
             open: near.some(r => r.win === 'open') };               // window open at any row in these minutes
  }).filter(Boolean);                                                // drop the skipped points
}

// Verdicts with the same tolerances as the "you vs your usual" table
function fHrvVerdict_(v, ref) {                                      // HRV: higher is better
  if (v === null || ref === null || ref === undefined) return null;
  return Math.abs(v - ref) <= ref * FUSION_HRV_TOL ? 'same' : v < ref ? 'lower' : 'higher';
}
function fHrVerdict_(v, ref) {                                       // pulse: lower is better
  if (v === null || ref === null || ref === undefined) return null;
  return Math.abs(v - ref) <= FUSION_HR_TOL ? 'same' : v > ref ? 'higher' : 'lower';
}

// A stretch (warm minutes, stuffy minutes) vs the rest of the SAME night, in the SAME SLEEP STAGE only.
// HRV is naturally different in deep, light and REM sleep, so each stretch point is compared with the
// rest-of-night points of its own stage. Returns null when there is too little data.
function cmpStretch_(stretch, rest) {
  if (stretch.length < FUSION_MIN_POINTS || rest.length < FUSION_MIN_POINTS) return null;   // under 30 min on a side
  const hrv = [], refHrv = [], hr = [], refHr = [];
  stretch.forEach(p => {
    const same = rest.filter(q => q.stage === p.stage);              // rest-of-night points in the same stage
    if (same.length < FUSION_MIN_REF) return;                        // too few to compare this point
    hrv.push(p.hrv); refHrv.push(fMean_(same.map(q => q.hrv)));      // this point's HRV and its reference
    hr.push(p.hr);   refHr.push(fMean_(same.map(q => q.hr)));        // the same for pulse
  });
  if (hrv.length < FUSION_MIN_POINTS) return null;                   // too few comparable points
  const out = { n: hrv.length, minutes: hrv.length * 5, hrv: fMean_(hrv), refHrv: fMean_(refHrv), hr: fMean_(hr), refHr: fMean_(refHr) };
  out.hrvVerdict = fHrvVerdict_(out.hrv, out.refHrv);                // lower / same / higher
  out.hrVerdict = fHrVerdict_(out.hr, out.refHr);                    // higher / same / lower
  return out;
}

// 4. ONE NIGHT. pts: tonight's fused points; others: fused points of other nights, each with .day
function fusionNight_(pts, others) {
  if (!pts || pts.length < FUSION_MIN_POINTS) return null;           // under 30 min of fused data: no verdicts
  const co2s = pts.filter(p => p.co2 !== null).map(p => p.co2);      // CO₂ values tonight
  const f = {
    points: pts.length, minutes: pts.length * 5,                     // how much of the night is fused
    avgTemp: fMean_(pts.map(p => p.temp)),                           // tonight's averages over the fused points
    minTemp: Math.min(...pts.map(p => p.temp)), maxTemp: Math.max(...pts.map(p => p.temp)),
    avgHrv: fMean_(pts.map(p => p.hrv)), avgHr: fMean_(pts.map(p => p.hr)),
    maxCo2: co2s.length ? Math.max(...co2s) : null
  };
  // your other nights: each night counts once (mean of nightly means)
  const byDay = {};
  (others || []).forEach(p => { (byDay[p.day] = byDay[p.day] || []).push(p); });       // group other points by night
  const days = Object.keys(byDay).filter(d => byDay[d].length >= FUSION_MIN_POINTS);   // nights with enough data
  if (days.length >= 2) {                                            // "usual" needs at least 2 other nights
    const nm = k => fMean_(days.map(d => fMean_(byDay[d].map(p => p[k]))));            // mean of nightly means
    f.usual = { nights: days.length, temp: nm('temp'), hrv: nm('hrv'), hr: nm('hr') };
    f.hrvVsUsual = fHrvVerdict_(f.avgHrv, f.usual.hrv);              // tonight vs your other nights
    f.hrVsUsual = fHrVerdict_(f.avgHr, f.usual.hr);
    // stage by stage: was HRV lower in every stage, or did the night only have a different mix of stages?
    const pool = [].concat(...days.map(d => byDay[d]));              // all points of the other nights
    f.stages = ['deep', 'light', 'rem', 'awake'].map(s => {
      const a = pts.filter(p => p.stage === s), b = pool.filter(p => p.stage === s);    // tonight / other nights, stage s
      if (a.length < FUSION_MIN_REF || b.length < FUSION_MIN_REF) return null;          // too few points in this stage
      return { stage: s, n: a.length, hrv: fMean_(a.map(p => p.hrv)), refHrv: fMean_(b.map(p => p.hrv)),
               hr: fMean_(a.map(p => p.hr)), refHr: fMean_(b.map(p => p.hr)) };
    }).filter(Boolean);
    f.allStagesLower = f.stages.length >= 2 && f.stages.every(s => fHrvVerdict_(s.hrv, s.refHrv) === 'lower');   // HRV lower in every stage
    f.allStagesHrHigher = f.stages.length >= 2 && f.stages.every(s => fHrVerdict_(s.hr, s.refHr) === 'higher');  // pulse higher in every stage
  }
  // warm stretch: minutes at or above FUSION_WARM_C vs the rest of the night, same stage
  const warm = pts.filter(p => p.temp >= FUSION_WARM_C);
  f.warmMin = warm.length * 5;                                       // minutes at or above the warm threshold
  f.warm = cmpStretch_(warm, pts.filter(p => p.temp < FUSION_WARM_C));
  // stuffy stretch: minutes with CO₂ at or above CO2_HIGH vs the fresher minutes of the same night, same stage
  const withCo2 = pts.filter(p => p.co2 !== null);
  f.stuffyMin = withCo2.filter(p => p.co2 >= CO2_HIGH).length * 5;
  f.stuffy = cmpStretch_(withCo2.filter(p => p.co2 >= CO2_HIGH), withCo2.filter(p => p.co2 < CO2_HIGH));
  return f;
}

// 5. YOUR MAP: every fused point of every night, grouped by room temperature rounded to a whole degree
function fusionMap_(allPts) {
  const bands = {};
  allPts.forEach(p => {
    const b = Math.round(p.temp);                                    // 22.4 → 22 °C, 22.5 → 23 °C
    (bands[b] = bands[b] || []).push(p);
  });
  const rows = Object.keys(bands).map(Number).sort((a, b) => a - b).map(b => ({
    c: b, points: bands[b].length,                                   // the band and how many 5-minute points it holds
    nights: new Set(bands[b].map(p => p.day)).size,                  // on how many nights
    hrv: fMean_(bands[b].map(p => p.hrv)), hr: fMean_(bands[b].map(p => p.hr))
  })).filter(r => r.points >= FUSION_MIN_POINTS);                    // only bands with at least 30 min of data
  return { rows: rows, nights: new Set(allPts.map(p => p.day)).size,
           all: { hrv: fMean_(allPts.map(p => p.hrv)), hr: fMean_(allPts.map(p => p.hr)) } };   // everything pooled
}

// Tonight in your map: did the room stay in bands where your HRV and pulse have been normal?
function fusionNeutral_(pts, map) {
  if (!map || map.nights < 3 || !pts.length) return null;            // the map needs at least 3 nights
  const counts = {};
  pts.forEach(p => { const b = Math.round(p.temp); counts[b] = (counts[b] || 0) + 1; });  // tonight's points per band
  const main = Object.keys(counts).map(Number).filter(b => counts[b] >= pts.length * 0.1); // bands with ≥10 % of the night
  return main.every(b => {
    const r = map.rows.filter(x => x.c === b)[0];                    // this band in your map
    return !!r && r.nights >= 2 && fHrvVerdict_(r.hrv, map.all.hrv) !== 'lower' && fHrVerdict_(r.hr, map.all.hr) !== 'higher';
  });
}

// How often warm minutes went with a worse body so far (each night checked against all the others)
function fusionHistory_(allPts) {
  const byDay = {};
  allPts.forEach(p => { (byDay[p.day] = byDay[p.day] || []).push(p); });   // points per night
  const days = Object.keys(byDay);
  let warmNights = 0, warmWorse = 0;
  days.forEach(d => {
    const f = fusionNight_(byDay[d], allPts.filter(p => p.day !== d));
    if (!f) return;                                                  // too little data on this night
    const warmNight = f.avgTemp >= FUSION_WARM_C;                    // the whole night was warm
    if (warmNight && !f.usual) return;                               // a warm night needs other nights to compare with
    if (!warmNight && !f.warm) return;                               // no warm minutes to judge on this night
    warmNights++;
    const worse = warmNight ? (f.hrvVsUsual === 'lower' || f.hrVsUsual === 'higher')               // warm night vs other nights
                            : (f.warm.hrvVerdict === 'lower' || f.warm.hrVerdict === 'higher');   // warm stretch vs same night
    if (worse) warmWorse++;
  });
  return { nights: days.length, warmNights: warmNights, warmWorse: warmWorse,
           pattern: warmWorse >= 3 && warmWorse / warmNights >= 0.75 };    // a pattern only from 3+ nights that agree
}

// History tab: read, and replace the points of some nights
function fusionSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(FUSION_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(FUSION_SHEET_NAME);
    sh.appendRow(FUSION_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');                         // keep the day as text, not as a date
  }
  return sh;
}
function fDay_(v) {                                                  // a day cell back to 'yyyy-MM-dd'
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v);
}
function fusionLoad_() {
  const sh = fusionSheet_();
  if (sh.getLastRow() < 2) return [];                                // empty history
  return sh.getRange(2, 1, sh.getLastRow() - 1, FUSION_HEADERS.length).getValues().map(r => ({
    day: fDay_(r[0]), id: String(r[1]), t: new Date(r[2]).getTime(), stage: r[3] || null,
    hr: toNum(r[4]), hrv: toNum(r[5]), temp: toNum(r[6]), co2: toNum(r[7]), hum: toNum(r[8]),
    open: r[9] === true || r[9] === 'TRUE'
  })).filter(p => p.hr !== null && p.hrv !== null && p.temp !== null && !isNaN(p.t));
}
function fusionSave_(nights) {                                       // nights: [{ day, id, points }]
  const sh = fusionSheet_();
  const replace = new Set(nights.map(n => n.day));                   // these nights are rewritten
  const all = fusionLoad_().filter(p => !replace.has(p.day))         // keep every other night
    .concat(...nights.map(n => n.points.map(p => Object.assign({}, p, { day: n.day, id: n.id }))));
  all.sort((a, b) => a.t - b.t);                                     // time order
  const rows = all.map(p => [p.day, p.id, new Date(p.t), p.stage || '', p.hr, p.hrv, p.temp,
                             p.co2 === null ? '' : p.co2, p.hum === null ? '' : p.hum, !!p.open]);
  sh.getRange('A:A').setNumberFormat('@');                           // day as text
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, FUSION_HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, FUSION_HEADERS.length).setValues(rows);
}

// 6. EVERYTHING FOR ONE NIGHT: ring → fusion → verdicts → map → history. Saves tonight to the history tab.
// Returns { night, map, history, neutral, points } or { reason } when the night cannot be fused.
function fusionForNight_(sleep) {
  if (!sleep) return null;                                           // no ring night at all
  const ring = ringSeries_(sleep);                                   // 5-minute points from the ring
  if (!ring.length) return { reason: 'Oura sent no 5-minute heart-rate and HRV series for this night', ring: 0, points: [] };
  const points = fusePoints_(ring, getSensorSheet().getDataRange().getValues());   // + bedroom readings
  if (points.length < FUSION_MIN_POINTS) return { reason: 'no bedroom readings for the minutes the ring recorded', ring: ring.length, points: points };
  try { fusionSave_([{ day: sleep.day, id: sleep.id, points: points }]); } catch (e) { Logger.log('fusion save: ' + e); }
  const others = fusionLoad_().filter(p => p.day !== sleep.day);     // the history, without tonight
  const all = others.concat(points.map(p => Object.assign({ day: sleep.day }, p)));
  const map = fusionMap_(all);
  return { ring: ring.length, points: points, night: fusionNight_(points, others), map: map,
           history: fusionHistory_(all), neutral: fusionNeutral_(points, map) };
}

// 7. WORDS. Each finding has a full sentence (model input and "why") and a short line (the report).
// effect: the room and the body moved together; worse: the body moved the bad way.
function stretchFinding_(w, kind, what, ref) {
  const worse = w.hrvVerdict === 'lower' || w.hrVerdict === 'higher';           // body worse in the stretch
  const better = !worse && (w.hrvVerdict === 'higher' || w.hrVerdict === 'lower');
  const nums = 'HRV ' + fR0_(w.hrv) + ' versus ' + fR0_(w.refHrv) + ' ms, pulse ' + fR0_(w.hr) + ' versus ' + fR0_(w.refHr) + ' bpm';
  const moved = [];
  if (w.hrvVerdict === 'lower') moved.push('a lower HRV');
  if (w.hrvVerdict === 'higher') moved.push('a higher HRV');
  if (w.hrVerdict === 'higher') moved.push('a higher pulse');
  if (w.hrVerdict === 'lower') moved.push('a lower pulse');
  const short = w.minutes + ' min ' + what.short + ': HRV ' + fR0_(w.hrv) + ' vs ' + fR0_(w.refHrv) + ' ms, pulse ' + fR0_(w.hr) + ' vs ' + fR0_(w.refHr) +
                ' (same sleep stages' + ref.short + ')' + (worse || better ? '' : ' — no difference');
  return (worse || better)
    ? { kind: kind, effect: true, worse: worse, short: short,
        sentence: 'The ' + w.minutes + ' minutes when ' + what.long + ' coincide with ' + moved.join(' and ') +
                  ' than in the same sleep stages ' + ref.long + ': ' + nums }
    : { kind: kind, effect: false, worse: false, short: short,
        sentence: 'In the ' + w.minutes + ' minutes when ' + what.long + ', your HRV and pulse stayed about the same as in the same sleep stages ' +
                  ref.long + ' (' + nums + '), so there is no clear link for them' };
}

function fusionFindings_(fx) {
  const f = fx.night, out = [];
  if (f.usual) {
    const dT = f.avgTemp - f.usual.temp;                             // tonight's room vs your other nights, °C
    const roomDiff = Math.abs(dT) >= 1;                              // the room was really different (1 °C or more)
    const word = dT > 0 ? 'warmer' : 'cooler';
    const worse = f.hrvVsUsual === 'lower' || f.hrVsUsual === 'higher';
    const better = !worse && (f.hrvVsUsual === 'higher' || f.hrVsUsual === 'lower');
    const parts = [];                                                // how the body moved, in words with numbers
    if (f.hrvVsUsual === 'lower' || f.hrvVsUsual === 'higher')
      parts.push('a ' + f.hrvVsUsual + ' HRV: ' + fR0_(f.avgHrv) + ' versus ' + fR0_(f.usual.hrv) + ' ms' +
                 (f.allStagesLower ? ', lower in every sleep stage' : ''));
    if (f.hrVsUsual === 'higher' || f.hrVsUsual === 'lower')
      parts.push('a ' + f.hrVsUsual + ' pulse: ' + fR0_(f.avgHr) + ' versus ' + fR0_(f.usual.hr) + ' bpm' +
                 (f.allStagesHrHigher ? ', higher in every sleep stage' : ''));
    const pct = Math.round(Math.abs(1 - f.avgHrv / f.usual.hrv) * 100);   // HRV change, %
    const bodyShort = [];
    if (f.hrvVsUsual === 'lower' || f.hrvVsUsual === 'higher') bodyShort.push('HRV ' + pct + '% ' + f.hrvVsUsual + (f.allStagesLower ? ' in every sleep stage' : ''));
    if (f.hrVsUsual === 'higher' || f.hrVsUsual === 'lower') bodyShort.push('pulse ' + (f.avgHr > f.usual.hr ? '+' : '−') + fR0_(Math.abs(f.avgHr - f.usual.hr)) + ' bpm');
    const roomShort = 'room ' + (dT >= 0 ? '+' : '−') + fT1_(Math.abs(dT)) + ' °C vs your other nights';
    if ((worse || better) && roomDiff) {
      out.push({ kind: 'night', effect: true, worse: worse, short: roomShort + ': ' + bodyShort.join(', '),
                 sentence: 'The ' + word + ' room tonight (' + fT1_(f.avgTemp) + ' °C versus ' + fT1_(f.usual.temp) +
                           ' °C on your other nights) coincides with ' + parts.join('; and ') });
    } else if (worse || better) {
      out.push({ kind: 'night', effect: false, worse: false,
                 short: bodyShort.join(', ') + ' vs your other nights; the room was close to usual (' + fT1_(f.avgTemp) + ' vs ' + fT1_(f.usual.temp) + ' °C)' +
                        (worse ? ', so not the room' : ''),
                 sentence: 'Compared with your other nights you had ' + parts.join('; and ') + ', but the room was close to usual (' + fT1_(f.avgTemp) +
                           ' versus ' + fT1_(f.usual.temp) + ' °C), so there is no clear link to the room for it' });
    } else if (roomDiff) {
      out.push({ kind: 'night', effect: false, worse: false, short: roomShort + ', your HRV and pulse the same',
                 sentence: 'The room was ' + word + ' than on your other nights (' + fT1_(f.avgTemp) + ' versus ' + fT1_(f.usual.temp) +
                           ' °C), but your HRV and pulse stayed about the same (' + fR0_(f.avgHrv) + ' versus ' + fR0_(f.usual.hrv) + ' ms), so there is no clear link tonight' });
    }
  }
  if (f.warm) out.push(stretchFinding_(f.warm, 'warm',
    { short: 'at ≥' + FUSION_WARM_C + ' °C', long: 'the room was at or above ' + FUSION_WARM_C + ' °C' },
    { short: '', long: 'the rest of the night' }));
  if (f.stuffy) out.push(stretchFinding_(f.stuffy, 'stuffy',
    { short: 'with CO₂ ≥' + CO2_HIGH + ' ppm', long: 'CO₂ was at or above ' + CO2_HIGH + ' ppm' },
    { short: ', fresher air', long: 'when the air was fresher' }));
  if (!out.some(x => x.effect)) {                                    // nothing moved together tonight
    out.push({ kind: 'none', effect: false, worse: false,
               short: fx.neutral ? 'The room stayed in your neutral range: no room effect tonight' : 'No room effect on your HRV or pulse tonight',
               sentence: 'No clear link between the room and your HRV or pulse in the 5-minute data tonight' +
                         (fx.neutral ? '; the room stayed in temperatures where your HRV and pulse have been normal' : '') });
  }
  return out;
}

function fNights_(n) { return n + (n === 1 ? ' night' : ' nights'); }   // "1 night", "7 nights"

function fusionHistoryText_(h) {                                     // how sure we are, in one line
  if (!h) return '';
  if (!h.warmNights) return 'No warm minutes to judge yet in ' + fNights_(h.nights) + ' of ring × room data.';
  return 'Warm minutes went with a worse HRV or pulse on ' + h.warmWorse + ' of ' + fNights_(h.warmNights) + ' that had them (' +
         fNights_(h.nights) + ' of ring × room data). ' + (h.pattern ? 'A pattern worth acting on.' : 'A hint, not a rule yet.');
}

function fusionMapText_(map) {                                       // the map as a small table
  return [pad_('°C', 5) + pad_('HRV', 6) + pad_('pulse', 7) + 'nights']
    .concat(map.rows.map(r => pad_(String(r.c), 5) + pad_(fR0_(r.hrv), 6) + pad_(fR0_(r.hr), 7) + r.nights)).join('\n');
}

// Facts for the model: every number it may use (the number check reads this text)
function fusionFacts_(fx) {
  const f = fx.night, F = [];
  F.push('Ring × room: ' + f.points + ' five-minute points tonight have both ring and bedroom data (' + f.minutes + ' min)');
  F.push('Tonight on those points: room ' + fT1_(f.avgTemp) + ' °C average (' + fT1_(f.minTemp) + '–' + fT1_(f.maxTemp) + ' °C), HRV ' +
         fR0_(f.avgHrv) + ' ms, pulse ' + fR0_(f.avgHr) + ' bpm' + (f.stuffyMin ? ', CO₂ at or above ' + CO2_HIGH + ' ppm for ' + f.stuffyMin + ' min' : ''));
  if (f.usual) F.push('Your other ' + f.usual.nights + ' nights: room ' + fT1_(f.usual.temp) + ' °C, HRV ' + fR0_(f.usual.hrv) + ' ms, pulse ' + fR0_(f.usual.hr) + ' bpm');
  if (f.stages && f.stages.length) F.push('HRV by sleep stage, tonight versus your other nights: ' +
    f.stages.map(s => s.stage + ' ' + fR0_(s.hrv) + ' versus ' + fR0_(s.refHrv) + ' ms').join(', '));
  if (fx.map && fx.map.rows.length) F.push('Your map (all nights, by room temperature): ' +
    fx.map.rows.map(r => r.c + ' °C: HRV ' + fR0_(r.hrv) + ' ms, pulse ' + fR0_(r.hr) + ' bpm (' + fNights_(r.nights) + ')').join('; '));
  F.push('So far: ' + fusionHistoryText_(fx.history));
  return F;
}

// fusionBacktest(): rebuild the history from the last FUSION_BACKTEST_DAYS days and check the numbers against
// an independent calculation (Python on the exported "Oura 5min" and "Sensor Data" tabs, 27–28 Oct 2026).
// Every number in the report must be reproducible: this is the proof.
const FUSION_EXPECTED = {
  '2026-10-16': { points: 99, avgTemp: 23.08, avgHrv: 31.91, avgHr: 69.01, usualHrv: 41.6, usualHr: 60.25, allStagesLower: true },
  '2026-10-17': { points: 78, avgTemp: 20.50, avgHrv: 39.19, avgHr: 62.54 },
  '2026-10-19': { points: 103, avgTemp: 20.44, avgHrv: 45.18, avgHr: 59.26 },
  '2026-10-20': { points: 90, avgTemp: 21.12, avgHrv: 50.26, avgHr: 59.77 },
  '2026-10-22': { points: 109, avgTemp: 21.21, avgHrv: 40.37, avgHr: 58.67, warmMin: 80, warmHrv: 33.2, warmRefHrv: 39.1 },
  '2026-10-23': { points: 71, avgTemp: 21.08, avgHrv: 36.92, avgHr: 59.70 },
  '2026-10-25': { points: 77, avgTemp: 21.54, avgHrv: 37.70, avgHr: 61.56 }
};

function fusionBacktest() {
  const items = (ouraGet_('sleep', dayStr_(-FUSION_BACKTEST_DAYS), dayStr_(1)) || [])
    .filter(n => n.type !== 'deleted' && n.type !== 'rest' && n.bedtime_start && n.bedtime_end);
  if (!items.length) { Logger.log('No Oura nights (is Oura authorized? run authorize())'); return; }
  const byDay = {};
  items.forEach(n => { (byDay[n.day] = byDay[n.day] || []).push(n); });    // Oura pieces per night
  const values = getSensorSheet().getDataRange().getValues();
  const nights = Object.keys(byDay).sort().map(day => {
    const g = byDay[day];
    const night = mergeNight_(g, Math.max(...g.map(n => new Date(n.bedtime_end).getTime())) + 3600000);   // the same merge as the report
    if (!night) return null;
    const ring = ringSeries_(night);
    return { day: day, id: night.id, ring: ring.length, points: fusePoints_(ring, values) };
  }).filter(Boolean);
  const fused = nights.filter(n => n.points.length >= FUSION_MIN_POINTS);  // nights with ring AND bedroom data
  fusionSave_(fused);                                                      // rebuild the history tab for these nights
  Logger.log('Oura nights: ' + nights.length + ', with 5-minute ring data: ' + nights.filter(n => n.ring).length +
             ', fused with bedroom data: ' + fused.length);
  nights.filter(n => n.points.length < FUSION_MIN_POINTS).forEach(n =>
    Logger.log('  ' + n.day + ': ' + n.ring + ' ring points, ' + n.points.length + ' with bedroom data — skipped'));

  const all = [].concat(...fused.map(n => n.points.map(p => Object.assign({ day: n.day }, p))));
  let pass = 0, fail = 0;
  fused.forEach(n => {
    const f = fusionNight_(n.points, all.filter(p => p.day !== n.day));
    const got = { points: f.points, avgTemp: f.avgTemp, avgHrv: f.avgHrv, avgHr: f.avgHr,
                  usualHrv: f.usual ? f.usual.hrv : null, usualHr: f.usual ? f.usual.hr : null, allStagesLower: !!f.allStagesLower,
                  warmMin: f.warm ? f.warm.minutes : null, warmHrv: f.warm ? f.warm.hrv : null, warmRefHrv: f.warm ? f.warm.refHrv : null };
    Logger.log(n.day + ': ' + f.points + ' points · room ' + fT1_(f.avgTemp) + ' °C · HRV ' + fT1_(f.avgHrv) + ' · pulse ' + fT1_(f.avgHr) +
               (f.usual ? ' · other nights HRV ' + fT1_(f.usual.hrv) + ', pulse ' + fT1_(f.usual.hr) : '') +
               (f.allStagesLower ? ' · HRV lower in every stage' : '') +
               (f.warm ? ' · warm ' + f.warm.minutes + ' min: HRV ' + fT1_(f.warm.hrv) + ' vs ' + fT1_(f.warm.refHrv) : '') +
               (f.stuffy ? ' · CO₂≥' + CO2_HIGH + ' ' + f.stuffy.minutes + ' min: HRV ' + fT1_(f.stuffy.hrv) + ' vs ' + fT1_(f.stuffy.refHrv) : ''));
    const e = FUSION_EXPECTED[n.day];
    if (!e) return;                                                        // a newer night: nothing to compare with
    Object.keys(e).forEach(k => {
      const ok = typeof e[k] === 'number' ? got[k] !== null && Math.abs(got[k] - e[k]) <= 0.15 : got[k] === e[k];
      if (ok) pass++; else { fail++; Logger.log('   ❌ ' + k + ': expected ' + e[k] + ', got ' + got[k]); }
    });
  });
  const map = fusionMap_(all);
  Logger.log('Your map:\n' + fusionMapText_(map));
  Logger.log(fusionHistoryText_(fusionHistory_(all)));
  Logger.log(fail ? '❌ Backtest: ' + fail + ' numbers differ from the independent calculation (' + pass + ' match)'
                  : '✅ Backtest: all ' + pass + ' numbers match the independent calculation');
}


// ========== REPORT HISTORY ==========

const REPORT_HEADERS = ['Date', 'AvgTemp', 'MinTemp', 'MaxTemp', 'TempStdDev', 'AvgHumidity', 'AvgBrightness',
  'MaxBrightness', 'PctDark', 'PctWindowOpen', 'RoomScore', 'Efficiency', 'TotalSleepMin', 'DeepSleepMin',
  'RemSleepMin', 'HRV', 'RestingHR', 'AwakeMin', 'Readiness', 'AvgCO2', 'MaxCO2', 'AiStatus', 'AiText',
  // v3: ring × room, from the 5-minute points (added at the end so older rows keep their columns)
  'Fused5min', 'HRV5', 'Pulse5', 'OtherNightsHRV5', 'OtherNightsPulse5', 'WarmMin', 'WarmHRV', 'WarmSameStageHRV',
  'StuffyMin', 'StuffyHRV', 'StuffySameStageHRV'];

function getReportSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REPORT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REPORT_SHEET_NAME);
    sheet.appendRow(REPORT_HEADERS);
    sheet.setFrozenRows(1);
  } else {
    // older tab: append missing headers, keep existing rows
    REPORT_HEADERS.forEach((h, i) => {
      const c = sheet.getRange(1, i + 1);
      if (c.getValue() === '') c.setValue(h);
    });
  }
  return sheet;
}


// ========== TELEGRAM ==========

// Empty text is not sent (Telegram returns 400)
function sendTelegramMessage(text) {
  if (!text || !String(text).trim()) { Logger.log('Telegram: empty text, not sent'); return false; }
  const url = 'https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN', true) + '/sendMessage';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: { chat_id: prop_('TELEGRAM_CHAT_ID', true), text: String(text).slice(0, 4000) },  // Telegram limit 4096
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('Telegram ' + res.getResponseCode() + ': ' + res.getContentText());
    return false;
  }
  return true;
}

function testTelegram() {
  Logger.log(sendTelegramMessage('✅ Test: bot is online') ? 'Sent' : 'Not sent, see the line above');
}


// ========== NEBIUS TOKEN FACTORY / NVIDIA NEMOTRON ==========

const NEBIUS_BASE = 'https://api.tokenfactory.nebius.com/v1';

function nebiusKey_() { return prop_('NEBIUS_API_KEY', true); }

// Models available for this key (NVIDIA listed separately)
function nebiusListModels() {
  const res = UrlFetchApp.fetch(NEBIUS_BASE + '/models', {
    headers: { Authorization: 'Bearer ' + nebiusKey_() },
    muteHttpExceptions: true
  });
  Logger.log('HTTP ' + res.getResponseCode());
  if (res.getResponseCode() !== 200) { Logger.log(res.getContentText()); return; }
  const ids = (JSON.parse(res.getContentText()).data || []).map(m => m.id).sort();
  Logger.log('Models: ' + ids.length);
  Logger.log('NVIDIA / Nemotron:\n' + (ids.filter(id => /nvidia|nemotron/i.test(id)).join('\n') || '(none)'));
  Logger.log('All models:\n' + ids.join('\n'));
}

// One chat request. Returns { text, usage } or null (error is logged)
function nebiusChat_(model, system, user, maxTokens, extra) {
  const body = {
    model: model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens || 500,
    temperature: 0.3
  };
  Object.keys(extra || {}).forEach(k => body[k] = extra[k]);
  const res = UrlFetchApp.fetch(NEBIUS_BASE + '/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + nebiusKey_() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('Nebius ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
    return null;
  }
  const json = JSON.parse(res.getContentText());
  const msg = json.choices && json.choices[0] && json.choices[0].message;
  return { text: msg ? (msg.content || '') : '', usage: json.usage };
}

// Without this Nemotron reasons out loud and spends the token budget on it
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };

function testNemotron() {
  const model = prop_('NEBIUS_MODEL', true);
  const t0 = Date.now();
  const r = nebiusChat_(model,
    'You are a sleep-quality assistant. Answer briefly.',
    'Overnight, bedroom CO₂ rose from 560 to 1450 ppm with the window closed. In two sentences, explain why sleep may have been worse.',
    400, NO_THINKING);
  if (!r) return;
  Logger.log('Model: ' + model + ' | ' + (Date.now() - t0) + ' ms | tokens: ' + (r.usage ? r.usage.total_tokens : '?'));
  Logger.log(r.text);
}


// All numbers in a text, normalised ("25.0" → "25"); the 2 in CO2 is not a number
function nemNumbers_(s) {
  const clean = String(s).replace(/CO\s?2/gi, 'CO₂');
  return (clean.match(/\d+(?:[.,]\d+)?/g) || []).map(x => String(parseFloat(x.replace(',', '.'))));
}


// ========== TRIGGER ==========

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const f = t.getHandlerFunction();
    if (f === 'sendDailyReport' || f === 'morningCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('morningCheck').timeBased().everyMinutes(30).create();
  Logger.log('Done: check every 30 min, one report per day');
}


// ========== MORNING DASHBOARD (Telegram) ==========
// Message 1: dashboard text. Message 2: night chart (CO₂, temperature, window, Oura sleep stages).
// Code computes every number and verdict. Nemotron writes headline, subline, tip and "why";
// any field that fails a check is replaced by the code's own text.

const CHART_BIN_MIN = 5;   // chart step, minutes (Oura stages are 5 min too)

// Personal baseline: mean of up to 14 previous main nights, excluding this one
function ouraBaseline_(excludeId) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OURA_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return null;
  let rows = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues()
    .filter(r => r[2] === 'long_sleep' && r[0] !== excludeId);
  rows.sort((a, b) => new Date(b[4]) - new Date(a[4]));
  rows = rows.slice(0, 14);
  if (rows.length < 3) return null;                         // fewer than 3 nights: no baseline yet
  const mean = idx => {
    const v = rows.map(r => toNum(r[idx])).filter(n => n !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const h2m = x => x === null ? null : x * 60;
  return { n: rows.length, totalMin: h2m(mean(5)), deepMin: h2m(mean(6)), remMin: h2m(mean(7)),
           awakeMin: mean(9), eff: mean(10), latency: mean(11), hrv: mean(12), lowestHr: mean(13), breath: mean(14) };
}

// Oura sleep score for this morning
function getOuraDailySleep() {
  const items = ouraGet_('daily_sleep', dayStr_(-1), dayStr_(1));
  if (!items || !items.length) return null;
  const today = dayStr_(0);
  return items.filter(d => d.day === today)[0] || null;
}

// Sleep metrics vs baseline. dir: 1 = higher is better, -1 = lower is better, 0 = neutral
function metricRows_(sleep, base) {
  const num = v => (v === null || v === undefined) ? null : Number(v);
  const specs = [
    { short: 'HRV',    label: 'HRV',               unit: 'ms',  val: num(sleep.average_hrv),                 b: base && base.hrv,      tolPct: 0.1, dir: 1,  dec: 0 },
    { short: 'Low HR', label: 'Lowest heart rate', unit: 'bpm', val: num(sleep.lowest_heart_rate),           b: base && base.lowestHr, tol: 2,      dir: -1, dec: 0 },
    { short: 'Deep',   label: 'Deep sleep',        unit: 'min', val: minFromSec_(sleep.deep_sleep_duration),  b: base && base.deepMin,  tol: 10,     dir: 1,  dec: 0, dur: true },
    { short: 'REM',    label: 'REM sleep',         unit: 'min', val: minFromSec_(sleep.rem_sleep_duration),   b: base && base.remMin,   tol: 10,     dir: 1,  dec: 0, dur: true },
    { short: 'Sleep',  label: 'Total sleep',       unit: 'min', val: minFromSec_(sleep.total_sleep_duration), b: base && base.totalMin, tol: 30,     dir: 1,  dec: 0, dur: true },
    { short: 'Breath', label: 'Breathing rate',    unit: '',    val: num(sleep.average_breath),               b: base && base.breath,   tol: 0.5,    dir: 0,  dec: 1 },
    { short: 'Effic.', label: 'Sleep efficiency',  unit: '%',   val: num(sleep.efficiency),                   b: base && base.eff,      tol: 2,      dir: 1,  dec: 0 },
    { short: 'Awake',  label: 'Awake time',        unit: 'min', val: minFromSec_(sleep.awake_time),           b: base && base.awakeMin, tol: 10,     dir: -1, dec: 0, dur: true }
  ];
  const out = [];
  specs.forEach(s => {
    if (s.val === null || isNaN(s.val)) return;
    const r = { short: s.short, label: s.label, val: s.val, unit: s.unit, dur: !!s.dur, dec: s.dec, base: null, d: null, verdict: null };
    if (s.b !== null && s.b !== undefined) {
      r.base = s.b;
      r.d = s.val - s.b;
      const tol = s.tolPct ? s.b * s.tolPct : s.tol;
      if (Math.abs(r.d) <= tol) r.verdict = 'usual';
      else if (s.dir === 0) r.verdict = r.d > 0 ? 'higher' : 'lower';
      else r.verdict = (r.d * s.dir > 0) ? 'better' : 'worse';
    }
    out.push(r);
  });
  return out;
}

// Compact formats for Telegram tables
function hmShort_(min) { min = Math.round(min); return Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0'); }
function valShort_(r) {
  if (r.dur) return r.val < 60 ? Math.round(r.val) + 'm' : hmShort_(r.val);
  const v = Number(r.val).toFixed(r.dec);
  return r.unit === '%' ? v + '%' : (r.unit ? v + ' ' + r.unit : v);
}
function deltaShort_(r) {
  if (r.d === null) return '—';
  if (r.dur) {
    const a = Math.round(Math.abs(r.d));
    if (a === 0) return '±0';
    const s = r.d > 0 ? '+' : '−';
    return a >= 60 ? s + Math.floor(a / 60) + 'h' + String(a % 60).padStart(2, '0') : s + a + 'm';
  }
  const a = Math.abs(r.d).toFixed(r.dec);
  return Number(a) === 0 ? '±0' : (r.d > 0 ? '+' : '−') + a;
}
function dot_(verdict) { return verdict === 'better' ? '🟢' : verdict === 'worse' ? '🟠' : verdict ? '⚪' : ''; }
function pad_(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL_(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function bar_(score, emptyText) {
  if (score === null || score === undefined) return emptyText || '— no data';
  const n = Math.max(0, Math.min(10, Math.round(score / 10)));
  return padL_(score, 3) + '  ' + '▰'.repeat(n) + '▱'.repeat(10 - n);
}
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Main room suspect and the sleep metrics that point the same way
function mainSuspect_(room, rows) {
  if (!room) return null;
  const by = {};
  rows.forEach(r => by[r.short] = r);
  const worseOf = keys => keys.filter(k => by[k] && (by[k].verdict === 'worse' || (k === 'Breath' && by[k].verdict === 'higher')))
                              .map(k => k + ' ' + deltaShort_(by[k]) + (by[k].dur ? '' : (by[k].unit && by[k].unit !== '%' ? ' ' + by[k].unit : '')));
  if (room.avgTemp > SLEEP_TEMP_MAX) {
    return { key: 'heat', icon: '🔥', title: 'Main suspect: heat',
             line: room.avgTemp.toFixed(1) + ' °C average · your zone ' + SLEEP_TEMP_MIN + '–' + SLEEP_TEMP_MAX + ' °C',
             effects: worseOf(['REM', 'Deep', 'Low HR', 'HRV']) };
  }
  if (room.pctCO2High !== null && room.pctCO2High >= 30) {
    return { key: 'stuffy', icon: '🫁', title: 'Main suspect: stuffy air',
             line: 'CO₂ peaked at ' + room.maxCO2.toFixed(0) + ' ppm · above ' + CO2_HIGH + ' for ' + room.pctCO2High.toFixed(0) + '% of the night',
             effects: worseOf(['Awake', 'Effic.', 'Breath']) };
  }
  if (room.avgTemp < SLEEP_TEMP_MIN) {
    return { key: 'cold', icon: '🧊', title: 'Main suspect: cold',
             line: room.avgTemp.toFixed(1) + ' °C average · your zone ' + SLEEP_TEMP_MIN + '–' + SLEEP_TEMP_MAX + ' °C',
             effects: worseOf(['Awake', 'Deep', 'Effic.']) };
  }
  return { key: 'none', icon: '✨', title: 'No room red flags', line: 'Temperature, air and darkness were in range', effects: [] };
}

// Code's fallback texts (no model, or a field was rejected)
// The action(s) behind the code's tip: what the model's tip must also say
function tipActions_(room, suspect) {
  const a = [];
  if (suspect && suspect.key === 'heat') a.push('cool');
  if (suspect && suspect.key === 'cold') a.push('warm');
  if (room && room.pctCO2High !== null && room.pctCO2High >= 30) a.push('air');
  if (!a.length) a.push('routine');
  return a;
}
function noLink_(relations) {
  return relations.some(r => /no clear link|no personal baseline|too little to link/i.test(r)) &&
         !relations.some(r => /coincides? with/i.test(r));          // v3: "the 80 minutes … coincide with" is a link too
}

function fallbackTexts_(room, sleep, rows, suspect, fusionWorse) {
  // v3: fusionWorse = how many of HRV and pulse were worse than on your other nights in the 5-minute data
  const worse = Math.max(rows.filter(r => r.verdict === 'worse').length, fusionWorse || 0);
  const tot = sleep ? minFromSec_(sleep.total_sleep_duration) : null;
  const low = tot !== null && tot < LOW_SLEEP_MIN;
  const roomWord = !suspect ? 'No room data' : ({ heat: 'Hot room', stuffy: 'Stuffy room', cold: 'Cold room', none: 'Good room' })[suspect.key];
  const nightWord = !sleep ? 'no ring data' : low ? 'broken night' : (tot !== null && tot < SLEEP_SHORT_MIN) ? 'short night'
    : worse >= 2 ? 'restless night' : worse === 1 ? 'okay night' : 'solid night';
  const issue = suspect && suspect.key !== 'none';
  const subline = !sleep ? 'Open the Oura app to sync your ring.'
    : low ? 'Too little sleep to judge the room tonight.'
    : !suspect ? 'No bedroom data to compare tonight.'
    : issue && worse <= 1 ? 'Your body coped — the room didn\'t.'
    : issue ? 'Your body felt it.'
    : worse >= 2 ? 'The room wasn\'t the problem tonight.' : 'Room and body in sync.';
  const tips = [];
  if (suspect && suspect.key === 'heat') tips.push('radiator down before bed');
  if (suspect && suspect.key === 'cold') tips.push('warm the room a little before bed');
  if (room && room.pctCO2High !== null && room.pctCO2High >= 30) tips.push('air the room before sleep');
  if (!tips.length) tips.push('keep the same routine');
  return { headline: roomWord + ', ' + nightWord + '.', subline: subline, tip: tips.join(', ') + '.' };
}

// Nemotron writes headline / subline / why / tip as JSON; each field is checked on its own.
// guard (from code): { bodyWorse, bodyJudged, lowSleep, room } — used to catch text that contradicts the verdicts.
// out also carries raw, rawFirst, attempts, problems and ms for the evals.
const BODY_FINE_WORDS = /\b(coped|cope|held up|holds up|fine|great|solid|in sync|unaffected|unbothered|well rested|rested|restful|recovered|good night)\b/i;
const BODY_BAD_WORDS  = /\b(struggled|suffered|restless|rough|poor|bad night|terrible|exhausted|wrecked|broken)\b/i;
const CAUSE_WORDS     = /\b(because|caused|causes|due to|led to|leads to|made you|kept you)\b/i;

// Room direction in headline/subline ("humidity low" at 69 %, "chilly" at 23 °C).
// "why" is not checked: it may contain negations ("not too warm").
const ROOM_WRONG = {
  hum:  { high: /\b(low humidity|humidity (?:was |is |stayed )?low|dry air|too dry|air was dry)\b/i,
          low:  /\b(high humidity|humidity (?:was |is |stayed )?high|humid|damp|muggy)\b/i },
  temp: { hot:  /\b(cold|chilly|freezing|too cool|cool room)\b/i,
          cold: /\b(hot|too warm|warm room|overheated|heatwave)\b/i },
  co2:  { high: /\b(fresh air|air was fresh|clean air|low co2|low co₂)\b/i,
          ok:   /\b(stuffy|stale air|airless)\b/i }
};
// Temperature in range: "cool" or "warm" can be true (18 °C is cool); only strong words are wrong
const TEMP_OK_WRONG = /\b(cold|chilly|freezing|too cool|hot|too warm|overheated|heatwave)\b/i;
function roomWrong_(t, guard, whyOnly) {
  const out = [];
  if (!t || !guard || !guard.room) return out;
  const r = guard.room;
  if (r.light === 'dark' && /\b(bright|lit up|well lit)\b/i.test(t)) out.push('room_contradiction: "bright", but the room was dark');
  const say = { hum: { high: 'humidity was high', low: 'humidity was low' }, temp: { hot: 'the room was warm', cold: 'the room was cold' },
                co2: { high: 'CO₂ was high', ok: 'CO₂ stayed low' } };
  (whyOnly ? ['hum', 'co2'] : ['hum', 'temp', 'co2']).forEach(k => {
    const st = r[k];
    if (st && ROOM_WRONG[k][st] && ROOM_WRONG[k][st].test(t)) out.push('room_contradiction: "' + (t.match(ROOM_WRONG[k][st]) || [''])[0] + '", but ' + say[k][st]);
    if (st === 'ok' && k === 'hum') ['high', 'low'].forEach(x => {
      if (ROOM_WRONG.hum[x].test(t)) out.push('room_contradiction: "' + t.match(ROOM_WRONG.hum[x])[0] + '", but humidity was in range');
    });
    if (st === 'ok' && k === 'temp' && !whyOnly && TEMP_OK_WRONG.test(t)) out.push('room_contradiction: "' + t.match(TEMP_OK_WRONG)[0] + '", but temperature was in range');
  });
  return out;
}

// Tip must carry the action the code chose (guard.actions) and nothing that works against it
const TIP_ACTION = {
  cool:    /\b(radiator|heating|thermostat|cool|cooler|fan|window|temperature)\b/i,
  warm:    /\b(warm|warmer|heat|heating|radiator|thermostat|blanket|layer)\b/i,
  air:     /\b(air|window|ventilat\w*|fresh)\b/i,
  routine: /\b(same|routine|keep|usual|continue|as is)\b/i
};
const TIP_AGAINST = {
  warm:    /\b(open\w*[\w\s]{0,15}window|window[\w\s]{0,10}open|cool\w*|fan)\b/i,
  routine: /\b(window|air|radiator|heating|fan|dim|dark\w*|light\w*|blackout|thermostat)\b/i
};
function tipMismatch_(t, guard) {
  if (!t || !guard || !guard.actions || !guard.actions.length) return [];
  const out = [];
  guard.actions.forEach(a => { if (!TIP_ACTION[a].test(t)) out.push('tip_mismatch: tip misses the action "' + a + '"'); });
  guard.actions.forEach(a => { if (TIP_AGAINST[a] && TIP_AGAINST[a].test(t)) out.push('tip_mismatch: "' + t.match(TIP_AGAINST[a])[0] + '" works against "' + a + '"'); });
  return out;
}

// When the code found no link (no baseline, too little sleep, nothing in range), "why" must say so
const NO_LINK_SAID = /\b(no clear link|no link|not linked|cannot|can't|too (?:short|little)|no (?:personal )?baseline|not enough|unclear|hard to say|wasn't the (?:problem|cause)|was not the (?:problem|cause)|not the (?:problem|cause)|no sign)\b/i;
const LINK_CLAIM = /\b(may explain|explains|linked to|led to|leading to|because of|kept you|stole|robbed|broke)\b/i;

// Tip: "open the window" when it was already open all night
function tipWrong_(t, guard) {
  if (!t || !guard || !guard.room || guard.room.win !== 'open') return [];
  return /\bopen\b[\w\s]{0,20}\bwindow\b|\bwindow\b[\w\s]{0,10}\bopen\b/i.test(t) ? ['tip_contradiction: tip says open the window, but it was open all night'] : [];
}

function textProblems_(f, guard) {
  // f = { headline, subline, why, tip } as strings or null; returns meaning-level problems
  const p = [];
  if (!guard) return p;
  const short = [f.headline, f.subline].filter(Boolean).join(' ');
  if (guard.bodyWorse >= 2 && BODY_FINE_WORDS.test(short)) p.push('body_contradiction: says the body was fine, but ' + guard.bodyWorse + ' sleep metrics were worse than usual');
  if (guard.bodyJudged > 0 && guard.bodyWorse === 0 && BODY_BAD_WORDS.test(short)) p.push('body_contradiction: says the night was bad, but no sleep metric was worse than usual');
  if (guard.lowSleep && f.why && CAUSE_WORDS.test(f.why)) p.push('cause_on_low_sleep: too little sleep was recorded to name a cause');
  if (f.why && /\b(caused|causes|due to)\b/i.test(f.why)) p.push('overclaim: one night is a hint, not proof');
  if (guard.noLink && f.why && (!NO_LINK_SAID.test(f.why) || LINK_CLAIM.test(f.why))) p.push('missed_no_link: the code found no room-body link tonight');
  roomWrong_(f.headline, guard).concat(roomWrong_(f.subline, guard), roomWrong_(f.why, guard, true),
    tipWrong_(f.tip, guard), tipMismatch_(f.tip, guard)).forEach(x => p.push(x));
  return [...new Set(p)];
}

function dashTexts_(dataText, fb, relations, guard) {
  const out = { headline: fb.headline, subline: fb.subline, tip: fb.tip, why: relations.slice(0, 2).join('. ') + '.', status: 'fallback',
                raw: null, attempts: 0, problems: [], ms: 0 };
  const model = prop_('NEBIUS_MODEL', false);
  if (!model) { out.status = 'no_model'; return out; }

  const allowed = new Set(nemNumbers_(dataText));
  // describe the form, not ready-made phrases: the model copied an example phrase verbatim
  // v2: the code writes a correct DRAFT (meaning, links and the tip's action); Nemotron rewrites it for a person.
  // v1 let the model choose the tip and the links; evals showed it defaulted to "open the window" and ignored "no link".
  const system =
    'You rewrite the text of a morning sleep dashboard shown in a Telegram message. Reply with JSON only, no other text: ' +
    '{"headline": "...", "subline": "...", "why": "...", "tip": "..."}. ' +
    'The DRAFT was written from the data and is correct. Make it warmer, clearer and more specific for one person reading on a phone. ' +
    'Keep the meaning of every field. Do not add causes, links, advice or room properties that are not in the DRAFT or the VERDICTS. ' +
    'headline: at most 6 words, no digits. subline: at most 10 words, no digits, agrees with the BODY verdict. ' +
    'why: 2 or 3 short sentences addressed to "you"; you may add numbers from the INPUT, written exactly as there, to make the draft concrete; ' +
    'if the draft says there is no clear link, no baseline yet, or too little sleep, say that plainly; use "may" or "is consistent with", never "caused" or "due to". ' +
    'tip: at most 12 words, no digits, the same action as the draft tip, said more concretely. ' +
    // v3: the ring × room comparison is the point of the report
    'If the INPUT has ring × room data, "why" is about it: what the room did and what the body did in the same minutes. ' +
    'Never use the words code, block, facts, verdicts, draft.';
  let user = dataText + '\n\nDRAFT\nheadline: ' + fb.headline + '\nsubline: ' + fb.subline + '\nwhy: ' + out.why + '\ntip: ' + fb.tip +
             '\n\nWrite the JSON now.';
  const t0 = Date.now();

  for (let attempt = 1; attempt <= 2; attempt++) {
    out.attempts = attempt;
    const r = nebiusChat_(model, system, user, 500, NO_THINKING);
    if (!r || !r.text) { out.status = 'api_error'; out.ms = Date.now() - t0; return out; }
    let j = null;
    try { j = JSON.parse((r.text.match(/\{[\s\S]*\}/) || [''])[0]); } catch (e) { j = null; }
    out.raw = j || { _text: r.text.slice(0, 600) };
    if (attempt === 1) out.rawFirst = out.raw;                     // model answer before any check (evals)
    if (!j) { user += '\n\nReply with valid JSON only.'; out.status = 'bad_json'; out.problems = ['bad_json'];
              if (attempt === 1) out.problemsFirst = ['bad_json']; continue; }

    const problems = [];
    const clean = (v, maxLen, noDigits) => {
      if (typeof v !== 'string') return null;
      const t = v.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!t || t.length > maxLen || /[\u0400-\u04FF]/.test(t) || /\b(code|block|facts?|verdicts?|draft)\b/i.test(t)) return null;
      if (noDigits && /\d/.test(t)) return null;
      return t;
    };
    let h = clean(j.headline, 48, true), s = clean(j.subline, 70, true), tp = clean(j.tip, 90, true);
    let w = clean(j.why, 480, false);
    if (w) {
      const bad = nemNumbers_(w).filter(n => !allowed.has(n));
      if (bad.length) { problems.push('numbers not in the input: ' + bad.join(', ')); w = null; }
    }
    // meaning: no contradiction with the body or the room, no causes when data is thin
    const sem = textProblems_({ headline: h, subline: s, why: w, tip: tp }, guard);
    sem.forEach(x => {
      problems.push(x);
      if (x.indexOf('body_contradiction') === 0) {
        const wrong = guard.bodyWorse >= 2 ? BODY_FINE_WORDS : BODY_BAD_WORDS;
        if (h && wrong.test(h)) h = null;
        if (s && wrong.test(s)) s = null;
      } else if (x.indexOf('tip_contradiction') === 0 || x.indexOf('tip_mismatch') === 0) {
        tp = null;
      } else if (x.indexOf('room_contradiction') === 0) {
        if (h && roomWrong_(h, guard).length) h = null;
        if (s && roomWrong_(s, guard).length) s = null;
        if (w && roomWrong_(w, guard, true).length) w = null;
      } else w = null;
    });
    if (!h) problems.push('headline');
    if (!s) problems.push('subline');
    if (!tp) problems.push('tip');
    if (!w && !problems.some(p => /^(numbers|cause|overclaim|missed_no_link|room_contradiction)/.test(p))) problems.push('why');
    out.problems = problems;
    if (attempt === 1) out.problemsFirst = problems.slice();

    if (!problems.length || attempt === 2) {
      if (h) out.headline = h;
      if (s) out.subline = s;
      if (tp) out.tip = tp;
      if (w) out.why = w;
      const used = [h, s, tp, w].filter(Boolean).length;
      out.status = used === 4 ? 'ok' : used ? 'partial' : 'rejected';
      if (problems.length) Logger.log('Nemotron dashboard: replaced by fallback → ' + problems.join('; '));
      out.ms = Date.now() - t0;
      return out;
    }
    Logger.log('Nemotron dashboard: retry (' + problems.join('; ') + ')');
    user += '\n\nFix these fields and reply with the full JSON again: ' + problems.join('; ') +
            '. No digits in headline, subline and tip. In why use only numbers from the input.';
  }
  out.ms = Date.now() - t0;
  return out;
}

// Night window: Oura bedtime − 30 min … wake-up + 10 min; without Oura 23:00–07:00
function nightWindow_(sleep) {
  if (sleep && sleep.bedtime_start && sleep.bedtime_end) {
    const step = CHART_BIN_MIN * 60000;
    const bs = new Date(sleep.bedtime_start), be = new Date(sleep.bedtime_end);
    return { start: new Date(Math.floor((bs.getTime() - 30 * 60000) / step) * step), end: new Date(be.getTime() + 10 * 60000),
             sleepStart: bs, sleepEnd: be };
  }
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), NIGHT_END_HOUR, 0, 0);
  const start = new Date(end.getTime() - ((24 - NIGHT_START_HOUR) + NIGHT_END_HOUR) * 3600000);
  return { start: start, end: end, sleepStart: start, sleepEnd: end };
}

// Chart series: 5-minute bins of temperature and CO₂, window open, Oura sleep stages
function nightSeries_(win, sleep, fusedPts) {
  const values = getSensorSheet().getDataRange().getValues();
  const step = CHART_BIN_MIN * 60000;
  const n = Math.max(1, Math.ceil((win.end - win.start) / step));
  // v3: HRV from the ring in the same 5-minute bins, so body and room share one time axis
  const hrv = new Array(n).fill(null);
  (fusedPts || []).forEach(p => {
    const i = Math.floor((p.t - win.start.getTime()) / step);        // which bin this ring point falls into
    if (i >= 0 && i < n) hrv[i] = p.hrv;                             // one ring point per 5 minutes
  });
  const tS = new Array(n).fill(0), tC = new Array(n).fill(0), cS = new Array(n).fill(0), cC = new Array(n).fill(0);
  const ev = [];
  let state = null;
  values.forEach(row => {
    const t = new Date(row[COL.date]);
    if (isNaN(t.getTime())) return;
    const s = rowWindowState_(row);
    if (t < win.start) { if (s) state = s; return; }
    if (t > win.end) return;
    const i = Math.min(n - 1, Math.floor((t - win.start) / step));
    const tv = toNum(row[COL.temp]), cv = toNum(row[COL.co2]);
    if (tv !== null) { tS[i] += tv; tC[i]++; }
    if (cv !== null && cv > 0) { cS[i] += cv; cC[i]++; }
    if (s) ev.push({ i: i, s: s });
  });
  const tz = Session.getScriptTimeZone();
  const labels = [], temp = [], co2 = [], open = [], stage = [];
  let cur = state, k = 0;
  // sleep stages: a merged night has one phase string per piece
  const segs = (sleep && sleep.segments && sleep.segments.length ? sleep.segments
               : sleep && sleep.sleep_phase_5_min && sleep.bedtime_start ? [{ start: sleep.bedtime_start, phases: sleep.sleep_phase_5_min }] : [])
    .filter(g => g.start && g.phases).map(g => ({ t0: new Date(g.start).getTime(), ph: String(g.phases) }));
  for (let i = 0; i < n; i++) {
    const bt = win.start.getTime() + i * step;
    labels.push(Utilities.formatDate(new Date(bt), tz, 'HH:mm'));
    temp.push(tC[i] ? Math.round(tS[i] / tC[i] * 10) / 10 : null);
    co2.push(cC[i] ? Math.round(cS[i] / cC[i]) : null);
    let anyOpen = cur === 'open';
    while (k < ev.length && ev[k].i === i) { cur = ev[k].s; if (cur === 'open') anyOpen = true; k++; }
    open.push(anyOpen ? 1 : null);
    let st = null;
    for (let g = 0; g < segs.length && st === null; g++) {
      const idx = Math.floor((bt - segs[g].t0) / 300000);
      if (idx >= 0 && idx < segs[g].ph.length) {
        const c = segs[g].ph.charAt(idx);
        st = c === '1' ? 1 : c === '2' ? 2 : c === '3' ? 3 : c === '4' ? 4 : null;   // Oura: 1 deep, 2 light, 3 REM, 4 awake
      }
    }
    stage.push(st);
  }
  return { labels: labels, temp: temp, co2: co2, open: open, stage: stage, hrv: hrv,
           hasRoom: tC.some(x => x > 0) || cC.some(x => x > 0), hasStages: stage.some(x => x !== null),
           hasHrv: hrv.some(x => x !== null) };
}

// Chart.js (v4) config as a string: QuickChart accepts functions inside it
function nightChartConfig_(s, title) {
  const J = x => JSON.stringify(x);
  const thr = s.labels.map(() => CO2_HIGH);
  return "{type:'line',data:{labels:" + J(s.labels) + ",datasets:[" +
    "{label:'CO₂ (ppm)',data:" + J(s.co2) + ",yAxisID:'co2',borderColor:'#6EA8FE',backgroundColor:'rgba(110,168,254,0.18)',fill:'start',pointRadius:0,borderWidth:2.5,tension:0.35,spanGaps:true}," +
    "{label:'" + CO2_HIGH + " ppm',data:" + J(thr) + ",yAxisID:'co2',borderColor:'rgba(237,239,245,0.45)',borderDash:[6,5],pointRadius:0,borderWidth:1.2,fill:false}," +
    "{label:'Temperature (°C)',data:" + J(s.temp) + ",yAxisID:'temp',borderColor:'#F2A65A',backgroundColor:'rgba(242,166,90,0.12)',fill:'start',pointRadius:0,borderWidth:2.5,tension:0.35,spanGaps:true}," +
    "{label:'Window open',type:'bar',data:" + J(s.open) + ",yAxisID:'win',backgroundColor:'#7DD3C0',barPercentage:1,categoryPercentage:1}," +
    "{label:'Sleep stage',data:" + J(s.stage) + ",yAxisID:'stage',borderColor:'#B69CFF',backgroundColor:'rgba(182,156,255,0.22)',stepped:true,fill:'start',pointRadius:0,borderWidth:2,spanGaps:false}" +
    // v3: your HRV from the ring on the same time axis, and the warm-stretch line on the temperature axis
    (s.hasHrv ? ",{label:'Your HRV (ms)',data:" + J(s.hrv) + ",yAxisID:'hrv',borderColor:'#FF7AA8',backgroundColor:'rgba(255,122,168,0.14)',fill:'start',pointRadius:0,borderWidth:2.5,tension:0.35,spanGaps:true}" +
                ",{label:'" + FUSION_WARM_C + " °C',data:" + J(s.labels.map(() => FUSION_WARM_C)) + ",yAxisID:'temp',borderColor:'rgba(242,166,90,0.55)',borderDash:[6,5],pointRadius:0,borderWidth:1.2,fill:false}" : '') +
    "]},options:{layout:{padding:{left:8,right:16,top:4,bottom:4}}," +
    "plugins:{title:{display:true,text:" + J(title) + ",color:'#EDEFF5',font:{size:20,weight:'bold'},padding:{bottom:10}}," +
    "legend:{position:'bottom',labels:{color:'#C9CFDD',boxWidth:14,font:{size:13}}}}," +
    "scales:{x:{ticks:{color:'#9AA3B8',maxTicksLimit:9,maxRotation:0,font:{size:12}},grid:{color:'rgba(255,255,255,0.06)'}}," +
    // axes bottom to top: sleep stages, temperature, window strip, CO₂
    "stage:{type:'linear',position:'left',stack:'night',stackWeight:2.2,offset:true,min:0,max:4.6,title:{display:true,text:'Sleep',color:'#B69CFF',font:{size:13}}," +
    "ticks:{color:'#B69CFF',stepSize:1,font:{size:12},callback:function(v){return {1:'Deep',2:'Light',3:'REM',4:'Awake'}[v]||'';}},grid:{color:'rgba(255,255,255,0.06)'}}," +
    (s.hasHrv ? "hrv:{type:'linear',position:'left',stack:'night',stackWeight:2.2,offset:true,grace:'15%',title:{display:true,text:'HRV ms',color:'#FF7AA8',font:{size:13}},ticks:{color:'#FF7AA8',maxTicksLimit:4},grid:{color:'rgba(255,255,255,0.06)'}}," : '') +
    "temp:{type:'linear',position:'left',stack:'night',stackWeight:2,offset:true,grace:'15%',title:{display:true,text:'°C',color:'#F2A65A',font:{size:13}},ticks:{color:'#F2A65A',maxTicksLimit:4},grid:{color:'rgba(255,255,255,0.06)'}}," +
    "win:{type:'linear',position:'left',stack:'night',stackWeight:0.45,offset:true,min:0,max:1,title:{display:true,text:'Window',color:'#7DD3C0',font:{size:12}},ticks:{display:false},grid:{display:false}}," +
    "co2:{type:'linear',position:'left',stack:'night',stackWeight:3,offset:true,min:400,suggestedMax:1600,title:{display:true,text:'CO₂ ppm',color:'#6EA8FE',font:{size:13}},ticks:{color:'#6EA8FE',stepSize:500,callback:function(v){return v%500===0?v:'';}},grid:{color:'rgba(255,255,255,0.06)'}}}}}";
}

// Chart image via QuickChart (renders Chart.js server-side, returns PNG)
function renderNightChart_(series, title) {
  const res = UrlFetchApp.fetch('https://quickchart.io/chart', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ version: '4', backgroundColor: '#0E1220', width: 1000, height: series.hasHrv ? 980 : 820, devicePixelRatio: 2, format: 'png',
                              chart: nightChartConfig_(series, title) }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) { Logger.log('QuickChart ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300)); return null; }
  return res.getBlob().setName('night.png');
}

// Telegram: HTML message (falls back to plain text if markup fails) and photo
function sendTelegramHtml_(html) {
  const url = 'https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN', true) + '/sendMessage';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: { chat_id: prop_('TELEGRAM_CHAT_ID', true), text: html, parse_mode: 'HTML' },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() === 200) return true;
  Logger.log('Telegram HTML ' + res.getResponseCode() + ': ' + res.getContentText());
  return sendTelegramMessage(html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

function sendTelegramPhoto_(blob, caption) {
  const url = 'https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN', true) + '/sendPhoto';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: { chat_id: prop_('TELEGRAM_CHAT_ID', true), photo: blob, caption: caption || '', parse_mode: 'HTML' },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) { Logger.log('Telegram photo ' + res.getResponseCode() + ': ' + res.getContentText()); return false; }
  return true;
}

// Everything the code prepares before the model: rows vs baseline, suspect, facts and verdicts, fallback texts.
// base: undefined → baseline from "Oura Sleep"; null → no baseline; object → given (evals)
function dashInputs_(ctx, base) {
  const sleep = ctx.sleep, readiness = ctx.readiness, daily = ctx.daily, room = ctx.room;
  if (base === undefined) base = sleep ? ouraBaseline_(sleep.id) : null;
  const rows = sleep ? metricRows_(sleep, base) : [];
  let suspect = mainSuspect_(room, rows);
  const totMin = sleep ? minFromSec_(sleep.total_sleep_duration) : null;
  const lowSleep = totMin !== null && totMin < LOW_SLEEP_MIN;
  // v3: ring × room for this night (null in the evals and when the night could not be fused)
  const fx = ctx.fusion && ctx.fusion.night ? ctx.fusion : null;
  const findings = fx && !lowSleep ? fusionFindings_(fx) : null;     // what moved together, in code's words
  // v3: above the general 16–20 °C guideline, but in temperatures where YOUR HRV and pulse have been normal,
  // and nothing in the 5-minute data went the bad way → the room is not a suspect for you
  if (findings && fx.neutral && suspect && suspect.key === 'heat' && room && room.avgTemp < FUSION_WARM_C &&
      !findings.some(x => x.worse)) {
    // the next suspect in line, with heat taken out (stuffy air still counts by the general guideline)
    suspect = mainSuspect_(Object.assign({}, room, { avgTemp: SLEEP_TEMP_MAX }), rows);
    if (suspect.key === 'none') {
      suspect = { key: 'none', icon: '✨', title: 'No room red flags for you',
                  line: room.avgTemp.toFixed(1) + ' °C is above the general ' + SLEEP_TEMP_MIN + '–' + SLEEP_TEMP_MAX +
                        ' °C guideline, but your HRV and pulse have been normal at these temperatures', effects: [] };
    }
  }
  const bodyKeys = ['HRV', 'Low HR', 'Deep', 'REM', 'Sleep', 'Effic.', 'Awake'];
  const bodyRows = rows.filter(r => bodyKeys.indexOf(r.short) >= 0 && r.verdict);
  // v3: tonight's HRV and pulse vs your other nights (5-minute data) also count for the body verdict
  const fN = fx && fx.night && fx.night.usual ? fx.night : null;
  const fusionWorse = fN ? (fN.hrvVsUsual === 'lower' ? 1 : 0) + (fN.hrVsUsual === 'higher' ? 1 : 0) : 0;
  const bodyWorse = Math.max(bodyRows.filter(r => r.verdict === 'worse').length, fusionWorse);
  const bodyJudged = Math.max(bodyRows.length, fN ? 2 : 0);
  // too little sleep: no room → body links
  if (lowSleep && suspect) suspect.effects = [];

  // model input: verdicts and links computed by code
  const relRows = rows.map(r => ({ label: r.label, verdict: r.verdict === 'better' ? 'better than usual' : r.verdict === 'worse' ? 'worse than usual' :
                                   r.verdict === 'higher' ? 'higher than usual' : r.verdict === 'lower' ? 'lower than usual' : r.verdict ? 'in line with usual' : null }));
  // v3: with 5-minute ring × room data, the links come from it (measured minute by minute);
  // without it (no ring series, no bedroom rows, the evals) the nightly-average links of v2 are used
  const relations = lowSleep
    ? ['Only ' + valShort_({ dur: true, val: totMin }) + ' of sleep was recorded, which is too little to link the room to your body tonight']
    : findings ? findings.map(x => x.sentence)
    : enRelations_(room, relRows, readiness);
  const facts = [];
  if (fx) fusionFacts_(fx).forEach(x => facts.push(x));             // v3: ring × room facts come first
  if (daily && daily.score != null) facts.push('Oura sleep score: ' + daily.score);
  if (readiness && readiness.score != null) facts.push('Oura readiness score: ' + readiness.score);
  if (room) facts.push('Room score: ' + calculateRoomScore(room));
  rows.forEach(r => facts.push(r.label + ': ' + valShort_(r) + (r.d !== null ? ' (usual ' + (r.dur ? hmShort_(r.base) : Number(r.base).toFixed(r.dec)) + ', change ' + deltaShort_(r) + ', ' + r.verdict + ')' : '')));
  if (room) {
    facts.push('Bedroom temperature: ' + room.avgTemp.toFixed(1) + ' °C average; sleep guideline ' + SLEEP_TEMP_MIN + '–' + SLEEP_TEMP_MAX + ' °C');
    if (room.avgCO2 !== null) facts.push('Bedroom CO₂: peak ' + room.maxCO2.toFixed(0) + ' ppm, above ' + CO2_HIGH + ' ppm for ' + room.pctCO2High.toFixed(0) + '% of the night');
    facts.push('Humidity: ' + room.avgHumidity.toFixed(0) + '%');
    facts.push(room.pctWindowOpen !== null ? 'Window open ' + room.pctWindowOpen.toFixed(0) + '% of the night' : 'Window: no data');
  }
  if (sleep && sleep.pieces > 1) facts.push('Sleep came in ' + sleep.pieces + ' separate pieces this night');
  const verdicts = enRoomVerdicts_(room, sleep).concat(relations);
  if (suspect) verdicts.unshift(suspect.title + (suspect.effects.length ? ' (linked tonight: ' + suspect.effects.join(', ') + ')' : ''));
  if (bodyJudged) verdicts.push('BODY: ' + bodyWorse + ' of ' + bodyJudged + ' sleep metrics were worse than usual' +
                                     (bodyWorse >= 2 ? ', so the body did not cope well' : bodyWorse === 0 ? ', so the body held up' : ''));
  if (lowSleep) verdicts.push('This night is too short to judge: do not blame the room for the body metrics');
  if (sleep && sleep.partial) verdicts.push('Oura did not record a main night, only short pieces of sleep');
  const dataText = 'INPUT\n' + facts.join('\n') + '\n\nVERDICTS\n- ' + verdicts.join('\n- ');

  const fb = fallbackTexts_(room, sleep, rows, suspect, fusionWorse);
  const guard = { bodyWorse: bodyWorse, bodyJudged: bodyJudged, lowSleep: lowSleep,
                  room: room ? { temp: room.avgTemp > SLEEP_TEMP_MAX ? 'hot' : room.avgTemp < SLEEP_TEMP_MIN ? 'cold' : 'ok',
                                 hum: room.avgHumidity > HUM_MAX ? 'high' : room.avgHumidity < HUM_MIN ? 'low' : 'ok',
                                 co2: room.pctCO2High === null ? null : room.pctCO2High >= 30 ? 'high' : 'ok',
                                 win: room.pctWindowOpen === null ? null : room.pctWindowOpen >= 90 ? 'open' : room.pctWindowOpen < 5 ? 'closed' : 'mixed',
                                 light: room.pctDark >= 80 ? 'dark' : 'lit' } : null,
                  actions: tipActions_(room, suspect),
                  noLink: lowSleep || !room || noLink_(relations) };
  return { base: base, rows: rows, suspect: suspect, relations: relations, dataText: dataText, fb: fb, guard: guard, lowSleep: lowSleep,
           fx: fx, findings: findings };
}

function buildDashboard_(ctx, demoLabel) {
  const sleep = ctx.sleep, readiness = ctx.readiness, daily = ctx.daily, room = ctx.room, win = ctx.win;
  const inp = dashInputs_(ctx);
  const base = inp.base, rows = inp.rows, suspect = inp.suspect;
  const tx = dashTexts_(inp.dataText, inp.fb, inp.relations, inp.guard);

  const tz = Session.getScriptTimeZone();
  const hhmm = d => Utilities.formatDate(d, tz, 'HH:mm');
  let h = '🌙 <b>SLEEP LAB</b> · ' + Utilities.formatDate(new Date(), tz, 'EEE d MMM') + '\n';
  if (demoLabel) h += '<i>' + esc_(demoLabel) + '</i>\n';
  if (sleep && sleep.pieces > 1) h += '<i>Broken night: ' + sleep.pieces + ' pieces of sleep merged, ' + hhmm(new Date(sleep.bedtime_start)) + '–' + hhmm(new Date(sleep.bedtime_end)) + '</i>\n';
  if (sleep && sleep.partial) h += '<i>Oura has no main night yet — showing what the ring recorded. Send /report later to refresh.</i>\n';
  if (inp.lowSleep) h += '<i>Too little sleep recorded to compare with your usual nights.</i>\n';
  h += '\n<b>' + esc_(tx.headline) + '</b>\n' + esc_(tx.subline) + '\n\n';

  // v3: YOU × YOUR ROOM comes first: what the room did and what your body did in the same minutes.
  // Room-only and body-only numbers move into "Details" at the bottom.
  if (inp.fx && inp.findings) {
    const fx = inp.fx, f = fx.night;
    h += '🫀 <b>YOU × YOUR ROOM</b> · ' + hhmm(new Date(fx.points[0].t)) + '–' + hhmm(new Date(fx.points[fx.points.length - 1].t)) +
         ' <i>(every 5 minutes)</i>\n' +
         esc_('🌡 Room ' + fT1_(f.minTemp) + '–' + fT1_(f.maxTemp) + ' °C, average ' + fT1_(f.avgTemp) +
              (f.stuffyMin ? ' · CO₂ ≥' + CO2_HIGH + ' ppm for ' + f.stuffyMin + ' min' : '')) + '\n' +
         esc_('❤️ HRV ' + fR0_(f.avgHrv) + ' ms · pulse ' + fR0_(f.avgHr) + ' bpm' +
              (f.usual ? '  (your other nights: ' + fR0_(f.usual.hrv) + ' ms · ' + fR0_(f.usual.hr) + ' bpm)' : '')) + '\n' +
         inp.findings.map(x => (x.worse ? '🟠 ' : x.effect ? '🟢 ' : '⚪ ') + esc_(x.short)).join('\n') + '\n' +
         '<i>' + esc_(fusionHistoryText_(fx.history)) + '</i>\n\n';
    if (fx.map && fx.map.rows.length >= 2) {
      h += '🗺 <b>YOUR MAP</b> <i>(HRV and pulse by room temperature, all nights)</i>\n<pre>' + esc_(fusionMapText_(fx.map)) + '</pre>\n\n';
    }
    h += '✅ <b>Tonight:</b> ' + esc_(tx.tip) + '\n\n';
    h += '<blockquote expandable><b>Why?</b> ' + esc_(tx.why) + '</blockquote>\n';
    // details: the v2 blocks as plain lines (no <pre> inside a quote)
    const det = [];
    det.push('Scores: sleep ' + (daily && daily.score != null ? daily.score : '—') + ' · room ' + (room ? calculateRoomScore(room) : '—') +
             ' · readiness ' + (readiness && readiness.score != null ? readiness.score : '—'));
    if (suspect) det.push(suspect.icon + ' ' + suspect.title + ': ' + suspect.line);
    if (rows.length) det.push('You vs your usual: ' + rows.map(r => r.short + ' ' + valShort_(r) + (r.d !== null ? ' (' + deltaShort_(r) + ')' : '')).join(' · '));
    if (room) det.push('Bedroom: ' + room.avgTemp.toFixed(1) + ' °C · humidity ' + room.avgHumidity.toFixed(0) + ' % · dark ' + room.pctDark.toFixed(0) + ' %' +
                       (room.maxCO2 !== null ? ' · CO₂ peak ' + room.maxCO2.toFixed(0) + ' ppm' : '') +
                       ' · window ' + (room.pctWindowOpen === null ? 'no data' : room.pctWindowOpen < 1 ? 'closed all night' : 'open ' + room.pctWindowOpen.toFixed(0) + '%'));
    h += '<blockquote expandable><b>Details</b>\n' + esc_(det.join('\n')) + '</blockquote>';
    const chartTitle0 = (demoLabel ? 'DEMO room data · ' : '') + 'You × your room: HRV, temperature, CO₂, sleep stages';
    return { html: h, chartTitle: chartTitle0, status: tx.status, why: tx.why, tx: tx, inp: inp };
  }
  // no ring × room data for this night: the v2 report, with the reason on top
  if (ctx.fusion && ctx.fusion.reason) h += '🫀 <i>You × your room: ' + esc_(ctx.fusion.reason) + '. Showing nightly averages.</i>\n\n';

  const notYet = sleep ? '— not scored yet' : '— no data';     // ring data present, Oura score not ready yet
  h += '<pre>' + esc_(
    'SLEEP  ' + bar_(daily && daily.score != null ? daily.score : null, notYet) + '\n' +
    'ROOM   ' + bar_(room ? calculateRoomScore(room) : null) + '\n' +
    'READY  ' + bar_(readiness && readiness.score != null ? readiness.score : null, notYet)) + '</pre>\n\n';

  if (suspect) {
    h += suspect.icon + ' <b>' + esc_(suspect.title) + '</b>\n' + esc_(suspect.line) + '\n';
    if (suspect.effects.length) h += '→ ' + esc_(suspect.effects.slice(0, 3).join(' · ')) + '\n';
    else if (suspect.key !== 'none' && rows.some(r => r.verdict)) h += '→ your body metrics held up\n';
    h += '\n';
  }

  if (rows.length) {
    h += '<b>YOU vs YOUR USUAL</b>' + (base ? '' : ' <i>(baseline after 3 nights)</i>') + '\n<pre>' +
      esc_(rows.map(r => pad_(r.short, 7) + pad_(valShort_(r), 8) + padL_(deltaShort_(r), 6) + '  ' + dot_(r.verdict)).join('\n')) + '</pre>\n\n';
  } else {
    h += '<i>No ring data yet: open the Oura app to sync.</i>\n\n';
  }

  if (room) {
    const tState = room.avgTemp > SLEEP_TEMP_MAX ? '🟠 hot' : room.avgTemp < SLEEP_TEMP_MIN ? '🟠 cold' : '🟢';
    const cState = room.pctCO2High !== null && room.pctCO2High >= 30 ? '🟠 stuffy' : '🟢';
    const hState = room.avgHumidity < HUM_MIN || room.avgHumidity > HUM_MAX ? '🟠' : '🟢';
    const dState = room.pctDark >= 80 ? '🟢' : '🟠';
    const wText = room.pctWindowOpen === null ? 'no data' : room.pctWindowOpen < 1 ? 'closed all night' : 'open ' + room.pctWindowOpen.toFixed(0) + '%';
    const lines = [pad_('Temp', 8) + pad_(room.avgTemp.toFixed(1) + ' °C', 12) + tState];
    if (room.maxCO2 !== null) lines.push(pad_('CO₂', 8) + pad_(room.maxCO2.toFixed(0) + ' peak', 12) + cState);
    lines.push(pad_('Window', 8) + wText);
    lines.push(pad_('Humid', 8) + pad_(room.avgHumidity.toFixed(0) + ' %', 12) + hState);
    lines.push(pad_('Dark', 8) + pad_(room.pctDark.toFixed(0) + ' %', 12) + dState);
    h += '🏠 <b>BEDROOM</b> ' + hhmm(win.sleepStart) + '–' + hhmm(win.sleepEnd) + '\n<pre>' + esc_(lines.join('\n')) + '</pre>\n\n';
  } else {
    h += '🏠 <i>No bedroom data for this night.</i>\n\n';
  }

  h += '✅ <b>Tonight:</b> ' + esc_(tx.tip) + '\n\n';
  h += '<blockquote expandable><b>Why?</b> ' + esc_(tx.why) + '</blockquote>';

  const chartTitle = (demoLabel ? 'DEMO room data · ' : '') + 'Your night: bedroom vs sleep stages';
  return { html: h, chartTitle: chartTitle, status: tx.status, why: tx.why, tx: tx, inp: inp };
}

function dashContext_() {
  let sleep = null, readiness = null, daily = null;
  try { sleep = getOuraSleep(); } catch (e) { Logger.log('sleep: ' + e); }
  try { readiness = getOuraReadiness(); } catch (e) { Logger.log('readiness: ' + e); }
  try { daily = getOuraDailySleep(); } catch (e) { Logger.log('daily_sleep: ' + e); }
  const win = nightWindow_(sleep);
  let room = null;
  try { room = getRoomStatsForNight(win.sleepStart, win.sleepEnd); } catch (e) { Logger.log('room: ' + e); }
  let fusion = null;                                                 // v3: ring × room, every 5 minutes
  try { fusion = fusionForNight_(sleep); } catch (e) { Logger.log('fusion: ' + e); }
  return { sleep: sleep, readiness: readiness, daily: daily, room: room, win: win, fusion: fusion };
}

// Row in "Sleep Report"
function appendSleepReportRow_(ctx, status, aiText) {
  const room = ctx.room, sleep = ctx.sleep, readiness = ctx.readiness;
  const fx = (v, d) => (v === null || v === undefined) ? '' : Number(v).toFixed(d);
  getReportSheet().appendRow([
    new Date(),
    room ? fx(room.avgTemp, 1) : '', room ? fx(room.minTemp, 1) : '', room ? fx(room.maxTemp, 1) : '',
    room ? fx(room.tempStdDev, 2) : '', room ? fx(room.avgHumidity, 1) : '',
    room ? fx(room.avgBrightness, 0) : '', room ? fx(room.maxBrightness, 0) : '', room ? fx(room.pctDark, 0) : '',
    room ? fx(room.pctWindowOpen, 0) : '',
    room ? calculateRoomScore(room) : '',
    sleep ? cell_(sleep.efficiency) : '',
    sleep ? cell_(minFromSec_(sleep.total_sleep_duration)) : '', sleep ? cell_(minFromSec_(sleep.deep_sleep_duration)) : '',
    sleep ? cell_(minFromSec_(sleep.rem_sleep_duration)) : '',
    sleep ? cell_(sleep.average_hrv) : '', sleep ? cell_(sleep.lowest_heart_rate) : '',
    sleep ? cell_(minFromSec_(sleep.awake_time)) : '',
    readiness ? cell_(readiness.score) : '',
    room ? fx(room.avgCO2, 0) : '', room ? fx(room.maxCO2, 0) : '',
    status, cell_(aiText)
  ].concat(fusionReportCells_(ctx.fusion)));                         // v3: ring × room columns at the end
}

// v3: Sleep Report columns for ring × room (empty when the night could not be fused)
function fusionReportCells_(fusion) {
  const f = fusion && fusion.night;                                  // this night's comparison
  if (!f) return ['', '', '', '', '', '', '', '', '', '', ''];
  const r1 = v => (v === null || v === undefined) ? '' : Math.round(v * 10) / 10;   // one decimal, or empty
  return [f.points, r1(f.avgHrv), r1(f.avgHr), f.usual ? r1(f.usual.hrv) : '', f.usual ? r1(f.usual.hr) : '',
          f.warmMin, f.warm ? r1(f.warm.hrv) : '', f.warm ? r1(f.warm.refHrv) : '',
          f.stuffyMin, f.stuffy ? r1(f.stuffy.hrv) : '', f.stuffy ? r1(f.stuffy.refHrv) : ''];
}

// MAIN REPORT: dashboard + chart. Called by morningCheck(), /report, or manually.
// source (for the Run Log): 'auto' | 'command' | 'manual'
function sendDailyReport(source) {
  source = (typeof source === 'string') ? source : 'manual';   // the editor passes an event object
  const p = PropertiesService.getScriptProperties();
  try { saveOuraSleepToSheet(); } catch (e) { Logger.log('saveOuraSleepToSheet: ' + e); }
  const ctx = dashContext_();
  if (!ctx.sleep && !ctx.room) {
    // once per day, not every 30 min
    sendTelegramMessage('🌙 Sleep Lab: no night recorded for today — no ring sleep and no bedroom data.\n' +
                        'Skipping today\'s report; the next one comes tomorrow morning.\n' +
                        'If the ring syncs later, send /report. Send /status to see what data I have.');
    p.setProperty('LAST_REPORT_DAY', dayStr_(0));
    logRun_(source, 'no_data', ctx, null, '');
    return;
  }
  const d = buildDashboard_(ctx, null);
  sendTelegramHtml_(d.html);
  try {
    const s = nightSeries_(ctx.win, ctx.sleep, ctx.fusion && ctx.fusion.points);   // v3: + your HRV
    if (s.hasRoom || s.hasStages) {
      const png = renderNightChart_(s, d.chartTitle);
      if (png) sendTelegramPhoto_(png, s.hasHrv
        ? '🌙 <b>You × your room</b>: CO₂, window and temperature on top, your HRV and Oura sleep stages below — one time axis.'
        : '🌙 <b>Your night</b>: CO₂, temperature and window on top, your Oura sleep stages below.');
    }
  } catch (e) { Logger.log('chart: ' + e); }
  try { appendSleepReportRow_(ctx, d.status, d.why); } catch (e) { Logger.log('Sleep Report: ' + e); }
  p.setProperty('LAST_REPORT_DAY', dayStr_(0));
  const outcome = !ctx.sleep ? 'sent_room_only' : ctx.sleep.partial ? 'sent_partial' : ctx.sleep.pieces > 1 ? 'sent_merged' : 'sent';
  const fusedNote = ctx.fusion ? (ctx.fusion.night ? 'ring×room ' + ctx.fusion.night.points + ' points' : 'ring×room: ' + ctx.fusion.reason) : 'ring×room: no night';
  logRun_(source, outcome, ctx, d.tx, [(d.tx.problems || []).join('; '), fusedNote].filter(Boolean).join(' | '));   // v3: fusion in the log
  Logger.log('Dashboard sent, text status: ' + d.status + ' · ' + fusedNote);
}

// Every 30 min; one report per day.
// Before 12:00 only when the night is ready: a main Oura sleep and today's sleep score.
// Otherwise (broken sleep, ring not synced) send what we have at 12:00, flagged in the report.
function morningCheck() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('LAST_REPORT_DAY') === dayStr_(0)) return;
  const hour = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H'));
  if (hour < 6) return;
  let sleep = null, daily = null;
  try { sleep = getOuraSleep(); } catch (e) { Logger.log('morningCheck: ' + e); }
  try { daily = getOuraDailySleep(); } catch (e) { Logger.log('morningCheck daily: ' + e); }
  const ready = sleep && sleep.day === dayStr_(0) && !sleep.partial && daily && daily.score != null;
  if (ready || hour >= 12) sendDailyReport('auto');
}


// ========== RUN LOG ==========
// One row per report and per command

const RUN_LOG_HEADERS = ['Time', 'Source', 'Outcome', 'OuraDay', 'OuraType', 'Pieces', 'SleepMin', 'NightStart', 'NightEnd',
                         'RoomRows', 'AiStatus', 'AiAttempts', 'AiProblems', 'Note'];

function logRun_(source, outcome, ctx, tx, note) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(RUN_LOG_SHEET_NAME);
    if (!sh) { sh = ss.insertSheet(RUN_LOG_SHEET_NAME); sh.appendRow(RUN_LOG_HEADERS); sh.setFrozenRows(1); }
    const s = ctx && ctx.sleep, w = ctx && ctx.win, r = ctx && ctx.room;
    sh.appendRow([new Date(), source, outcome,
      s ? s.day : '', s ? s.type : '', s ? (s.pieces || 1) : '', s ? cell_(minFromSec_(s.total_sleep_duration)) : '',
      w ? w.sleepStart : '', w ? w.sleepEnd : '', r ? r.readingsCount : '',
      tx ? tx.status : '', tx ? tx.attempts : '', tx ? (tx.problems || []).join('; ') : '', note || '']);
  } catch (e) { Logger.log('Run Log: ' + e); }
}


// ========== TELEGRAM COMMANDS ==========
// /report  recalculate and resend today's report
// /skip    missed night: no report or reminders today
// /status  what data is available right now
// /help    list of commands
// Polled once a minute via getUpdates (no webhook; doPost stays for the board).
// Only messages from TELEGRAM_CHAT_ID are accepted. Enable once: setupCommands().

function tgApi_(method, payload) {
  const url = 'https://api.telegram.org/bot' + prop_('TELEGRAM_BOT_TOKEN', true) + '/' + method;
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
                                       payload: JSON.stringify(payload || {}), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { Logger.log('Telegram ' + method + ' ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300)); return null; }
  return JSON.parse(res.getContentText()).result;
}

function setupCommands() {
  tgApi_('deleteWebhook', { drop_pending_updates: true });          // getUpdates fails while a webhook is set
  tgApi_('setMyCommands', { commands: [
    { command: 'ask',    description: 'Ask a question about your nights' },
    { command: 'report', description: 'Recalculate and resend today\'s report' },
    { command: 'skip',   description: 'Missed night: no report today' },
    { command: 'status', description: 'What data I have right now' },
    { command: 'help',   description: 'List of commands' }
  ] });
  // skip the backlog
  const ups = tgApi_('getUpdates', { offset: -1, timeout: 0 }) || [];
  if (ups.length) PropertiesService.getScriptProperties().setProperty('TG_OFFSET', String(ups[ups.length - 1].update_id + 1));
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'pollTelegram') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  Logger.log('Done: /report /skip /status /help, polled every minute');
}

function pollTelegram() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;                                   // previous run still busy (/report takes ~20 s)
  try {
    const p = PropertiesService.getScriptProperties();
    const offset = Number(p.getProperty('TG_OFFSET') || 0);
    const ups = tgApi_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message'] });
    if (!ups || !ups.length) return;
    const myChat = String(prop_('TELEGRAM_CHAT_ID', true));
    ups.forEach(u => {
      p.setProperty('TG_OFFSET', String(u.update_id + 1));           // advance first so a failing command never loops
      const m = u.message;
      if (!m || !m.text || String(m.chat.id) !== myChat) return;     // ignore other chats
      const text = m.text.trim();
      const cmd = text.charAt(0) === '/' ? text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '') : '/ask';
      const arg = text.charAt(0) === '/' ? text.slice(text.split(/\s+/)[0].length).trim() : text;
      try { handleCommand_(cmd, arg); }
      catch (e) { Logger.log('command ' + cmd + ': ' + e); sendTelegramMessage('⚠️ ' + cmd + ' failed: ' + String(e.message || e).slice(0, 200)); }
    });
  } finally { lock.releaseLock(); }
}

function handleCommand_(cmd, arg) {
  const p = PropertiesService.getScriptProperties();
  if (cmd === '/ask') {
    if (!arg) { sendTelegramMessage('Ask me anything about your nights, e.g. "Does opening the window help my sleep?"'); return; }
    tgApi_('sendChatAction', { chat_id: prop_('TELEGRAM_CHAT_ID', true), action: 'typing' });
    askRoom_(arg);
  } else if (cmd === '/report') {
    sendTelegramMessage('🔄 Recalculating last night from fresh Oura and bedroom data…');
    sendDailyReport('command');
  } else if (cmd === '/skip') {
    p.setProperty('LAST_REPORT_DAY', dayStr_(0));
    logRun_('command', 'skipped', null, null, 'night marked as missed');
    sendTelegramMessage('⏭ OK — last night is marked as missed. No report and no reminders today; the next report comes tomorrow morning.\nChanged your mind? Send /report.');
  } else if (cmd === '/status') {
    sendTelegramMessage(statusText_());
    logRun_('command', 'status', null, null, '');
  } else if (cmd === '/help' || cmd === '/start') {
    sendTelegramMessage('Sleep Lab commands:\n/report — recalculate and resend today\'s report\n/skip — missed night, no report today\n/status — what data I have right now\n/help — this list\n\nOr just ask a question about your nights, e.g. "Does opening the window help my sleep?"');
  }
}

// Right now: Oura sleep pieces, sleep score, bedroom rows, today's report
function statusText_() {
  const tz = Session.getScriptTimeZone();
  const hhmm = d => Utilities.formatDate(new Date(d), tz, 'HH:mm');
  const L = ['📋 Status · ' + Utilities.formatDate(new Date(), tz, 'EEE d MMM HH:mm')];
  const items = ouraGet_('sleep', dayStr_(-1), dayStr_(1)) || [];
  const since = Date.now() - 20 * 3600 * 1000;
  const recent = items.filter(n => n.bedtime_end && new Date(n.bedtime_end).getTime() > since && n.type !== 'deleted');
  if (!recent.length) L.push('Oura: no sleep in the last 20 h (ring not synced, or no sleep).');
  else {
    L.push('Oura sleep pieces (last 20 h):');
    recent.sort((a, b) => new Date(a.bedtime_start) - new Date(b.bedtime_start)).forEach(n =>
      L.push('  • ' + hhmm(n.bedtime_start) + '–' + hhmm(n.bedtime_end) + '  ' + n.type + '  ' + (minFromSec_(n.total_sleep_duration) || 0) + ' min sleep'));
  }
  const daily = getOuraDailySleep();
  L.push('Oura sleep score: ' + (daily && daily.score != null ? daily.score : 'not ready yet'));
  const night = mergeNight_(items, Date.now());
  const win = nightWindow_(night);
  const room = getRoomStatsForNight(win.sleepStart, win.sleepEnd);
  L.push('Night window: ' + hhmm(win.sleepStart) + '–' + hhmm(win.sleepEnd) + (night && night.pieces > 1 ? ' (' + night.pieces + ' pieces merged)' : ''));
  L.push('Bedroom rows in that window: ' + (room ? room.readingsCount : 0));
  // v3: how many 5-minute ring points there are, and how many of them have bedroom readings
  const ring = night ? ringSeries_(night) : [];
  const fused = ring.length ? fusePoints_(ring, getSensorSheet().getDataRange().getValues()) : [];
  L.push('Ring 5-minute points: ' + ring.length + ' · with bedroom data: ' + fused.length);
  const last = getSensorSheet().getRange(getSensorSheet().getLastRow(), 1).getValue();
  if (last instanceof Date) L.push('Last row from the sensor: ' + Math.round((Date.now() - last) / 60000) + ' min ago');
  const sent = PropertiesService.getScriptProperties().getProperty('LAST_REPORT_DAY') === dayStr_(0);
  L.push('Report today: ' + (sent ? 'already sent (or skipped) — /report to resend' : 'not yet'));
  return L.join('\n');
}

// Layout test: real sleep, DEMO bedroom data (labelled in the message and chart)
function sendDashboardDemo() {
  const ctx = dashContext_();
  ctx.room = { avgTemp: 25.6, minTemp: 25.2, maxTemp: 26.0, tempStdDev: 0.2, avgHumidity: 58, avgBrightness: 10,
               maxBrightness: 30, pctDark: 95, pctWindowOpen: 0, windowChanges: 0,
               avgCO2: 1150, maxCO2: 1450, pctCO2High: 62, readingsCount: 240 };
  const d = buildDashboard_(ctx, 'DEMO bedroom data — layout test, not a real night');
  sendTelegramHtml_(d.html);
  const s = nightSeries_(ctx.win, ctx.sleep);
  const n = s.labels.length;
  for (let i = 0; i < n; i++) {                       // synthetic room: warm, CO₂ rising, window closed
    const x = i / Math.max(1, n - 1);
    s.temp[i] = Math.round((25.2 + 0.8 * x + 0.1 * Math.sin(i / 3)) * 10) / 10;
    s.co2[i] = Math.round(650 + 800 * Math.min(1, x / 0.75) - 60 * Math.max(0, x - 0.75) * 4);
    s.open[i] = null;
  }
  const png = renderNightChart_(s, d.chartTitle);
  if (png) sendTelegramPhoto_(png, '🌙 <b>Your night</b> <i>(DEMO bedroom data)</i>');
  Logger.log('Demo sent, text status: ' + d.status);
}


// Room verdicts (thresholds in SETTINGS)
function enRoomVerdicts_(room, sleep) {
  const V = [];
  if (room) {
    if (room.avgTemp > SLEEP_TEMP_MAX) V.push('Room temperature was above the usual sleep guideline of ' + SLEEP_TEMP_MIN + '–' + SLEEP_TEMP_MAX + ' °C');
    else if (room.avgTemp < SLEEP_TEMP_MIN) V.push('Room temperature was below the usual sleep guideline of ' + SLEEP_TEMP_MIN + '–' + SLEEP_TEMP_MAX + ' °C');
    else V.push('Room temperature was within the usual sleep guideline of ' + SLEEP_TEMP_MIN + '–' + SLEEP_TEMP_MAX + ' °C');
    if (room.pctCO2High !== null) V.push(room.pctCO2High >= 30 ? 'CO₂ spent a large part of the night above ' + CO2_HIGH + ' ppm: the air was stuffy' : 'CO₂ stayed mostly below ' + CO2_HIGH + ' ppm');
    V.push(room.avgHumidity < HUM_MIN || room.avgHumidity > HUM_MAX ? 'Humidity was outside the ' + HUM_MIN + '–' + HUM_MAX + ' % comfort range' : 'Humidity was in the comfort range, so do not blame it');
  }
  if (sleep) {
    const tot = minFromSec_(sleep.total_sleep_duration);
    if (tot !== null && tot < SLEEP_SHORT_MIN) V.push('It was a short night: less than ' + (SLEEP_SHORT_MIN / 60) + ' hours of sleep');
  }
  return V;
}

// How metrics relate THIS night. Code writes the sentences; the model only rephrases them
function enRelations_(room, rows, readiness) {
  const R = [];
  const by = {};
  rows.forEach(r => by[r.label] = r);
  const is = (k, v) => by[k] && by[k].verdict === v;
  const judged = keys => keys.filter(k => by[k] && by[k].verdict);

  if (room && room.avgTemp > SLEEP_TEMP_MAX) {
    const hits = [];
    if (is('HRV', 'worse than usual')) hits.push('lower HRV');
    if (is('Lowest heart rate', 'worse than usual')) hits.push('a higher lowest heart rate');
    if (is('Deep sleep', 'worse than usual')) hits.push('less deep sleep');
    const known = judged(['HRV', 'Lowest heart rate', 'Deep sleep']);
    const t = room.avgTemp.toFixed(1);
    if (hits.length) R.push('The warm room (' + t + ' °C average) coincides with ' + hits.join(', ') + ', the direction in which heat is known to push these metrics');
    else if (known.length) R.push('The room was warm (' + t + ' °C average), but HRV, lowest heart rate and deep sleep held up, so this night shows no heat effect on them');
    else R.push('The room was warm (' + t + ' °C average), but there is no personal baseline yet to judge its effect on HRV, heart rate or deep sleep');
  }
  if (room && room.avgTemp < SLEEP_TEMP_MIN) {
    const hits = [];
    if (is('Awake time', 'worse than usual')) hits.push('more time awake');
    if (is('Deep sleep', 'worse than usual')) hits.push('less deep sleep');
    if (is('Sleep efficiency', 'worse than usual')) hits.push('lower sleep efficiency');
    const known = judged(['Awake time', 'Deep sleep', 'Sleep efficiency']);
    const t = room.avgTemp.toFixed(1);
    if (hits.length) R.push('The cold room (' + t + ' °C average) coincides with ' + hits.join(', '));
    else if (known.length) R.push('The room was cold (' + t + ' °C average), but awake time, deep sleep and efficiency held up, so this night shows no cold effect on them');
    else R.push('The room was cold (' + t + ' °C average), but there is no personal baseline yet to judge its effect on your sleep');
  }
  if (room && room.pctCO2High !== null && room.pctCO2High >= 30) {
    const hits = [];
    if (is('Awake time', 'worse than usual')) hits.push('more time awake');
    if (is('Sleep efficiency', 'worse than usual')) hits.push('lower sleep efficiency');
    if (is('Breathing rate', 'higher than usual')) hits.push('a higher breathing rate');
    const known = judged(['Awake time', 'Sleep efficiency', 'Breathing rate']);
    const c = room.maxCO2.toFixed(0);
    if (hits.length) R.push('Stuffy air (CO₂ peaked at ' + c + ' ppm) coincides with ' + hits.join(', '));
    else if (known.length) R.push('CO₂ peaked at ' + c + ' ppm, but awake time, efficiency and breathing rate stayed normal, so this night shows no effect of stuffy air');
    if (room.pctWindowOpen !== null && room.pctWindowOpen < 5) {
      R.push('The window stayed closed according to the reed switch, which is how CO₂ built up to ' + c + ' ppm');
    }
  }
  if (readiness && readiness.temperature_deviation !== null && readiness.temperature_deviation !== undefined && room) {
    const d = Number(readiness.temperature_deviation);
    R.push('Oura measured your body temperature ' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2) + ' °C versus your own baseline, while the room averaged ' + room.avgTemp.toFixed(1) + ' °C');
  }
  // A good room and a better-than-usual night: a positive link (not only problems)
  const roomGood = room && room.avgTemp >= SLEEP_TEMP_MIN && room.avgTemp <= SLEEP_TEMP_MAX && !(room.pctCO2High !== null && room.pctCO2High >= 30);
  const better = ['Deep sleep', 'REM sleep', 'HRV', 'Sleep efficiency', 'Awake time'].filter(k => is(k, 'better than usual'))
    .map(k => ({ 'Deep sleep': 'more deep sleep', 'REM sleep': 'more REM', 'HRV': 'a higher HRV', 'Sleep efficiency': 'higher efficiency', 'Awake time': 'less time awake' })[k]);
  if (!R.length && roomGood && better.length) {
    R.push('A room within the sleep guideline (' + room.avgTemp.toFixed(1) + ' °C' + (room.avgCO2 !== null ? ', CO₂ below ' + CO2_HIGH + ' ppm' : '') +
           (room.pctWindowOpen !== null && room.pctWindowOpen >= 90 ? ', window open all night' : '') + ') coincides with ' + better.join(', '));
  }
  if (!R.length) R.push('No clear link between the room and your sleep metrics this night');
  return R;
}


// ========== ASK YOUR ROOM ==========
// A free question in Telegram. Code collects the nights and computes the comparisons; Nemotron answers from them;
// the answer is checked like the morning report (numbers from the input only, no causal claims) or replaced by the code's data.

// Last ASK_DAYS nights: merged Oura night + bedroom stats for its window
function askNights_() {
  const items = ouraGet_('sleep', dayStr_(-ASK_DAYS), dayStr_(1)) || [];
  const byDay = {};
  items.forEach(n => { if (n.type !== 'deleted' && n.type !== 'rest' && n.bedtime_start && n.bedtime_end) (byDay[n.day] = byDay[n.day] || []).push(n); });
  const values = getSensorSheet().getDataRange().getValues();
  return Object.keys(byDay).sort().map(day => {
    const group = byDay[day];
    const night = mergeNight_(group, Math.max(...group.map(n => new Date(n.bedtime_end).getTime())) + 3600000);
    if (!night) return null;
    const win = nightWindow_(night);
    return { day: day, sleep: night, room: getRoomStatsForNight(win.sleepStart, win.sleepEnd, values) };
  }).filter(Boolean);
}

function askNightLine_(n) {
  const tz = Session.getScriptTimeZone(), s = n.sleep, r = n.room;
  const d = v => v === null || v === undefined ? '—' : hmShort_(minFromSec_(v));
  let t = Utilities.formatDate(new Date(n.day + 'T12:00:00'), tz, 'EEE d MMM') + ': sleep ' + d(s.total_sleep_duration) +
          ', deep ' + d(s.deep_sleep_duration) + ', REM ' + d(s.rem_sleep_duration) + ', awake ' + d(s.awake_time) +
          (s.efficiency != null ? ', efficiency ' + s.efficiency + '%' : '') + (s.average_hrv != null ? ', HRV ' + s.average_hrv + ' ms' : '') +
          (s.lowest_heart_rate != null ? ', lowest HR ' + s.lowest_heart_rate + ' bpm' : '') + (s.pieces > 1 ? ' (broken: ' + s.pieces + ' pieces)' : '');
  t += !r ? ' | room: no data' : ' | room ' + r.avgTemp.toFixed(1) + ' °C, humidity ' + r.avgHumidity.toFixed(0) + '%' +
       (r.maxCO2 !== null ? ', CO₂ peak ' + r.maxCO2.toFixed(0) + ' ppm (above ' + CO2_HIGH + ' for ' + r.pctCO2High.toFixed(0) + '% of the night)' : '') +
       (r.pctWindowOpen !== null ? ', window open ' + r.pctWindowOpen.toFixed(0) + '%' : '');
  return t;
}

// Group comparisons the code can stand behind (each side needs at least 2 nights)
function askComparisons_(nights) {
  const rows = nights.filter(n => n.room);
  const mean = (arr, f) => { const v = arr.map(f).filter(x => x !== null && x !== undefined && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const metrics = [
    ['deep sleep', n => minFromSec_(n.sleep.deep_sleep_duration), x => hmShort_(x)],
    ['REM', n => minFromSec_(n.sleep.rem_sleep_duration), x => hmShort_(x)],
    ['total sleep', n => minFromSec_(n.sleep.total_sleep_duration), x => hmShort_(x)],
    ['efficiency', n => toNum(n.sleep.efficiency), x => Math.round(x) + '%'],
    ['HRV', n => toNum(n.sleep.average_hrv), x => Math.round(x) + ' ms'],
    ['lowest heart rate', n => toNum(n.sleep.lowest_heart_rate), x => Math.round(x) + ' bpm']
  ];
  const splits = [
    ['window open most of the night', n => n.room.pctWindowOpen !== null && n.room.pctWindowOpen >= 50, 'window mostly closed'],
    ['warm room (above ' + SLEEP_TEMP_MAX + ' °C)', n => n.room.avgTemp > SLEEP_TEMP_MAX, 'room within ' + SLEEP_TEMP_MIN + '–' + SLEEP_TEMP_MAX + ' °C'],
    ['stuffy air (CO₂ above ' + CO2_HIGH + ' ppm for 30%+ of the night)', n => n.room.pctCO2High !== null && n.room.pctCO2High >= 30, 'fresher air']
  ];
  const out = ['Nights with sleep data: ' + nights.length + '; with bedroom data: ' + rows.length];
  splits.forEach(sp => {
    const a = rows.filter(sp[1]), b = rows.filter(n => !sp[1](n));
    if (a.length < 2 || b.length < 2) { out.push(sp[0] + ': ' + a.length + ' nights vs ' + sp[2] + ': ' + b.length + ' nights — too few nights to compare yet'); return; }
    out.push(sp[0] + ' (' + a.length + ' nights) vs ' + sp[2] + ' (' + b.length + ' nights): ' + metrics.map(mt => {
      const x = mean(a, mt[1]), y = mean(b, mt[1]);
      return x === null || y === null ? null : mt[0] + ' ' + mt[2](x) + ' vs ' + mt[2](y);
    }).filter(Boolean).join(', '));
  });
  return out;
}

function askContext_() {
  const nights = askNights_();
  const base = ouraBaseline_(null);
  const lines = nights.map(askNightLine_);
  const comps = askComparisons_(nights);
  const usual = base ? 'Usual (average of up to 14 main nights): sleep ' + hmShort_(base.totalMin) + ', deep ' + hmShort_(base.deepMin) +
    ', REM ' + hmShort_(base.remMin) + (base.eff !== null ? ', efficiency ' + Math.round(base.eff) + '%' : '') +
    (base.hrv !== null ? ', HRV ' + Math.round(base.hrv) + ' ms' : '') + (base.lowestHr !== null ? ', lowest HR ' + Math.round(base.lowestHr) + ' bpm' : '') : 'Usual: not enough nights yet';
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEE d MMM yyyy');
  const dataText = 'TODAY: ' + today + '\n\nNIGHTS (newest last)\n' + lines.join('\n') + '\n\n' + usual + '\n\nCOMPARISONS (computed by code)\n- ' + comps.join('\n- ');
  return { nights: nights, dataText: dataText, comps: comps, lines: lines };
}

const ASK_SYSTEM =
  'You answer questions about one person\'s own sleep and bedroom in a Telegram chat. Plain text only, at most 4 short sentences. ' +
  'Use only the NIGHTS, the usual values and the COMPARISONS; every number you write must appear there exactly as written. ' +
  'Name the date when you refer to a night. The comparisons were computed by code: if one says too few nights, say there is not enough data yet ' +
  'and suggest how to get it (for example a few nights with the window open). One or a few nights are a hint, not proof: use "may" or "is consistent with", ' +
  'never "caused" or "due to". No medical advice: for medication or health questions, say this is a question for a doctor. ' +
  'If the question cannot be answered from the data (the future, other people, things not measured), say so briefly and say what you can answer. ' +
  'Answer in the language of the question.';

// Pure: question + context → { text, status, attempts, problems, ms }. Used by Telegram and by the evals
function askAnswer_(question, ctx) {
  const out = { text: null, status: 'fallback', attempts: 0, problems: [], ms: 0 };
  const model = prop_('NEBIUS_MODEL', false);
  const allowed = new Set(nemNumbers_(ctx.dataText + ' ' + question));
  const cyr = /[\u0400-\u04FF]/.test(question);
  let user = ctx.dataText + '\n\nQUESTION: ' + question;
  const t0 = Date.now();
  if (model) for (let attempt = 1; attempt <= 2; attempt++) {
    out.attempts = attempt;
    const r = nebiusChat_(model, ASK_SYSTEM, user, 400, NO_THINKING);
    if (!r || !r.text) { out.status = 'api_error'; break; }
    const t = r.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const p = [];
    const bad = nemNumbers_(t).filter(n => !allowed.has(n));
    if (bad.length) p.push('numbers not in the data: ' + bad.join(', '));
    if (!t || t.length > 700) p.push('length');
    if (/\b(caused|causes|due to)\b/i.test(t)) p.push('overclaim: say "may" or "is consistent with"');
    if (!cyr && /[\u0400-\u04FF]/.test(t)) p.push('language: answer in English');
    if (cyr && !/[\u0400-\u04FF]/.test(t)) p.push('language: answer in the language of the question');
    if (/\b(code|facts|comparisons block|verdicts?)\b/i.test(t)) p.push('internal words');
    out.problems = p;
    if (!p.length) { out.text = t; out.status = 'ok'; break; }
    user += '\n\nYour answer had problems: ' + p.join('; ') + '. Answer again, plain text, numbers only from the data.';
  }
  out.ms = Date.now() - t0;
  if (!out.text) out.text = 'I could not answer that reliably. Here is what the data says:\n' +
                            '• ' + ctx.comps.join('\n• ') + '\n\nLast nights:\n' + ctx.lines.slice(-3).join('\n');
  return out;
}

function askRoom_(question) {
  const ctx = askContext_();
  const a = askAnswer_(question, ctx);
  sendTelegramMessage(a.text);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(ASK_LOG_SHEET_NAME);
    if (!sh) { sh = ss.insertSheet(ASK_LOG_SHEET_NAME); sh.appendRow(['Time', 'Question', 'Answer', 'Status', 'Attempts', 'Problems', 'Ms', 'Nights']); sh.setFrozenRows(1); }
    sh.appendRow([new Date(), question, a.text, a.status, a.attempts, a.problems.join('; '), a.ms, ctx.nights.length]);
  } catch (e) { Logger.log('Ask Log: ' + e); }
  return a;
}

// Editor test: what the model sees and what it answers
function testAsk() {
  const ctx = askContext_();
  Logger.log(ctx.dataText);
  const a = askAnswer_('Does opening the window help my sleep?', ctx);
  Logger.log(a.status + ' · ' + a.attempts + ' attempt(s) · ' + a.ms + ' ms\n' + a.text);
}


// ========== SETUP CHECK ==========
// Run first after pasting: shows what is missing (never prints key values)

function checkSetup() {
  const p = PropertiesService.getScriptProperties();
  ['OURA_CLIENT_ID', 'OURA_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'NEBIUS_API_KEY', 'NEBIUS_MODEL']
    .forEach(k => Logger.log((p.getProperty(k) ? '✅ ' : '❌ MISSING ') + k));
  Logger.log((p.getProperty('SECRET_KEY') ? '✅ SECRET_KEY set (must match secrets.h)' : 'ℹ️ SECRET_KEY not set: board password check is off'));

  Logger.log('Project time zone: ' + Session.getScriptTimeZone() + ' (expected Europe/London)');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const named = ss.getSheetByName(SENSOR_SHEET_NAME);
  Logger.log(named ? '✅ Sensor tab "' + SENSOR_SHEET_NAME + '" found'
                   : '❌ No "' + SENSOR_SHEET_NAME + '" tab, writing to the first tab "' + ss.getSheets()[0].getName() + '"');
  const sh = getSensorSheet();
  const last = sh.getLastRow();
  if (last > 0) {
    const d = new Date(sh.getRange(last, 1).getValue());
    if (!isNaN(d.getTime())) Logger.log('Last row from the board: ' + d + ' (' + Math.round((Date.now() - d) / 60000) + ' min ago)');
  }
  Logger.log(sh.getRange(1, 1).getValue() === 'Date' ? '✅ Headers present' : 'ℹ️ No headers, run setupSensorHeaders()');

  try { Logger.log(getOuraService().hasAccess() ? '✅ Oura authorized' : '❌ Oura: run authorize()'); }
  catch (e) { Logger.log('❌ Oura: ' + e.message); }

  const trig = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'morningCheck').length;
  Logger.log(trig ? '✅ Morning check on (' + trig + ')' : 'ℹ️ No morning check, run setupTrigger()');
  const cmds = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'pollTelegram').length;
  Logger.log(cmds ? '✅ Telegram commands on (/report /skip /status /help)' : 'ℹ️ No Telegram commands, run setupCommands()');
  // v3: the ring × room history
  const fsh = ss.getSheetByName(FUSION_SHEET_NAME);
  Logger.log(fsh && fsh.getLastRow() > 1 ? '✅ Ring × room history: ' + (fsh.getLastRow() - 1) + ' five-minute points'
                                         : 'ℹ️ No ring × room history yet, run fusionBacktest()');
}
