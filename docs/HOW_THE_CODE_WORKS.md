# How the code works

Three programs and one Google Sheet. The firmware writes rows, Apps Script turns them into a morning report,
`Evals.gs` measures that report. Every function named below can be found with Ctrl+F in its file.

```
ESP32 ── POST ──▶ doPost ──▶ Sensor Data tab
                                  │
Oura API ◀─ morningCheck (every 30 min) ─▶ night window + room statistics for it
                                  │
          RING × ROOM: every 5-minute ring point (pulse, HRV, stage) + the room in the same minutes
                                  │
          code: verdicts · links · main suspect · tip action · correct draft
                                  │
          Nemotron rewrites the draft ─▶ code checks every field ─▶ 1 retry ─▶ per-field fallback
                                  │
          Telegram: dashboard + night chart ─▶ Sleep Report tab, Run Log tab
```

The rule behind every step: **code calculates and decides, the model only explains, the reed switch verifies.**

## 1. Firmware — `esp32/room_intelligence_v2/room_intelligence_v2.ino`

| Function | What it does |
|---|---|
| `loop()` | polls the reed switch (~50×/s) and the CO₂ sensor; sends a row every 2 minutes (`LOG_INTERVAL_MS`) and **immediately** when the window opens or closes |
| `pollReed()` | debounced (50 ms) window state; the contact is the ground truth for the window |
| `pollCO2()` | reads the SCD41 about every 5.5 s and keeps the last valid value |
| `maybeCalibrateCO2()` | when the window has been open ≥ 15 min and CO₂ is ≤ 700 ppm, calibrates to 420 ppm (outdoor air) — at most once in 30 days, the date survives reboots |
| `readNoiseSwing()` | KY-038: signal swing (max − min) over ~1 s — a relative noise level |
| `readBrightness()` | the camera frame is read **only as an average brightness number**; no image leaves the board |
| `logRoom(why)` | reads DHT22, builds the JSON (a sensor that did not answer is sent as `null`) and POSTs it to the Apps Script web app |

## 2. Apps Script — `apps-script/Code_v3.gs` (3.0.0)

| Step | Functions | What happens |
|---|---|---|
| **Receive** | `doPost`, `setupSensorHeaders` | checks the optional `SECRET_KEY`, appends one row to the `Sensor Data` tab |
| **Oura** | `getOuraService`, `authorize`, `ouraGet_`, `getOuraSleep`, `mergeNight_`, `getOuraDailySleep`, `saveOuraSleepToSheet`, `ouraBaseline_` | OAuth2; sleep pieces of one night are merged (INC-001); sleep score; the personal baseline from the last nights |
| **Room statistics** | `nightWindow_`, `getRoomStatsForNight`, `rowWindowState_`, `calculateRoomScore` | the night window comes from Oura's bedtime; temperature, humidity, CO₂, noise, darkness and window-open share for that window |
| **Ring × room (v3)** | `ringSeries_`, `fusePoints_`, `cmpStretch_`, `fusionNight_`, `fusionMap_`, `fusionHistory_`, `fusionForNight_`, `fusionFindings_` | Oura's 5-minute heart rate, HRV and sleep stage, each point joined with the bedroom readings within ±3 min; tonight vs your other nights (stage by stage), warm and stuffy minutes vs the same sleep stages the rest of the night, your map (HRV and pulse by room temperature), how often warm minutes went with a worse body; history in the `Fusion 5min` tab |
| **Proof** | `fusionBacktest` | rebuilds the history from Oura and checks 34 numbers on 7 real nights against an independent calculation |
| **Code decides** | `metricRows_`, `enRoomVerdicts_`, `enRelations_`, `mainSuspect_`, `tipActions_`, `noLink_`, `fallbackTexts_` | "you vs your usual" verdicts, room↔body links (from the 5-minute data when it exists, otherwise from nightly averages, or "no clear link"), the main suspect (heat / stuffy air / cold / none; heat is dropped when your own data shows these temperatures are fine for you), the action behind tonight's tip, a complete report written by code |
| **Nemotron** | `dashTexts_`, `nebiusChat_` | sends the code's draft and facts to `nvidia/Nemotron-3_5-Lightning` on Token Factory (reasoning off), asks for JSON `headline`, `subline`, `why`, `tip` |
| **Checks** | `nemNumbers_`, `textProblems_`, `roomWrong_`, `tipMismatch_`, `tipWrong_` | number whitelist, format, body and room direction, tip carries the code's action, no causes on thin data; one retry with the list of problems, then each bad field is replaced by the code's text |
| **Report** | `dashContext_`, `dashInputs_`, `buildDashboard_`, `nightSeries_`, `renderNightChart_`, `sendTelegramHtml_`, `sendTelegramPhoto_`, `appendSleepReportRow_` | HTML dashboard led by **YOU × YOUR ROOM** and **YOUR MAP** (room-only and body-only numbers under "Details"), night chart (CO₂, temperature, window, **your HRV**, Oura sleep stages on one time axis; rendered by QuickChart), a row in `Sleep Report` |
| **Schedule** | `setupTrigger`, `morningCheck`, `sendDailyReport` | every 30 min after 06:00: send when Oura's night and sleep score are ready, or at 12:00 with what exists; once per day (`LAST_REPORT_DAY`) |
| **Telegram commands** | `setupCommands`, `pollTelegram`, `handleCommand_`, `statusText_` | polling once a minute (no webhook); only the chat in `TELEGRAM_CHAT_ID` is accepted; `/report`, `/skip`, `/status`, `/help` |
| **Log** | `logRun_` | one row per report and per command in the `Run Log` tab: sleep pieces, night window, AI status, problems |
| **Setup and tests** | `checkSetup`, `testTelegram`, `testNemotron`, `nebiusListModels`, `sendDashboardDemo` | what is missing (never prints key values); a demo report without waiting for the morning |

