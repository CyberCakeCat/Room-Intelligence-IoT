# 🌙⚡ Room Intelligence IoT

## Experiment log #001: does my room control my sleep?

Every night, a tiny research station wakes up when I fall asleep. It
watches the temperature drift, the light leak in, the window creak
open. Meanwhile, a ring on my finger watches my heart do its thing:
efficiency, deep sleep, HRV, the works.

At 7:15am, before I'm even conscious enough to ask, the two datasets
get introduced to each other, run through a correlation test, and the
verdict lands in my Telegram. Room Score included. Receipts included.
No dashboard. No app. Just a text message with opinions, backed by
actual math.

This is that station.

<img width="3600" height="4044" alt="Room Intelligence Stack-selection" src="https://github.com/user-attachments/assets/fba0a02e-0bb5-4adf-a2d1-14b2dbf17c61" />


---

## 🧪 The hypothesis

> *Sleep tracking tells you what happened. It almost never tells you
> why. Temperature, light, and airflow are supposed to be load-bearing
> variables for deep sleep, according to the sleep-science literature.
> A bedroom wired with sensors should be able to prove that, night by
> night, with p-values instead of vibes.*

So far: n=12 and counting. The room is being cross-examined.

---

## 🧰 What you need before you start

Nothing here is exotic, but it's spread across a few different worlds:
hardware store, cloud accounts, a wearable. Here's the full shopping
plus signup list before any code gets written.

### Hardware to buy

- **An ESP32 board with a built-in camera.** This project uses a
  **Freenove ESP32-WROVER CAM**. The camera has to be on the board
  already, not a separate module wired in.
- **A DHT22 temperature/humidity sensor.** Not included with most
  ESP32 boards, bought separately, a few dollars.
- **A breadboard and jumper wires** to connect the DHT22 without
  soldering.
- **A USB cable** that actually carries data (not a charge-only
  cable) to flash the board and power it long-term.
- *(Optional, on the roadmap):* a sound sensor (KY-038) and an NDIR
  CO₂ sensor (MH-Z19) for the next round of the experiment.
- *(Optional):* an **Oura Ring**, or any wearable with a public sleep
  API. This is what supplies the "did I actually sleep well" half of
  the dataset.

### Software to install

