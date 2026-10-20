/*
  Room Intelligence — firmware v2
  Board: Freenove ESP32-WROVER CAM (FNK0061B); Arduino IDE board "ESP32 Wrover Module", PSRAM enabled.

  Sends a row to Google Sheets every 2 minutes and immediately when the window opens or closes.
  The camera is used only as a light meter; no image leaves the board.

  Libraries (Library Manager): "Sensirion I2C SCD4x" (v1.x), "DHT sensor library" by Adafruit
  (+ "Adafruit Unified Sensor").
  Secrets: create secrets.h next to this file (see secrets.h.example).
*/

#include "esp_camera.h"
#include "DHT.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <SensirionI2cScd4x.h>
#include <Preferences.h>            // survives reboots: time of the last CO2 calibration
#include <time.h>
#include "secrets.h"                // not in git

// ====================== PINS ======================
#define I2C_SDA_PIN     13          // SCD41 (GPIO21/22 are taken by the camera)
#define I2C_SCL_PIN     14
#define DHT_PIN          2          // strapping pin: unplug DHT22 DATA while flashing
#define DHT_TYPE     DHT22
#define SOUND_PIN       32          // KY-038 AO (ADC1 works with Wi-Fi on)
#define REED_PIN        15          // reed switch to GND

// Magnet near the reed switch → contact closed → pin pulled to GND → LOW = window closed
#define REED_CLOSED_LEVEL  LOW

// ====================== SETTINGS ======================
const unsigned long LOG_INTERVAL_MS      = 120000UL;              // one row every 2 min
const unsigned long CO2_POLL_MS          = 5500UL;                // SCD41 updates every 5 s
const unsigned long REED_DEBOUNCE_MS     = 50UL;
const unsigned long CAL_OPEN_MIN_MS      = 15UL * 60UL * 1000UL;  // window open for 15 min
const unsigned long CAL_MIN_INTERVAL_S   = 30UL * 24UL * 3600UL;  // at most once in 30 days
const int           CAL_MAX_CO2_PPM      = 700;                   // only when the room is really aired
const uint16_t      CAL_TARGET_PPM       = 420;                   // outdoor air

DHT dht(DHT_PIN, DHT_TYPE);
SensirionI2cScd4x co2Sensor;
Preferences prefs;

bool co2Ready = false;
int  lastCo2  = -1;                 // last valid CO2 (-1 = none yet)
unsigned long lastCo2Poll = 0;
unsigned long lastLog = 0;

bool reedRaw = true;                // undebounced
bool reedStableClosed = true;       // debounced: true = window closed
unsigned long reedLastEdge = 0;
unsigned long openSince = 0;        // millis() when the window opened; 0 = closed
bool reedChanged = false;           // send a row now

// ====================== REED SWITCH ======================

bool readReedClosedNow() {
  return digitalRead(REED_PIN) == REED_CLOSED_LEVEL;
}

void setupReed() {
  pinMode(REED_PIN, INPUT_PULLUP);
  delay(100);
  reedRaw = readReedClosedNow();
  reedStableClosed = reedRaw;
  openSince = reedStableClosed ? 0 : millis();
}

// Called every loop; a change counts once it holds for REED_DEBOUNCE_MS
void pollReed() {
  bool now = readReedClosedNow();
  if (now != reedRaw) {
    reedRaw = now;
    reedLastEdge = millis();
  }
  if (reedRaw != reedStableClosed && millis() - reedLastEdge >= REED_DEBOUNCE_MS) {
    reedStableClosed = reedRaw;
    openSince = reedStableClosed ? 0 : millis();
    reedChanged = true;
    Serial.println(reedStableClosed ? "REED: window CLOSED" : "REED: window OPENED");
  }
}

// ====================== CO2 (SCD41) ======================

void setupCO2() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  co2Sensor.begin(Wire, 0x62);

  co2Sensor.wakeUp();                        // may fail if already awake; that's fine
  delay(30);
  co2Sensor.stopPeriodicMeasurement();       // in case it kept running across a reboot
  delay(1000);
  co2Sensor.reinit();
  delay(100);

  // Automatic self-calibration is off: in an occupied bedroom it drifts low. See maybeCalibrateCO2().
  co2Sensor.setAutomaticSelfCalibrationEnabled(0);

  uint16_t err = co2Sensor.startPeriodicMeasurement();
  co2Ready = (err == 0);
  Serial.println(co2Ready ? "SCD41: started (first value in ~5-10 s)"
                          : "SCD41: NOT started, check wiring and soldering");
}

void pollCO2() {
  if (!co2Ready) return;
  if (millis() - lastCo2Poll < CO2_POLL_MS) return;
  lastCo2Poll = millis();

  bool ready = false;
  if (co2Sensor.getDataReadyStatus(ready) != 0 || !ready) return;

  uint16_t co2 = 0; float t = 0, h = 0;
  if (co2Sensor.readMeasurement(co2, t, h) == 0 && co2 != 0) lastCo2 = co2;
}

void calibrateCO2Now() {
  Serial.println("CO2: calibrating to 420 ppm...");
  co2Sensor.stopPeriodicMeasurement();
  delay(1000);
  uint16_t correction = 0;
  uint16_t err = co2Sensor.performForcedRecalibration(CAL_TARGET_PPM, correction);
  if (err || correction == 0xFFFF) Serial.println("CO2: calibration FAILED");
  else Serial.println("CO2: calibrated, correction: " + String((int)correction - 0x8000));
  delay(500);
  co2Sensor.startPeriodicMeasurement();
}

