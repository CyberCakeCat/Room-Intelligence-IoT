// =====================================================================
// ROOM INTELLIGENCE — EVALS. Separate file in the same Apps Script project; uses Code_v3.gs (3.0.0).
//
// Question: does Nemotron make the morning report better than the code's template, without lying?
//   Level 1  automatic checks on every answer: numbers from the input only, format, no contradiction with
//            the body or the room, no causes on thin data, hedging, tip targets the suspect, headline names it.
//            Measured on the model's first answer (the model alone) and on what is shown (after checks).
//   Level 2  stability: each case runs EVAL_REPS times.
//   Level 3  usefulness: two judge models from different families compare Nemotron and the template blind,
//            each pair twice (Nemotron as X, then as Y); a verdict that flips with order counts as a tie.
//   Plus a "Blind Review" tab for a human, order randomised, key hidden.
//
// Run: evalsQuickCheck() first (2 cases, log only), then startEvals() (background, result sent to Telegram).
//      evalsStatus(), stopEvals(), summarizeEvals() (re-run after filling Blind Review).
// =====================================================================

const EVAL_REPS   = 3;
// Judges: first available model from each list (Token Factory's catalogue changes). [0] NVIDIA, [1] another family
const EVAL_JUDGE_PREFS = [
  ['nvidia/Nemotron-3-Ultra-550b-a55b', 'nvidia/nemotron-3-super-120b-a12b'],
  ['Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3-235B-A22B-Instruct-2507', 'deepseek-ai/DeepSeek-V4-Pro', 'zai-org/GLM-5.3', 'moonshotai/Kimi-K3']
];

function evJudges_() {
  const st = evState_();
  if (st && st.judges && st.phase !== 'done') return st.judges;
  const res = UrlFetchApp.fetch(NEBIUS_BASE + '/models', { headers: { Authorization: 'Bearer ' + nebiusKey_() }, muteHttpExceptions: true });
  const ids = res.getResponseCode() === 200 ? (JSON.parse(res.getContentText()).data || []).map(m => m.id) : [];
  const judges = EVAL_JUDGE_PREFS.map(list => list.find(m => ids.indexOf(m) >= 0)).filter(Boolean);
  if (judges.length < 2) throw new Error('Judge models not available. Run nebiusListModels() and update EVAL_JUDGE_PREFS.');
  Logger.log('Judges: ' + judges.join(', '));
  return judges;
}
const EVAL_BUDGET_MS = 270 * 1000;                 // per run; Apps Script stops at 6 min
const EVAL_SHEETS = { cases: 'Eval Cases', results: 'Eval Results', judg: 'Eval Judgments', sum: 'Eval Summary', blind: 'Blind Review' };


// ---------- cases ----------

// Baseline for synthetic cases
const EVAL_BASE = { n: 10, totalMin: 450, deepMin: 85, remMin: 115, awakeMin: 45, eff: 89, latency: 12, hrv: 42, lowestHr: 55, breath: 14.6 };

function evMkSleep_(o) {
  const m = x => x === null || x === undefined ? null : Math.round(x * 60);
  return { id: 'synthetic', day: dayStr_(0), type: o.type || 'long_sleep',
           bedtime_start: '2026-10-18T23:10:00+01:00', bedtime_end: '2026-10-19T07:00:00+01:00',
           total_sleep_duration: m(o.total), deep_sleep_duration: m(o.deep), rem_sleep_duration: m(o.rem),
           light_sleep_duration: m(Math.max(0, (o.total || 0) - (o.deep || 0) - (o.rem || 0))), awake_time: m(o.awake),
           efficiency: o.eff, latency: m(o.lat === undefined ? 12 : o.lat), average_hrv: o.hrv, lowest_heart_rate: o.lowHr,
           average_breath: o.breath, pieces: o.pieces || 1, partial: !!o.partial };
}
function evMkRoom_(o) {
  return { avgTemp: o.temp, minTemp: o.temp - 0.4, maxTemp: o.temp + 0.4, tempStdDev: o.std === undefined ? 0.3 : o.std,
           avgHumidity: o.hum === undefined ? 50 : o.hum, avgBrightness: 4, maxBrightness: 12, pctDark: o.dark === undefined ? 97 : o.dark,
           pctWindowOpen: o.win === undefined ? 0 : o.win, windowChanges: 0,
           avgCO2: o.co2 === null ? null : (o.co2avg || Math.round((o.co2 || 800) * 0.85)), maxCO2: o.co2 === null ? null : (o.co2 || 800),
           pctCO2High: o.co2 === null ? null : (o.co2pct || 0), readingsCount: 240 };
}

const EV_NORMAL_SLEEP = { total: 452, deep: 88, rem: 118, awake: 44, eff: 89, hrv: 43, lowHr: 55, breath: 14.6 };
const EV_FINE_ROOM    = { temp: 18.4, hum: 50, co2: 820, co2pct: 0, win: 0 };
function evS_(o) { return evMkSleep_(Object.assign({}, EV_NORMAL_SLEEP, o)); }
function evR_(o) { return evMkRoom_(Object.assign({}, EV_FINE_ROOM, o)); }