**AI status** written to `Sleep Report` / `Run Log`: `ok` (all four fields from Nemotron), `partial` (some fields replaced by code),
`rejected`, `fallback`, `api_error`, `no_model`. The report goes out in every case.

### "Ask your room" — in progress, not deployed, not evaluated

`askNights_`, `askContext_`, `askAnswer_`, `askRoom_` (version 2.3.0): a free question in Telegram. Code collects the last nights and
computes the comparisons; Nemotron answers from them; the answer is checked (numbers from the data only, no causal claims) or replaced by the data itself.
Questions and answers are logged in the `Ask Log` tab. The results in this repository were measured on **2.2.0**, before this feature existed.

## 3. Evaluation — `apps-script/Evals.gs`

Method, cases and results: [`EVALS.md`](EVALS.md).

| Function | What it does |
|---|---|
| `evalSyntheticCases_`, `evalRealCases_`, `evalsSetup` | 26 cases (3 real nights, 23 synthetic), frozen into the `Eval Cases` tab with the exact model input |
| `startEvals`, `evalWorker` | background run, 3 repetitions per case, progress and result to Telegram |
| `evalChecks_` | Level 1: automatic checks on the model's first answer and on the version shown to the user |
| `evJudges_`, `evJudgeOne_` | Level 3: two judge models from different families, each pair judged twice (Nemotron as X, then as Y) |
| `makeBlindReview` | the `Blind Review` tab for a human: order randomised, key hidden |
| `summarizeEvals` | the `Eval Summary` tab: hard-check rates, wins per judge, criteria scores, agreement, human result |

## 4. Ring × room — why it is built this way (v3)

- **Same minutes, not same night.** A nightly average hides a warm hour before dawn. Oura already returns heart rate, HRV and the sleep stage every 5 minutes; the board writes the room every 2 minutes. Each ring point gets the room readings within ±3 minutes.
- **Same sleep stage.** HRV is naturally different in deep, light and REM sleep. A warm stretch is compared with the rest of the same night *in the same stages*, and a night with your other nights stage by stage ("lower in every sleep stage").
- **Fixed rules, written down in advance.** ±10 % for HRV and ±2 bpm for pulse (the tolerances of the nightly table), at least 30 minutes on each side, the map in whole degrees. The warm line of 22.5 °C came from the first 7 nights, so the report calls it a hint until more nights agree (`fusionHistory_`: a pattern needs 3+ nights).
- **Honest by default.** When nothing moved together, the report says so ("no room effect tonight"), and Nemotron is checked against it.
- **Reproducible.** `fusionBacktest()` recomputes 34 numbers on 7 real nights and compares them with an independent calculation. Without ring × room data the report runs the 2.3.0 path that the evals measured: for all 23 synthetic eval cases the model input, the draft and the checks are identical in 2.3.0 and 3.0.0.