// Decided on the board: window open >= 15 min, CO2 already low, >= 30 days since the last
// calibration, clock synced (NTP)
void maybeCalibrateCO2() {
  if (!co2Ready || reedStableClosed || openSince == 0) return;
  if (millis() - openSince < CAL_OPEN_MIN_MS) return;
  if (lastCo2 <= 0 || lastCo2 > CAL_MAX_CO2_PPM) return;

  time_t nowT = time(nullptr);
  if (nowT < 1700000000) return;

  prefs.begin("room", false);
  uint32_t lastCal = prefs.getUInt("calTs", 0);
  if (lastCal != 0 && (uint32_t)nowT - lastCal < CAL_MIN_INTERVAL_S) {
    prefs.end();
    return;
  }
  calibrateCO2Now();
  prefs.putUInt("calTs", (uint32_t)nowT);
  prefs.end();
}

// ====================== NOISE (KY-038) ======================

// Signal swing (max - min) over ~1 s; relative, Wi-Fi adds interference
int readNoiseSwing() {
  int mn = 4095, mx = 0;
  for (int i = 0; i < 500; i++) {
    int v = analogRead(SOUND_PIN);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    delay(2);
  }
  return mx - mn;
}

// ====================== CAMERA: LIGHT ONLY ======================

// Fixed on the board
#define PWDN_GPIO_NUM    -1
#define RESET_GPIO_NUM   -1
#define XCLK_GPIO_NUM    21
#define SIOD_GPIO_NUM    26
#define SIOC_GPIO_NUM    27
#define Y9_GPIO_NUM      35
#define Y8_GPIO_NUM      34
#define Y7_GPIO_NUM      39
#define Y6_GPIO_NUM      36
#define Y5_GPIO_NUM      19
#define Y4_GPIO_NUM      18
#define Y3_GPIO_NUM       5
#define Y2_GPIO_NUM       4
#define VSYNC_GPIO_NUM   25
#define HREF_GPIO_NUM    23
#define PCLK_GPIO_NUM    22

bool cameraReady = false;

void setupCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size = FRAMESIZE_QQVGA;       // 160x120 is enough for mean brightness
  config.pixel_format = PIXFORMAT_RGB565;    // this sensor has no hardware JPEG
  config.grab_mode = CAMERA_GRAB_LATEST;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  esp_err_t err = esp_camera_init(&config);
  cameraReady = (err == ESP_OK);
  if (!cameraReady) Serial.printf("Camera: init error 0x%x (light will be 0)\n", err);
}

// Mean frame brightness 0-255. The frame is never stored or sent.
int readBrightness() {
  if (!cameraReady) return 0;
  camera_fb_t* fb = esp_camera_fb_get();     // first frame after a pause is often dark: drop it
  if (fb) esp_camera_fb_return(fb);
  fb = esp_camera_fb_get();
  if (!fb) return 0;

  unsigned long sum = 0; int count = 0;
  for (size_t i = 0; i + 1 < fb->len; i += 20) {         // sample every 20 bytes
    uint16_t px = (fb->buf[i] << 8) | fb->buf[i + 1];
    uint8_t r = (px >> 11) & 0x1F, g = (px >> 5) & 0x3F, b = px & 0x1F;
    sum += ((r * 255 / 31) + (g * 255 / 63) + (b * 255 / 31)) / 3;
    count++;
  }
  esp_camera_fb_return(fb);
  return count ? (int)(sum / count) : 0;
}

// ====================== SEND TO GOOGLE SHEETS ======================

// JSON has no NaN: a sensor that did not answer is sent as null (empty cell)
String numOrNull(float v, int decimals) {
  return isnan(v) ? String("null") : String(v, decimals);
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.println("Wi-Fi lost, reconnecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) delay(250);
}

void logRoom(const char* why) {
  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();
  int   noise = readNoiseSwing();
  int   light = readBrightness();
  String contact = reedStableClosed ? "closed" : "open";

  Serial.printf("[%s] T=%s H=%s CO2=%d noise=%d light=%d window=%s\n", why,
                numOrNull(temp, 1).c_str(), numOrNull(hum, 1).c_str(),
                lastCo2, noise, light, contact.c_str());

  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) { Serial.println("No Wi-Fi, row skipped"); return; }

  String payload = String("{\"secret\":\"") + SHARED_SECRET + "\"" +
                   ",\"temp\":" + numOrNull(temp, 1) +
                   ",\"humidity\":" + numOrNull(hum, 1) +
                   ",\"brightness\":" + String(light) +
                   ",\"sound\":" + String(noise) +
                   ",\"co2\":" + (lastCo2 > 0 ? String(lastCo2) : String("null")) +
                   ",\"window_contact\":\"" + contact + "\"" +
                   "}";

  HTTPClient http;
  http.begin(SHEETS_URL);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);   // Apps Script answers with a redirect
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(payload);
  Serial.println("Sheets: " + String(code));
  http.end();
}

// ====================== SETUP AND LOOP ======================

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== Room Intelligence v2 ===");

  analogReadResolution(12);
  pinMode(SOUND_PIN, INPUT);
  setupReed();
  setupCO2();                                 // I2C bus first, then the camera
  setupCamera();
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Wi-Fi");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 30000) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected, IP " + WiFi.localIP().toString()
                                                : " NOT connected (will retry)");
  configTime(0, 0, "pool.ntp.org");           // clock is only needed for the calibration interval

  lastLog = millis() - LOG_INTERVAL_MS + 15000;   // first row after ~15 s, once CO2 is available
}

void loop() {
  pollReed();
  pollCO2();

  if (reedChanged) {                          // window opened or closed: send a row now
    reedChanged = false;
    logRoom("window");
    lastLog = millis();
  }

  if (millis() - lastLog >= LOG_INTERVAL_MS) {
    logRoom("timer");
    lastLog = millis();
  }

  maybeCalibrateCO2();
  delay(20);                                  // reed switch polled ~50 times per second
}