function evalSyntheticCases_() {
  const B = EVAL_BASE;
  return [
    // S: one clear situation each
    { id: 'S01_all_normal',          group: 'synthetic', note: 'everything normal',                 sleep: evS_({}), room: evR_({}), base: B },
    { id: 'S02_hot_body_worse',      group: 'synthetic', note: 'hot room, HRV/deep/HR worse',      sleep: evS_({ total: 410, deep: 52, rem: 85, awake: 70, eff: 84, hrv: 33, lowHr: 60 }), room: evR_({ temp: 23.4, hum: 45, co2: 900, co2pct: 5 }), base: B },
    { id: 'S03_hot_body_fine',       group: 'synthetic', note: 'hot room, body held up',           sleep: evS_({}), room: evR_({ temp: 22.6 }), base: B },
    { id: 'S04_stuffy_body_worse',   group: 'synthetic', note: 'CO2 high, awake/efficiency worse', sleep: evS_({ total: 420, awake: 85, eff: 80, breath: 15.4 }), room: evR_({ temp: 19.2, hum: 55, co2: 1650, co2avg: 1280, co2pct: 78, win: 0 }), base: B },
    { id: 'S05_stuffy_body_fine',    group: 'synthetic', note: 'CO2 high, body fine',              sleep: evS_({}), room: evR_({ co2: 1500, co2pct: 60 }), base: B },
    { id: 'S06_cold',                group: 'synthetic', note: 'cold room, awake up',              sleep: evS_({ awake: 70, eff: 83, deep: 70 }), room: evR_({ temp: 14.8, hum: 48 }), base: B },
    { id: 'S07_hot_and_stuffy',      group: 'synthetic', note: 'hot and stuffy, body worse',       sleep: evS_({ total: 395, deep: 55, rem: 80, awake: 90, eff: 79, hrv: 31, lowHr: 61, breath: 15.5 }), room: evR_({ temp: 22.9, co2: 1720, co2pct: 85 }), base: B },
    { id: 'S08_window_open_night',   group: 'synthetic', note: 'window open all night, fresh air', sleep: evS_({ deep: 100 }), room: evR_({ temp: 16.3, co2: 610, co2pct: 0, win: 100 }), base: B },
    { id: 'S09_short_night_fine_room', group: 'synthetic', note: '5h sleep, room fine',            sleep: evS_({ total: 300, deep: 60, rem: 70, eff: 90, awake: 30 }), room: evR_({}), base: B },
    { id: 'S10_room_ok_body_bad',    group: 'synthetic', note: 'room perfect, body bad',           sleep: evS_({ total: 400, deep: 50, rem: 80, awake: 80, eff: 82, hrv: 30, lowHr: 62 }), room: evR_({}), base: B },
    // B: missing or contradictory input
    { id: 'B01_no_oura',             group: 'broken', note: 'no ring data, stuffy room',           sleep: null, room: evR_({ co2: 1450, co2pct: 55 }), base: B },
    { id: 'B02_no_room',             group: 'broken', note: 'no bedroom data',                     sleep: evS_({ deep: 60, hrv: 36 }), room: null, base: B },
    { id: 'B03_no_co2',              group: 'broken', note: 'CO2 sensor missing, warm room',       sleep: evS_({ deep: 65 }), room: evR_({ temp: 21.5, co2: null }), base: B },
    { id: 'B04_broken_night_piece',  group: 'broken', note: 'INC-001: 8 min piece, CO2 1399',      sleep: evS_({ type: 'sleep', partial: true, total: 8, deep: 1, rem: 0, awake: 42, eff: 16, hrv: 30, lowHr: 66, breath: 15 }), room: evR_({ temp: 20.0, hum: 69, co2: 1399, co2avg: 1300, co2pct: 100, win: 0 }), base: B },
    { id: 'B05_no_baseline',         group: 'broken', note: 'first nights, no usual yet',          sleep: evS_({ deep: 60 }), room: evR_({ temp: 22.1 }), base: null },
    { id: 'B06_reed_open_but_stuffy', group: 'broken', note: 'reed says open, CO2 says closed',    sleep: evS_({ awake: 70 }), room: evR_({ co2: 1550, co2pct: 70, win: 100 }), base: B },
    { id: 'B07_merged_broken_night', group: 'broken', note: 'INC-001 after merge: 2 pieces, 188 min', sleep: evS_({ type: 'long_sleep', pieces: 2, total: 188, deep: 48, rem: 36, awake: 236, eff: 44, hrv: 41, lowHr: 57 }), room: evR_({ temp: 20.0, hum: 68, co2: 1399, co2pct: 90 }), base: B },
    { id: 'B08_missed_night',        group: 'broken', note: 'no sleep at all, room recorded',      sleep: null, room: evR_({ temp: 18.9, co2: 900, co2pct: 0 }), base: B },
    // T: values that tempt mistakes
    { id: 'T01_co2_pct_rounds_to_30', group: 'trap', note: '29.6% shows as 30% but is below the 30% rule', sleep: evS_({ awake: 60 }), room: evR_({ co2: 1180, co2pct: 29.6 }), base: B },
    { id: 'T02_temp_20_04',          group: 'trap', note: '20.04 °C shows as 20.0 but counts as hot', sleep: evS_({ deep: 70 }), room: evR_({ temp: 20.04 }), base: B },
    { id: 'T03_zero_stages',         group: 'trap', note: 'zeros: 0 deep, 0 REM',                  sleep: evS_({ total: 240, deep: 0, rem: 0, awake: 60, eff: 80 }), room: evR_({}), base: B },
    { id: 'T04_many_numbers',        group: 'trap', note: 'everything off, many numbers',         sleep: evS_({ total: 350, deep: 45, rem: 70, awake: 95, eff: 78, hrv: 29, lowHr: 63, breath: 15.8 }), room: evR_({ temp: 23.8, hum: 72, co2: 1840, co2avg: 1460, co2pct: 92, dark: 60 }), base: B },
    { id: 'T05_all_better',          group: 'trap', note: 'cool, fresh, body better than usual',  sleep: evS_({ total: 470, deep: 110, rem: 130, awake: 30, eff: 93, hrv: 55, lowHr: 50 }), room: evR_({ temp: 17.5, co2: 700, co2pct: 0, win: 40 }), base: B }
  ];
}

// Real nights: "Oura Sleep" tab + bedroom stats for the sleep window (only nights with room data)
function evalRealCases_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OURA_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
  const sec = (v, k) => { const n = toNum(v); return n === null ? null : Math.round(n * k); };
  const items = rows.map(r => ({ id: r[0], day: Utilities.formatDate(new Date(r[1]), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    type: r[2], bedtime_start: r[3], bedtime_end: r[4],
    total_sleep_duration: sec(r[5], 3600), deep_sleep_duration: sec(r[6], 3600), rem_sleep_duration: sec(r[7], 3600),
    light_sleep_duration: sec(r[8], 3600), awake_time: sec(r[9], 60), efficiency: toNum(r[10]), latency: sec(r[11], 60),
    average_hrv: toNum(r[12]), lowest_heart_rate: toNum(r[13]), average_breath: toNum(r[14]) }))
    .filter(n => n.bedtime_start && n.bedtime_end);
  const days = {};
  items.forEach(n => { (days[n.day] = days[n.day] || []).push(n); });
  const out = [];
  Object.keys(days).sort().slice(-10).forEach(day => {
    const group = days[day];
    const endMs = Math.max(...group.map(n => new Date(n.bedtime_end).getTime()));
    const night = mergeNight_(group, endMs + 3600000);
    if (!night) return;
    const win = nightWindow_(night);
    const room = getRoomStatsForNight(win.sleepStart, win.sleepEnd);
    if (!room) return;
    out.push({ id: 'R_' + day, group: 'real', note: 'real night ' + day + (night.pieces > 1 ? ' (' + night.pieces + ' pieces)' : ''),
               sleep: night, room: room, base: ouraBaseline_(night.id) });
  });
  return out;
}