- **Arduino IDE**, free, from [arduino.cc](https://www.arduino.cc/en/software).
  This is what you use to write and upload the firmware to the ESP32.
- Inside Arduino IDE: add the **ESP32 board package** via
  *Boards Manager* (search "esp32" by Espressif Systems) so the IDE
  knows how to talk to this specific board.
- The **`DHT sensor library`** (by Adafruit), installed via the
  Arduino IDE's *Library Manager*.

### Accounts to set up

- **A Google account**, with access to **Google Drive / Google
  Sheets**. This is where the raw sensor data lives. No special
  Google Cloud project or billing needed, a normal free account is
  enough.
- **Google Apps Script.** Not a separate signup. It's a free tool
  built into every Google Sheet (*Extensions → Apps Script*), and it's
  where the backend logic (receiving ESP32 data, talking to Oura,
  sending reports) actually runs.
- **A Telegram account**, plus a bot created through **@BotFather**
  (a few messages inside Telegram itself, no website involved). This
  is where the daily report gets delivered.
- **An Oura account** (if you're using the sleep-correlation half of
  the project) and an **OAuth application registered** at
  [cloud.ouraring.com/oauth/applications](https://cloud.ouraring.com/oauth/applications).
  This is what lets the backend legally ask Oura for your sleep data
  instead of you copy-pasting it every morning. To be precise about
  what this actually is: it's not an app you install anywhere, it's a
  developer-portal registration (a Client ID and Client Secret pair)
  that identifies *this project* to Oura's API, so Oura knows who's
  asking before it hands over any sleep data through the OAuth2 flow.

Once all of that exists (board in hand, IDE installed, a blank Sheet
open, a bot token in your pocket, Oura app registered), the
[Setup](#️-running-your-own-experiment) section below wires it all
together into one running system.

---

## 🗺️ How the signal travels

```
   🛏️  YOUR ROOM                           💍  YOUR BODY
   ┌──────────────┐                       ┌──────────────┐
   │ ESP32-WROVER  │                       │  Oura Ring    │
   │ camera+DHT22  │                       │  (does its    │
   │ every 5 min   │                       │   own thing)  │
   └──────┬───────┘                       └───────┬───────┘
          │ HTTP POST, secret-signed                │ OAuth2
          ▼                                        ▼
   ┌────────────────────────────────────────────────────┐
   │              Google Apps Script (the brain)          │
   │   logs raw data  →  Sheets  →  7:15am cron  →         │
   │   pulls last night's Oura  →  runs Pearson r  →        │
   │   writes a verdict                                     │
   └───────────────────────┬────────────────────────────┘
                           ▼
                    📩 Telegram, 7:15am
                    (before you're awake
                     enough to argue)
```

---

## 🔬 Choices a reviewer might ask about

**Q: Why no photoresistor for light?**
Because a camera was already sitting there doing nothing useful at
3am. Light level and "is the window open" are both extracted from raw
RGB565 pixel data instead: one less part on the breadboard, one more
excuse to write bit-shifting code.

**Q: Why raw pixels instead of JPEG?**
This particular camera silicon simply refuses to do hardware JPEG
encoding. Discovered via a very confusing `0x106` error at 2am.
Software encoding (`frame2jpg`) only happens on demand; analysis runs
straight on the raw buffer.

**Q: Isn't OAuth2 overkill for a bedroom sensor?**
Oura deprecated Personal Access Tokens mid-build, so "overkill" became
"mandatory." The backend now does a full authorization-code handshake,
server-side, so the ESP32 itself never sees a user credential. That's
more security hygiene than most side projects bother with.

**Q: What stops randoms from POSTing fake data to your webhook?**
A pre-shared secret checked on every request. The URL is technically
public (Apps Script Web Apps don't offer a native API-key layer), so
the payload itself has to prove it belongs.

**Q: Why gate the correlation behind n ≥ 5?**
Because a "correlation" computed from two nights of data is just two
numbers wearing a lab coat.

---

## 📡 What's actually being measured

| Signal | Source | Cadence |
|---|---|---|
| Temperature, humidity | DHT22 | 5 min |
| Brightness, window-open guess | camera pixel analysis | 5 min |
| Sleep efficiency, stages, HRV, resting HR | Oura API v2 | daily |
| Readiness | Oura API v2 | daily |
| **Room Score (0–100)** | derived, benchmarked to ~18–20°C sleep-temp research | daily |
| Temperature ↔ deep sleep % | Pearson r, n-gated | daily |

---

## 🧰 Stack

`C++` firmware (Arduino, `esp32-camera`, `DHT sensor library`), talking to
a `Google Apps Script` backend (`OAuth2 for Apps Script`), which treats
`Google Sheets` as a very scrappy time-series database, pulls ground
truth from `Oura API v2`, and delivers the verdict through the
`Telegram Bot API`.

**Hardware:** Freenove ESP32-WROVER CAM, DHT22, a breadboard held
together by optimism. Sound (KY-038) and CO₂ (MH-Z19) sensors are
inbound, see the roadmap.

---

## 📁 Repo map

```
esp32/            firmware + secrets.h.example (copy, fill, flash)
apps-script/       Code.gs.example (copy into Extensions > Apps Script)
docs/              TROUBLESHOOTING.md: the unedited autopsy of every bug
```

---

## ⚙️ Running your own experiment

1. DHT22 → GPIO 2 (GPIO 4 belongs to the camera, don't touch it). Flash
   `esp32/room_intelligence.ino`, board = `ESP32 Wrover Module`.
2. `cp esp32/secrets.h.example esp32/secrets.h`, then fill in Wi-Fi and
   a random shared secret.
3. New Sheet → *Extensions → Apps Script* → paste
   `apps-script/Code.gs.example`, fill in the placeholders, add the
   `OAuth2 for Apps Script` library
   (`1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF`).
4. Deploy → Web app → *Me* / *Anyone* → URL goes into `secrets.h`.
5. Register an app at
   [cloud.ouraring.com/oauth/applications](https://cloud.ouraring.com/oauth/applications),
   run `authorize()`, approve.
6. Run `setupTrigger()` once. Go to sleep. The lab takes it from here.

---

## 📨 Actual field data

```
SLEEP LAB - Night #12
14 Sep 2026

ROOM SCORE: 78/100

SLEEP
Efficiency: 88% (avg 85.2%)
Total: 7h 40m | Deep: 1h 42m | REM: 1h 55m
HRV: 46ms | Resting HR: 55bpm | Awake: 14m

READINESS: 81

ROOM (23:00-07:00)
Temp: 19.4C (18.1-20.6), stability +/-0.6C
Humidity: 47% | Max brightness: 38 | Dark: 98%
Window open: 0%

BY TEMPERATURE RANGE (efficiency)
18-20C: 87.3% (6 nights)
20-22C: 81.1% (4 nights)
22-24C: 76.0% (2 nights)

TEMPERATURE x DEEP SLEEP
r=-0.61 - moderate relationship (warmer -> less)

Nights logged: 12
```

Twelve nights in, the room is starting to look guilty.

---

## 🔒 Security first

This system moves biometric data (yours) and lives on a publicly
reachable URL (Apps Script Web Apps have no way around that). Data
security is treated as more important than any feature in this repo.

- **Every secret lives outside git, permanently.** `secrets.h` and the
  real `Code.gs` are listed in `.gitignore`. Only `.example` templates
  with placeholder values are ever committed.
- **The ingest endpoint checks a shared secret on every request**,
  instead of just relying on the URL being hard to guess. No valid
  secret, no write to the sheet.
- **Oura access uses real OAuth2, not a stored password or a bare
  token.** The authorization lives in Google's own encrypted property
  store, scoped to the minimum permissions needed (`email personal
  daily`), not full account access.
- **The raw data never leaves your own Google account.** The sheet,
  the script, and the Oura authorization all belong to you. This repo
  contains no server and no third-party database. Nothing here holds
  a copy of your data.
- **The Telegram bot only talks to one chat ID, yours,** hardcoded
  server-side, not something an attacker could redirect.

If you fork this: generate your *own* shared secret and your *own*
Oura app credentials. Never reuse the placeholder values, and never
commit the filled-in versions.

---

## 🧠 Key learnings so far

A few things the sleep-science research (and the data itself) made
obvious that weren't obvious going in.

- **Resting heart rate at bedtime turns out to matter more than
  expected.** If your resting heart rate when you lie down is already
  above your personal baseline, that alone tends to predict a rough
  night: trouble falling asleep, more wake events, or both. This
  project doesn't have a dedicated continuous heart-rate sensor of its
  own yet, so Oura's nightly average heart rate is being used as a
  proxy while that gap gets closed.
- **Darkness is a primary variable, not a side note.** The sensors
  already measure exactly how dark the room stays through the night
  (not just "is the light off," but the actual percentage of the
  night spent below a brightness threshold), because the sleep-science
  sources are consistent that this matters as much as temperature.
- **Blue light before bed is avoided on principle**, based on the same
  research. This isn't something the sensors enforce, that's a human
  behavior, not a hardware feature, but it's part of the protocol this
  whole experiment is implicitly testing.
- **Room conditions are only part of the story.** Alcohol, a late
  meal, and a late workout all show up in the sleep-science literature
  as real, independent factors, and none of them are currently
  captured by any sensor here (logged manually if at all). Worth being
  honest about: any correlation this system finds between room
  conditions and sleep quality is happening alongside these uncaptured
  variables, not in a vacuum.

The experiment has really only just started. The roadmap below is
where the actual pattern-hunting happens next.

---

## 🚧 Open questions the lab hasn't answered yet

**Sensors in the pipeline:**
- [ ] Sound sensor (KY-038, incoming): does traffic noise actually
      fragment deep sleep, or does it just feel that way?
- [ ] NDIR CO₂ sensor (MH-Z19, incoming): does a closed window's CO₂
      buildup show up in next-morning readiness?
- [ ] EMF sensor: still hunting for one that's actually reliable and
      not snake oil. Suggestions welcome.

**Correlations the experiment is actually running for** (the whole
point of this project; n is still small, so treat all of this as
hypotheses in progress, not conclusions):
- [ ] Resting heart rate at bedtime vs. sleep quality: does going to
      bed with an elevated resting HR predict a worse night, the same
      way it predicts trouble falling asleep in the sleep-science
      literature?
- [ ] Open window / fresh air vs. sleep quality: does ventilation
      actually help, or is it a wash once temperature is controlled
      for?
- [ ] Just how much darkness matters: the room is already scored on
      percentage of the night spent dark; the open question is how
      strongly that specific variable, isolated from temperature,
      moves the needle.
- [ ] Sunrise timing vs. natural wake time: does the room getting
      brighter earlier actually pull wake-up time earlier with it?

**Quality of life:**
- [ ] A weekly digest, for when the daily report starts feeling like
      doomscrolling your own biology.

---

## 🧾 Disclosures

Room Score thresholds and report framing are grounded in public
sleep-science talks (Matthew Walker, Andrew Huberman), cited in
`docs/TROUBLESHOOTING.md` and inline comments. This is an N-of-1
experiment on one (1) specific human in one (1) specific room. Results
may not generalize. That's kind of the point.

MIT licensed, see [LICENSE](LICENSE).
