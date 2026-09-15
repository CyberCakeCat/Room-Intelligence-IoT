/*
  Room Intelligence System
  =========================
  ESP32-WROVER + camera + DHT22 → analyzes a bedroom's environment
  (temperature, humidity, light level, window open/closed) and logs
  it to Google Sheets every few minutes. A companion Google Apps
  Script pulls sleep data from the Oura Ring API and sends a daily
  "sleep lab" report to Telegram correlating room conditions with
  sleep quality.

  Hardware: Freenove ESP32-WROVER CAM
  Board setting in Arduino IDE: "ESP32 Wrover Module"

  Before uploading:
    1. Copy secrets.h.example -> secrets.h and fill in your values
    2. Install library: "DHT sensor library" by Adafruit (Library Manager)
*/

#include "esp_camera.h"
#include "DHT.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include "secrets.h"

// ========== CAMERA PINS (ESP32-WROVER) ==========
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

// ========== DHT22 ==========
// Note: GPIO4 is used by the camera (Y2), DHT22 must NOT share it
#define DHTPIN 2
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

// ========== SETUP ==========

void setupCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size = FRAMESIZE_SVGA;
  // Note: this camera's sensor does not support hardware JPEG encoding,
  // so we capture raw RGB565 and analyze pixels directly (no frame2jpg
  // conversion needed here since we only need brightness, not a photo file)
  config.pixel_format = PIXFORMAT_RGB565;
  config.grab_mode = CAMERA_GRAB_LATEST;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 10;
  config.fb_count = 1;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
  }
}

// ========== ROOM ANALYSIS ==========

int calculateBrightness(camera_fb_t* fb) {
  unsigned long sum = 0;
  int count = 0;
  for (int i = 0; i < fb->len; i += 20) {
    uint16_t pixel = (fb->buf[i] << 8) | fb->buf[i + 1];
    uint8_t r = (pixel >> 11) & 0x1F;
    uint8_t g = (pixel >> 5) & 0x3F;
    uint8_t b = pixel & 0x1F;
    int brightness = ((r * 255 / 31) + (g * 255 / 63) + (b * 255 / 31)) / 3;
    sum += brightness;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

bool detectWindow(camera_fb_t* fb) {
  // Heuristic: high pixel variance in the top third of the frame
  // (changing outdoor light/sky) suggests a window is visible/open
  int variance = 0;
  int samples = 0;
  for (int y = 0; y < fb->height / 3; y++) {
    for (int x = 0; x < fb->width; x += 5) {
      int idx = (y * fb->width + x) * 2;
      uint16_t pixel = (fb->buf[idx] << 8) | fb->buf[idx + 1];
      uint8_t r = (pixel >> 11) & 0x1F;
      uint8_t g = (pixel >> 5) & 0x3F;
      uint8_t b = pixel & 0x1F;
      int gray = ((r * 255 / 31) + (g * 255 / 63) + (b * 255 / 31)) / 3;
      variance += abs(gray - 128);
      samples++;
    }
  }
  return samples > 0 && (variance / samples) > 60;
}

// ========== LOG TO GOOGLE SHEETS ==========

void logToSheets(float temp, float humidity, int brightness, bool windowOpen) {
  HTTPClient http;
  http.begin(SHEETS_URL);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  http.addHeader("Content-Type", "application/json");

  String payload = "{\"secret\":\"" + String(SHARED_SECRET) + "\"," 
                    "\"temp\":" + String(temp) +
                    ",\"humidity\":" + String(humidity) +
                    ",\"brightness\":" + String(brightness) +
                    ",\"window_open\":" + String(windowOpen ? "true" : "false") +
                    "}";

  int httpCode = http.POST(payload);
  Serial.println("Sheets response: " + String(httpCode));
  http.end();
}

// ========== MAIN LOGIC ==========

void checkRoom() {
  float temp = dht.readTemperature();
  float humidity = dht.readHumidity();

  camera_fb_t * fb = esp_camera_fb_get();
  int brightness = 0;
  bool windowOpen = false;
  if (fb) {
    brightness = calculateBrightness(fb);
    windowOpen = detectWindow(fb);
    esp_camera_fb_return(fb);
  }

  Serial.println("Temp: " + String(temp, 1) + "  Humidity: " + String(humidity, 1) +
                  "  Brightness: " + String(brightness) + "  Window: " + String(windowOpen ? "OPEN" : "CLOSED"));

  logToSheets(temp, humidity, brightness, windowOpen);
}

void setup() {
  Serial.begin(115200);

  setupCamera();
  dht.begin();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected, IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  checkRoom();
  delay(300000); // every 5 minutes
}