// Freeze cases into a tab: model input, template, verdicts — computed by code once
function evalsSetup() {
  const cases = evalRealCases_().concat(evalSyntheticCases_());
  const sh = evSheet_(EVAL_SHEETS.cases, ['CaseId', 'Group', 'Note', 'Suspect', 'LowSleep', 'BodyWorse', 'BodyJudged', 'DataText',
    'TplHeadline', 'TplSubline', 'TplWhy', 'TplTip', 'RelationsJSON', 'GuardJSON', 'InputJSON', 'TplChecksJSON'], true);
  const rows = cases.map(c => {
    const inp = dashInputs_({ sleep: c.sleep, room: c.room, readiness: null, daily: null }, c.base);
    const tplWhy = inp.relations.slice(0, 2).join('. ') + '.';
    const tplChecks = evalChecks_({ headline: inp.fb.headline, subline: inp.fb.subline, why: tplWhy, tip: inp.fb.tip },
                                  new Set(nemNumbers_(inp.dataText)), inp.guard, inp.suspect ? inp.suspect.key : 'no_room', inp.lowSleep);
    return [c.id, c.group, c.note, inp.suspect ? inp.suspect.key : 'no_room', inp.lowSleep, inp.guard.bodyWorse, inp.guard.bodyJudged,
            inp.dataText, inp.fb.headline, inp.fb.subline, tplWhy, inp.fb.tip,
            JSON.stringify(inp.relations), JSON.stringify(inp.guard),
            JSON.stringify({ sleep: c.sleep, room: c.room, base: c.base }).slice(0, 45000), JSON.stringify(tplChecks)];
  });
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Eval Cases: ' + rows.length + ' (' + cases.filter(c => c.group === 'real').length + ' real)');
  return rows.length;
}


// ---------- level 1 checks ----------

const EV_HEDGE = /\b(may|might|could|can|likely|possibly|perhaps|consistent with|coincides?|coinciding|suggests?|seems?|appears?|no clear link|shows no)\b/i;
const EV_TIP_TARGET = {
  heat:   /\b(radiator|heating|heat|thermostat|cool|fan|window|temperature|warm)\b/i,
  stuffy: /\b(window|air|ventilat\w*|fresh|open|vent)\b/i,
  cold:   /\b(warm|heat|heating|radiator|blanket|thermostat|layer)\b/i
};
const EV_ROOM_WORDS = { heat: /\b(hot|heat|warm|toasty)\b/i, stuffy: /\b(stuffy|stale|air|co2|co₂|airless)\b/i, cold: /\b(cold|chilly|cool|icy)\b/i };
const EV_STOCK = ["Your body coped — the room didn't.", 'Your body felt it.', "The room wasn't the problem tonight.", 'Room and body in sync.', 'Hot room, short night.'];

function evStr_(v) { return typeof v === 'string' ? v.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : null; }

// f = { headline, subline, why, tip } as strings or null. Returns { check: true / false / null (not applicable) }
function evalChecks_(f, allowed, guard, suspect, lowSleep) {
  const c = {};
  const nums = f.why ? nemNumbers_(f.why).filter(n => !allowed.has(n)) : [];
  c.numbers = f.why ? nums.length === 0 : null;
  c.invented = nums.join(' ');
  const shortOk = (t, max) => !!t && t.length <= max && !/\d/.test(t) && !/[\u0400-\u04FF]/.test(t) && !/\b(code|block|facts?|verdicts?)\b/i.test(t);
  c.format = shortOk(f.headline, 48) && shortOk(f.subline, 70) && shortOk(f.tip, 90) && !!f.why && f.why.length <= 480 && !/[\u0400-\u04FF]/.test(f.why);
  const sem = textProblems_(f, guard);
  c.body = !sem.some(x => x.indexOf('body_contradiction') === 0);
  c.no_cause = !sem.some(x => x.indexOf('cause') === 0 || x.indexOf('overclaim') === 0);
  const roomish = x => x.indexOf('room_contradiction') === 0 || x.indexOf('tip_contradiction') === 0;
  c.room = !sem.some(roomish);
  c.room_note = sem.filter(x => roomish(x) || /^(tip_mismatch|missed_no_link)/.test(x)).join(' | ');
  c.tip_action = !sem.some(x => x.indexOf('tip_mismatch') === 0);
  c.no_link = !sem.some(x => x.indexOf('missed_no_link') === 0);
  const needHedge = suspect && suspect !== 'none' && suspect !== 'no_room' && !lowSleep && guard.bodyJudged > 0;
  c.hedge = needHedge ? (!!f.why && EV_HEDGE.test(f.why)) : null;
  c.tip_target = EV_TIP_TARGET[suspect] && !lowSleep ? (!!f.tip && EV_TIP_TARGET[suspect].test(f.tip)) : null;
  // headline: with no suspect it must not blame the room; with a suspect it names it
  const head = (f.headline || '') + ' ' + (f.subline || '');
  if (suspect === 'none') c.headline_room = !Object.keys(EV_ROOM_WORDS).some(k => EV_ROOM_WORDS[k].test(f.headline || ''));
  else if (EV_ROOM_WORDS[suspect]) c.headline_room = EV_ROOM_WORDS[suspect].test(head);
  else c.headline_room = null;
  c.no_stock = EV_STOCK.indexOf((f.subline || '').trim()) < 0 && EV_STOCK.indexOf((f.headline || '').trim()) < 0;
  // hard = what the code must guarantee (otherwise the report is wrong); all = hard + quality
  c.hard = ['numbers', 'format', 'body', 'no_cause', 'room', 'tip_action', 'no_link'].every(k => c[k] !== false);
  const keys = ['numbers', 'format', 'body', 'no_cause', 'room', 'tip_action', 'no_link', 'hedge', 'tip_target', 'headline_room'];
  c.all = keys.every(k => c[k] !== false);
  return c;
}


// ---------- background run ----------

function startEvals() {
  evCheckVersion_();
  stopEvals();
  const n = evalsSetup();
  [EVAL_SHEETS.results, EVAL_SHEETS.judg].forEach(name => {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    if (sh) sh.clear();
  });
  const runId = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmm');
  evState_(null);                                    // forget the previous run, pick judges again
  const judges = evJudges_();
  evState_({ runId: runId, phase: 'gen', i: 0, n: n, judges: judges });
  ScriptApp.newTrigger('evalWorker').timeBased().everyMinutes(1).create();
  sendTelegramMessage('🧪 Evals started (' + n + ' cases × ' + EVAL_REPS + ' runs, then judges ' + judges.map(j => j.split('/')[1]).join(' + ') + ', both orders). I\'ll message you when done.');
  Logger.log('Evals ' + runId + ' started: ' + n + ' cases');
  evalWorker();
}

function stopEvals() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'evalWorker') ScriptApp.deleteTrigger(t); });
}

function evalsStatus() { Logger.log(JSON.stringify(evState_())); }

function evalWorker() {
  const lock = LockService.getDocumentLock();          // not the script lock: pollTelegram uses that one
  if (!lock.tryLock(500)) return;
  const t0 = Date.now();
  try {
    let st = evState_();
    if (!st || st.phase === 'done') { stopEvals(); return; }
    const cases = evCases_();

    while (Date.now() - t0 < EVAL_BUDGET_MS) {
      if (st.phase === 'gen') {
        const total = cases.length * EVAL_REPS;
        if (st.i >= total) { st.phase = 'judge'; st.i = 0; evState_(st); continue; }
        const c = cases[Math.floor(st.i / EVAL_REPS)], rep = st.i % EVAL_REPS + 1;
        evGenOne_(st.runId, c, rep);
        st.i++; evState_(st);
      } else if (st.phase === 'judge') {
        const J = st.judges, total = cases.length * J.length * 2;
        if (st.i >= total) { st.phase = 'summary'; evState_(st); continue; }
        const ci = Math.floor(st.i / (J.length * 2)), rest = st.i % (J.length * 2);
        evJudgeOne_(st.runId, cases[ci], J[Math.floor(rest / 2)], rest % 2 === 0 ? 'X' : 'Y');
        st.i++; evState_(st);
      } else if (st.phase === 'summary') {
        makeBlindReview();
        const s = summarizeEvals();
        st.phase = 'done'; evState_(st);
        stopEvals();
        sendTelegramMessage('🧪 Evals done (' + st.runId + ')\n' + s.short + '\nDetails: tab "Eval Summary". Your blind review: tab "Blind Review".');
        return;
      }
    }
  } catch (e) {
    Logger.log('evalWorker: ' + e + '\n' + (e.stack || ''));
  } finally { lock.releaseLock(); }
}

function evState_(v) {
  const p = PropertiesService.getScriptProperties();
  if (v === undefined) { const s = p.getProperty('EVAL_STATE'); return s ? JSON.parse(s) : null; }
  p.setProperty('EVAL_STATE', JSON.stringify(v));
}

function evCases_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVAL_SHEETS.cases);
  const v = sh.getDataRange().getValues(); v.shift();
  return v.filter(r => r[0]).map(r => ({ id: r[0], group: r[1], note: r[2], suspect: r[3], lowSleep: r[4] === true || r[4] === 'TRUE',
    dataText: r[7], tpl: { headline: r[8], subline: r[9], why: r[10], tip: r[11] },
    relations: JSON.parse(r[12]), guard: JSON.parse(r[13]), tplChecks: r[15] ? JSON.parse(r[15]) : null }));
}

function evSheet_(name, headers, reset) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (reset) sh.clear();
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); sh.getRange(1, 1, 1, headers.length).setFontWeight('bold'); }
  return sh;
}

const EV_RESULT_HEADERS = ['RunId', 'Time', 'CaseId', 'Group', 'Rep', 'Status', 'Attempts', 'Ms',
  'First_hard', 'First_all', 'First_numbers', 'First_invented', 'First_format', 'First_body', 'First_no_cause', 'First_room', 'First_tip_action', 'First_no_link', 'First_room_note', 'First_hedge', 'First_tip', 'First_headline_room', 'First_no_stock', 'First_problems',
  'Final_hard', 'Final_all', 'Final_numbers', 'Final_format', 'Final_body', 'Final_no_cause', 'Final_room', 'Final_tip_action', 'Final_no_link', 'Final_hedge', 'Final_tip', 'Final_headline_room',
  'Headline', 'Subline', 'Why', 'Tip', 'FirstHeadline', 'FirstSubline', 'FirstWhy', 'FirstTip'];

function evGenOne_(runId, c, rep) {
  const fb = { headline: c.tpl.headline, subline: c.tpl.subline, tip: c.tpl.tip };
  const out = dashTexts_(c.dataText, fb, c.relations, c.guard);
  const allowed = new Set(nemNumbers_(c.dataText));
  const r1 = out.rawFirst || {};
  const first = { headline: evStr_(r1.headline), subline: evStr_(r1.subline), why: evStr_(r1.why), tip: evStr_(r1.tip) };
  const final = { headline: out.headline, subline: out.subline, why: out.why, tip: out.tip };
  const a = evalChecks_(first, allowed, c.guard, c.suspect, c.lowSleep);
  const b = evalChecks_(final, allowed, c.guard, c.suspect, c.lowSleep);
  const modelOk = out.status !== 'api_error' && out.status !== 'no_model';
  const sh = evSheet_(EVAL_SHEETS.results, EV_RESULT_HEADERS, false);
  const yn = x => x === null || x === undefined ? '' : x;
  sh.appendRow([runId, new Date(), c.id, c.group, rep, out.status, out.attempts, out.ms,
    modelOk ? a.hard : '', modelOk ? a.all : '', modelOk ? yn(a.numbers) : '', a.invented ? "'" + a.invented : '', modelOk ? a.format : '', modelOk ? a.body : '', modelOk ? a.no_cause : '', modelOk ? a.room : '', modelOk ? a.tip_action : '', modelOk ? a.no_link : '', a.room_note,
    modelOk ? yn(a.hedge) : '', modelOk ? yn(a.tip_target) : '', modelOk ? yn(a.headline_room) : '', modelOk ? a.no_stock : '', (out.problemsFirst || []).join('; '),
    b.hard, b.all, yn(b.numbers), b.format, b.body, b.no_cause, b.room, b.tip_action, b.no_link, yn(b.hedge), yn(b.tip_target), yn(b.headline_room),
    final.headline, final.subline, final.why, final.tip, first.headline || '', first.subline || '', first.why || '', first.tip || '']);
}


// ---------- level 3: judge models ----------

const EV_JUDGE_SYSTEM =
  'You are an impartial evaluator of short morning sleep reports sent to one person in Telegram. ' +
  'The INPUT and VERDICTS were computed by code from a bedroom sensor and an Oura ring; treat them as ground truth. ' +
  'You will see two candidate reports, X and Y, for the same night. Score EACH from 1 (bad) to 5 (excellent) on: ' +
  'accuracy — states only things supported by INPUT and VERDICTS, numbers correct, no contradiction (including about how the body did); ' +
  'explanation — helps the reader understand how the room and the body connect tonight, or honestly says the night cannot be judged; ' +
  'actionability — the tip is concrete and fits the main problem; ' +
  'clarity — short, plain English, easy to read on a phone; ' +
  'honesty — single-night claims are hedged, no invented causes, missing or insufficient data is admitted. ' +
  'Then choose the better report overall: "X", "Y" or "tie". Do not prefer a report for being longer. ' +
  'Reply with JSON only: {"x":{"accuracy":0,"explanation":0,"actionability":0,"clarity":0,"honesty":0},' +
  '"y":{"accuracy":0,"explanation":0,"actionability":0,"clarity":0,"honesty":0},"winner":"X","reason":"one short sentence"}';
const EV_CRIT = ['accuracy', 'explanation', 'actionability', 'clarity', 'honesty'];

function evReportText_(t) { return 'headline: ' + t.headline + '\nsubline: ' + t.subline + '\ntip: ' + t.tip + '\nwhy: ' + t.why; }

function evJudgeCall_(judge, user, system) {
  const tries = [{ temperature: 0, chat_template_kwargs: { enable_thinking: false } }, { temperature: 0 }];
  for (let k = 0; k < tries.length; k++) {
    const t0 = Date.now();
    const r = nebiusChat_(judge, system || EV_JUDGE_SYSTEM, user, 600, tries[k]);
    if (!r || !r.text) continue;
    const txt = r.text.replace(/<think>[\s\S]*?<\/think>/g, '');
    try {
      const j = JSON.parse((txt.match(/\{[\s\S]*\}/) || [''])[0]);
      if (j && j.x && j.y && j.winner) return { j: j, ms: Date.now() - t0 };
    } catch (e) { /* try again */ }
    user += '\n\nReply with the JSON object only.';
  }
  return null;
}

// The model's answer for a pair: first repetition of the case
function evAiText_(runId, caseId) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVAL_SHEETS.results);
  const v = sh.getDataRange().getValues(); const h = v.shift();
  const ix = k => h.indexOf(k);
  const row = v.filter(r => r[ix('RunId')] === runId && r[ix('CaseId')] === caseId).sort((a, b) => a[ix('Rep')] - b[ix('Rep')])[0];
  if (!row) return null;
  return { status: row[ix('Status')], headline: row[ix('Headline')], subline: row[ix('Subline')], why: row[ix('Why')], tip: row[ix('Tip')] };
}

function evJudgeOne_(runId, c, judge, aiSide) {
  const ai = evAiText_(runId, c.id);
  if (!ai) return;
  const tpl = c.tpl;
  const sh = evSheet_(EVAL_SHEETS.judg, ['RunId', 'Time', 'CaseId', 'Group', 'Judge', 'AiAs', 'AiStatus', 'WinnerRaw', 'Winner',
    'AI_accuracy', 'AI_explanation', 'AI_actionability', 'AI_clarity', 'AI_honesty',
    'TPL_accuracy', 'TPL_explanation', 'TPL_actionability', 'TPL_clarity', 'TPL_honesty', 'Reason', 'Ms', 'Identical'], false);
  const identical = ['headline', 'subline', 'why', 'tip'].every(k => String(ai[k]).trim() === String(tpl[k]).trim());
  if (identical) {                                     // model failed completely, template shown: nothing to compare
    sh.appendRow([runId, new Date(), c.id, c.group, judge, aiSide, ai.status, '', 'identical', '', '', '', '', '', '', '', '', '', '', 'AI output fell back to the template', 0, true]);
    return;
  }
  const X = aiSide === 'X' ? ai : tpl, Y = aiSide === 'X' ? tpl : ai;
  const user = c.dataText + '\n\nREPORT X\n' + evReportText_(X) + '\n\nREPORT Y\n' + evReportText_(Y) + '\n\nJudge now.';
  const res = evJudgeCall_(judge, user);
  if (!res) { sh.appendRow([runId, new Date(), c.id, c.group, judge, aiSide, ai.status, 'error', 'error']); return; }
  const j = res.j, w = String(j.winner).trim().toUpperCase();
  const winner = w === 'TIE' ? 'tie' : w === aiSide ? 'ai' : (w === 'X' || w === 'Y') ? 'template' : 'error';
  const sAi = aiSide === 'X' ? j.x : j.y, sTpl = aiSide === 'X' ? j.y : j.x;
  const n = (o, k) => { const x = Number(o && o[k]); return isNaN(x) ? '' : x; };
  sh.appendRow([runId, new Date(), c.id, c.group, judge, aiSide, ai.status, j.winner, winner]
    .concat(EV_CRIT.map(k => n(sAi, k))).concat(EV_CRIT.map(k => n(sTpl, k)))
    .concat([String(j.reason || '').slice(0, 300), res.ms, false]));
}


// ---------- blind review for a human ----------

function makeBlindReview() {
  const st = evState_(); if (!st) return;
  const cases = evCases_();
  const sh = evSheet_(EVAL_SHEETS.blind, ['CaseId', 'What happened (code)', 'Report 1', 'Report 2', 'Better? (1 / 2 / tie)', 'Comment', 'Key'], true);
  const rows = [];
  cases.forEach(c => {
    const ai = evAiText_(st.runId, c.id); if (!ai) return;
    const fmt = t => t.headline + '\n' + t.subline + '\n\nTonight: ' + t.tip + '\n\nWhy? ' + t.why;
    const flip = evHash_(c.id + st.runId) % 2 === 1;                 // pseudo-random but reproducible order
    const verdicts = String(c.dataText).split('VERDICTS')[1] || '';
    rows.push([c.id, verdicts.trim().slice(0, 1500), fmt(flip ? c.tpl : ai), fmt(flip ? ai : c.tpl), '', '', flip ? '2=AI' : '1=AI']);
  });
  if (rows.length) sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidths(2, 3, 360);
  sh.hideColumns(7);
  Logger.log('Blind Review: ' + rows.length + ' pairs. Fill column E with 1, 2 or tie, then run summarizeEvals()');
}

function evHash_(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }


// ---------- summary ----------

function summarizeEvals() {
  const st = evState_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const res = evRows_(EVAL_SHEETS.results).filter(r => !st || r.RunId === st.runId);
  const jud = evRows_(EVAL_SHEETS.judg).filter(r => !st || r.RunId === st.runId);
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  const rate = (rows, k) => { const v = rows.filter(r => r[k] === true || r[k] === false); return { ok: v.filter(r => r[k] === true).length, n: v.length }; };
  const out = [['Metric', 'Value', 'Notes', '']];
  const add = (m, v, note) => out.push([m, v, note || '', '']);

  const modelRows = res.filter(r => r.Status !== 'api_error' && r.Status !== 'no_model');
  add('Run', st ? st.runId : '', 'Code_v3.gs ' + CODE_VERSION);
  add('Cases', new Set(res.map(r => r.CaseId)).size, 'real + synthetic + broken input + traps');
  add('Model runs', res.length, EVAL_REPS + ' runs per case');
  const sc = {}; res.forEach(r => sc[r.Status] = (sc[r.Status] || 0) + 1);
  add('AI status', Object.keys(sc).map(k => k + ' ' + sc[k]).join(' · '), 'ok = all 4 fields from Nemotron');
  add('Retry needed', pct(res.filter(r => Number(r.Attempts) === 2).length, modelRows.length), 'first answer failed a check');

  // Level 1 as one table: template · Nemotron first answer · shown to user
  out.push(['', '', '', '']);
  out.push(['LEVEL 1 — automatic checks', 'Template (no AI)', 'Nemotron, first answer', 'Shown to user']);
  const cases = evCases_();
  const tplRows = res.filter(r => r.Rep === 1 || r.Rep === '1').map(r => { const c = cases.find(x => x.id === r.CaseId); return c && c.tplChecks; }).filter(Boolean);
  const tRate = k => { const v = tplRows.filter(c => c[k] === true || c[k] === false); return pct(v.filter(c => c[k] === true).length, v.length); };
  const fRate = (rows, k) => { const q = rate(rows, k); return pct(q.ok, q.n) + ' (' + q.ok + '/' + q.n + ')'; };
  [['hard', 'Hard: no lies (numbers, format, body, causes, room, tip action, no-link)'], ['all', 'Everything incl. quality'],
   ['numbers', 'No invented numbers in "why"'], ['format', 'Format (length, no digits, English)'],
   ['body', 'Does not contradict the body verdict'], ['no_cause', 'No causal overclaim'],
   ['room', 'Room direction right (humidity, heat, air, light)'],
   ['tip_action', 'Tip gives the action the code chose'], ['no_link', 'Says so when there is no room-body link'],
   ['hedge', 'Hedges single-night claims'], ['tip_target', 'Tip targets the main suspect'],
   ['headline_room', 'Headline names the right room problem']]
    .forEach(x => out.push([x[1], tRate(x[0]), fRate(modelRows, 'First_' + (x[0] === 'tip_target' ? 'tip' : x[0])), fRate(res, 'Final_' + (x[0] === 'tip_target' ? 'tip' : x[0]))]));
  const stock = rate(modelRows, 'First_no_stock');
  add('Nemotron writes its own words (no stock phrase)', pct(stock.ok, stock.n), stock.ok + ' / ' + stock.n);
  const inv = modelRows.filter(r => String(r.First_invented || '').trim());
  add('Nemotron first answers with invented numbers', inv.length + ' / ' + modelRows.length, inv.slice(0, 5).map(r => r.CaseId + ': ' + r.First_invented).join(' | '));

  out.push(['', '', '', '']); add('LEVEL 2 — stability (' + EVAL_REPS + ' runs per case)', '', '');
  const byCase = {}; res.forEach(r => (byCase[r.CaseId] = byCase[r.CaseId] || []).push(r));
  const ids = Object.keys(byCase);
  add('Same AI status in every run', pct(ids.filter(id => new Set(byCase[id].map(r => r.Status)).size === 1).length, ids.length), '');
  add('Every run passes all final checks', pct(ids.filter(id => byCase[id].every(r => r.Final_all === true)).length, ids.length), '');
  add('Every run passes all first-answer checks', pct(ids.filter(id => byCase[id].every(r => r.First_all === true)).length, ids.length), 'how reliable Nemotron is without the safety net');

  out.push(['', '', '', '']); add('LEVEL 3 — usefulness vs template (blind judges, both orders)', '', '');
  const JUDGES = (st && st.judges) || [...new Set(jud.map(r => r.Judge))];
  const verdicts = {};                                         // case|judge → verdicts in both orders
  jud.forEach(r => { const k = r.CaseId + '|' + r.Judge; (verdicts[k] = verdicts[k] || []).push(r.Winner); });
  let allConsistent = 0, allPairs = 0;
  JUDGES.forEach(judge => {
    const ks = Object.keys(verdicts).filter(k => k.split('|')[1] === judge);
    let ai = 0, tpl = 0, tie = 0, incons = 0, ident = 0, err = 0;
    ks.forEach(k => {
      const v = verdicts[k];
      if (v.indexOf('identical') >= 0) { ident++; return; }
      if (v.indexOf('error') >= 0 || v.length < 2) { err++; return; }
      allPairs++;
      if (v[0] === v[1]) { allConsistent++; if (v[0] === 'ai') ai++; else if (v[0] === 'template') tpl++; else tie++; }
      else { incons++; tie++; }
    });
    const n = ai + tpl + tie;
    add(judge + ': Nemotron wins', pct(ai, n), ai + ' / ' + n + ' (both orders agree)');
    add(judge + ': template wins', pct(tpl, n), tpl + ' / ' + n);
    add(judge + ': tie / order-dependent', pct(tie, n), tie + ' / ' + n + ' (' + incons + ' changed with order)');
    if (ident || err) add(judge + ': skipped', ident + ' identical, ' + err + ' errors', '');
    EV_CRIT.forEach(k => {
      const a = jud.filter(r => r.Judge === judge && r['AI_' + k] !== ''), b = jud.filter(r => r.Judge === judge && r['TPL_' + k] !== '');
      const m = (rows, col) => rows.length ? (rows.reduce((s, r) => s + Number(r[col]), 0) / rows.length).toFixed(2) : '—';
      add(judge + ': ' + k + ' (AI vs template)', m(a, 'AI_' + k) + ' vs ' + m(b, 'TPL_' + k), '1–5');
    });
  });
  add('Judge self-consistency', pct(allConsistent, allPairs), 'same verdict when X/Y are swapped');
  // agreement between judges (cases with a stable verdict from both)
  let agree = 0, both = 0;
  ids.forEach(id => {
    const v = JUDGES.map(j => verdicts[id + '|' + j]).filter(x => x && x.length === 2 && x[0] === x[1] && x[0] !== 'identical' && x[0] !== 'error');
    if (v.length === 2) { both++; if (v[0][0] === v[1][0]) agree++; }
  });
  add('Judges agree with each other', pct(agree, both), agree + ' / ' + both + ' cases with a stable verdict from both');
  // Nemotron win rate by group (both judges, stable verdicts)
  ['real', 'synthetic', 'broken', 'trap'].forEach(g => {
    const ks = Object.keys(verdicts).filter(k => { const r = jud.find(x => x.CaseId === k.split('|')[0]); return r && r.Group === g; });
    const st2 = ks.map(k => verdicts[k]).filter(v => v.length === 2 && v[0] === v[1] && ['ai', 'template', 'tie'].indexOf(v[0]) >= 0);
    if (st2.length) add('Nemotron wins — ' + g, pct(st2.filter(v => v[0] === 'ai').length, st2.length), st2.length + ' stable verdicts');
  });

  // human blind review
  const blind = evRows_(EVAL_SHEETS.blind).filter(r => String(r['Better? (1 / 2 / tie)']).trim());
  if (blind.length) {
    out.push(['', '', '', '']); add('LEVEL 3 — Julia, blind', '', '');
    let ai = 0, tpl = 0, tie = 0;
    blind.forEach(r => {
      const pick = String(r['Better? (1 / 2 / tie)']).trim().toLowerCase(), aiNum = String(r.Key).charAt(0);
      if (pick === 'tie') tie++; else if (pick === aiNum) ai++; else tpl++;
    });
    add('Julia prefers Nemotron', pct(ai, blind.length), ai + ' / ' + blind.length);
    add('Julia prefers template', pct(tpl, blind.length), tpl + ' / ' + blind.length);
    add('Julia: tie', pct(tie, blind.length), tie + ' / ' + blind.length);
  }

  const sh = evSheet_(EVAL_SHEETS.sum, ['Metric', 'Value', 'Notes', ''], true);
  sh.getRange(1, 1, out.length, 4).setValues(out);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.setColumnWidth(1, 420); sh.setColumnWidth(2, 170); sh.setColumnWidth(3, 260); sh.setColumnWidth(4, 200);

  const get = name => (out.find(r => r[0] === name) || [])[1];
  const row = name => out.find(r => r[0] === name) || [];
  const hard = row('Hard: no lies (numbers, format, body, causes, room, tip action, no-link)');
  const short = [
    'No-lies checks — template ' + hard[1] + ' · Nemotron alone ' + String(hard[2]).split(' ')[0] + ' · shown to you ' + String(hard[3]).split(' ')[0],
    'Invented numbers in Nemotron first answers: ' + get('Nemotron first answers with invented numbers') + ' (all caught before you saw them)',
    JUDGES.map(j => j.split('/')[1] + ': Nemotron wins ' + get(j + ': Nemotron wins') + ', template ' + get(j + ': template wins')).join('\n'),
    'Judge self-consistency ' + get('Judge self-consistency') + ' · judges agree ' + get('Judges agree with each other'),
    get('Julia prefers Nemotron') ? 'Julia, blind: Nemotron ' + get('Julia prefers Nemotron') + ' · template ' + get('Julia prefers template') + ' · tie ' + get('Julia: tie') : 'Julia, blind: not filled yet'
  ].join('\n');
  Logger.log(short);
  return { rows: out, short: short };
}

function evRows_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues(); const h = v.shift();
  return v.map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; });
}


// ---------- quick check before a full run ----------
// 2 cases: one Nemotron answer and one verdict from each judge, log only.
// Look for: clean JSON from the judges, no <think>, sensible timing.
function evCheckVersion_() {
  const v = (typeof CODE_VERSION === 'undefined') ? null : CODE_VERSION;
  // v3.0.0: the report code moved to Code_v3.gs; the checks and the model step are the same as in 2.3.0,
  // and the eval cases carry no 5-minute ring data, so they exercise the same path as before
  if (v !== '3.0.0') throw new Error('Code_v3.gs is outdated (' + (v || 'no version') + '). Paste the latest Code_v3.gs (3.0.0) first.');
  Logger.log('Code_v3.gs version ' + v + ' ✅');
}

function evalsQuickCheck() {
  evCheckVersion_();
  const pick = ['S04_stuffy_body_worse', 'B04_broken_night_piece'];
  const cases = evalSyntheticCases_().filter(c => pick.indexOf(c.id) >= 0);
  cases.forEach(c => {
    const inp = dashInputs_({ sleep: c.sleep, room: c.room, readiness: null, daily: null }, c.base);
    const tpl = { headline: inp.fb.headline, subline: inp.fb.subline, tip: inp.fb.tip, why: inp.relations.slice(0, 2).join('. ') + '.' };
    const out = dashTexts_(inp.dataText, inp.fb, inp.relations, inp.guard);
    const checks = evalChecks_({ headline: evStr_((out.rawFirst || {}).headline), subline: evStr_((out.rawFirst || {}).subline),
                                 why: evStr_((out.rawFirst || {}).why), tip: evStr_((out.rawFirst || {}).tip) },
                               new Set(nemNumbers_(inp.dataText)), inp.guard, inp.suspect ? inp.suspect.key : 'no_room', inp.lowSleep);
    Logger.log('=== ' + c.id + ' · status ' + out.status + ' · attempts ' + out.attempts + ' · ' + out.ms + ' ms');
    Logger.log('first answer: ' + JSON.stringify(out.rawFirst));
    Logger.log('first-answer checks: ' + JSON.stringify(checks));
    Logger.log('shown: ' + JSON.stringify({ headline: out.headline, subline: out.subline, why: out.why, tip: out.tip }));
    Logger.log('template: ' + JSON.stringify(tpl));
    evJudges_().forEach(judge => {
      const user = inp.dataText + '\n\nREPORT X\n' + evReportText_(out) + '\n\nREPORT Y\n' + evReportText_(tpl) + '\n\nJudge now.';
      const r = evJudgeCall_(judge, user);
      Logger.log('judge ' + judge + (r ? ' (' + r.ms + ' ms, Nemotron = X): ' + JSON.stringify(r.j) : ': NO VALID JSON'));
    });
  });
}


// ---------- Ask your room: questions answered by Nemotron vs the data a bot without AI could send ----------
// askEvals(): 12 questions on the real nights, each answered once, both judges, both orders → "Ask Evals" tab + Telegram

const ASK_QUESTIONS = [
  ['how_last_night', 'How did I sleep last night?'],
  ['window_helps', 'Does opening the window help my sleep?'],
  ['too_warm', 'Is my bedroom too warm for sleep?'],
  ['best_deep', 'Which night had the most deep sleep, and what was the room like?'],
  ['friday_rem', 'Why was my REM low on Friday?'],
  ['stuffy', 'Does stuffy air affect my sleep?'],
  ['tonight', 'What should I change in my bedroom tonight?'],
  ['best_worst', 'Compare my best and worst night.'],
  ['hrv_trend', 'Is my HRV getting better?'],
  ['ru_saturday', '\u041f\u043e\u0447\u0435\u043c\u0443 \u044f \u043f\u043b\u043e\u0445\u043e \u0441\u043f\u0430\u043b\u0430 \u0432 \u0441\u0443\u0431\u0431\u043e\u0442\u0443?'],   // Russian: "Why did I sleep badly on Saturday?" (answer must be in Russian)
  ['future', 'What will my sleep score be tomorrow?'],
  ['medical', 'Should I take melatonin?']
];

const ASK_JUDGE_SYSTEM =
  'You are an impartial evaluator of answers a sleep assistant gives in a Telegram chat to one person about their own nights. ' +
  'The NIGHTS and COMPARISONS were computed by code from a bedroom sensor and an Oura ring; treat them as ground truth. ' +
  'You see the QUESTION and two candidate answers, X and Y. Score EACH from 1 to 5 on: ' +
  'accuracy — states only what the data supports, numbers correct; helpfulness — actually answers the question in a way the person can use; ' +
  'honesty — says when the data is not enough, hedges single nights, no medical claims; clarity — short, plain, readable on a phone. ' +
  'Then choose the better answer overall: "X", "Y" or "tie". Do not prefer an answer for being longer. ' +
  'Reply with JSON only: {"x":{"accuracy":0,"helpfulness":0,"honesty":0,"clarity":0},"y":{"accuracy":0,"helpfulness":0,"honesty":0,"clarity":0},"winner":"X","reason":"one short sentence"}';
const ASK_CRIT = ['accuracy', 'helpfulness', 'honesty', 'clarity'];

function askEvals() {
  evCheckVersion_();
  const t0 = Date.now();
  const ctx = askContext_();
  const judges = evJudges_();
  const baseline = 'Here is your data:\n' + ctx.comps.join('\n') + '\n\nLast nights:\n' + ctx.lines.slice(-7).join('\n');
  const sh = evSheet_('Ask Evals', ['Time', 'Id', 'Question', 'Status', 'Attempts', 'Problems', 'Ms', 'Answer', 'Judge', 'AiAs', 'Winner',
    'AI_accuracy', 'AI_helpfulness', 'AI_honesty', 'AI_clarity', 'NOAI_accuracy', 'NOAI_helpfulness', 'NOAI_honesty', 'NOAI_clarity', 'Reason'], true);
  const verdicts = {};
  ASK_QUESTIONS.forEach(q => {
    if (Date.now() - t0 > 300000) return;                                        // stay under the 6-minute limit
    const a = askAnswer_(q[1], ctx);
    judges.forEach(judge => ['X', 'Y'].forEach(side => {
      const X = side === 'X' ? a.text : baseline, Y = side === 'X' ? baseline : a.text;
      const user = ctx.dataText + '\n\nQUESTION: ' + q[1] + '\n\nANSWER X\n' + X + '\n\nANSWER Y\n' + Y + '\n\nJudge now.';
      const r = evJudgeCall_(judge, user, ASK_JUDGE_SYSTEM);
      let win = 'error', sa = {}, sb = {}, reason = '';
      if (r) {
        const w = String(r.j.winner).trim().toUpperCase();
        win = w === 'TIE' ? 'tie' : w === side ? 'ai' : (w === 'X' || w === 'Y') ? 'noai' : 'error';
        sa = side === 'X' ? r.j.x : r.j.y; sb = side === 'X' ? r.j.y : r.j.x; reason = String(r.j.reason || '').slice(0, 300);
      }
      (verdicts[q[0] + '|' + judge] = verdicts[q[0] + '|' + judge] || []).push(win);
      const n = (o, k) => { const x = Number(o && o[k]); return isNaN(x) ? '' : x; };
      sh.appendRow([new Date(), q[0], q[1], a.status, a.attempts, a.problems.join('; '), a.ms, a.text, judge, side, win]
        .concat(ASK_CRIT.map(k => n(sa, k))).concat(ASK_CRIT.map(k => n(sb, k))).concat([reason]));
    }));
  });
  const lines = ['🗣 Ask-your-room evals: ' + ASK_QUESTIONS.length + ' questions, ' + ctx.nights.length + ' nights of data'];
  judges.forEach(judge => {
    let ai = 0, noai = 0, tie = 0;
    Object.keys(verdicts).filter(k => k.split('|')[1] === judge).forEach(k => {
      const v = verdicts[k];
      if (v.length === 2 && v[0] === v[1] && v[0] !== 'error') { if (v[0] === 'ai') ai++; else if (v[0] === 'noai') noai++; else tie++; } else tie++;
    });
    lines.push(judge.split('/')[1] + ': Nemotron ' + ai + ' · data only ' + noai + ' · tie ' + tie);
  });
  Logger.log(lines.join('\n'));
  sendTelegramMessage(lines.join('\n') + '\nDetails: tab "Ask Evals".');
}
