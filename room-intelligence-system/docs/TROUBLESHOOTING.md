# Troubleshooting Log

A real record of the problems hit while building this project and how they
were diagnosed and fixed. Kept here deliberately: the debugging process is
as much a part of this project as the final result.

## Breadboard & electronics

**LED wouldn't light.**
Root cause: breadboard holes are electrically grouped in blocks of 5
("columns"); a component one column off from its intended pin looks close
but is on a completely different, unconnected circuit. Fixed by mapping out
the board's column structure before wiring anything else.

**Blue LED worked with no current-limiting resistor.**
Blue/white LEDs have a forward voltage close to the ESP32's 3.3V supply, so
the current draw without a resistor happened to stay in a safe range. Red/
green LEDs (~2V forward voltage) would not have been safe under the same
conditions: the resistor was added back regardless, since relying on
component-specific voltage margins is not a real fix.

## Camera

**Compile error: `camera_config_t` has no member `pin_sda`.**
The field was renamed to `pin_sccb_sda` / `pin_sccb_scl` in current versions
of the esp32-camera driver. Code copied from older tutorials broke silently
until the field names were updated.

**`Camera init failed: 0x106`: "JPEG format is not supported on this
sensor".**
This particular sensor unit doesn't support hardware JPEG encoding (a known
variance across otherwise-identical camera modules). Fixed by capturing in
`PIXFORMAT_RGB565` and, where an actual JPEG file was needed, converting in
software with `frame2jpg()`.

**SD card mount failing (`sdmmc_send_cmd returned 0xffffffff`).**
Two separate causes stacked on top of each other:
1. `SD_MMC.begin()` defaults to 4-bit mode; this board only wires 1 data
   line, fixed with `SD_MMC.begin("/sdcard", true)`.
2. GPIO4 is shared between the camera's Y2 data line and the SD card's D1
   line on this board design, releasing the pin (`pinMode(4, OUTPUT);
   digitalWrite(4, LOW);`) after camera init resolved the conflict.
3. After both fixes, the card was still unreadable: it turned out to be
   physically corrupted (confirmed via Disk Utility showing 0 bytes
   available) and needed reformatting.

## Cloud pipeline (Google Sheets + Apps Script)

**Apps Script code silently failed to save**, leaving the default template
in place. Diagnosed by reopening the project fresh and finding the expected
`doPost` function missing.

**Deployment auto-indent duplicated a closing brace**, producing a syntax
error only visible after attempting to save.

## Oura API: OAuth2 migration

Oura deprecated Personal Access Tokens in December 2025; OAuth2 became
mandatory mid-project. This required:
- Registering an OAuth application with a callback URL built from the Apps
  Script project's own script ID
- Adding the community `OAuth2 for Apps Script` library
- Manually declaring `oauthScopes` in `appsscript.json`: the default
  manifest didn't request the external-request scope the OAuth flow needed,
  which produced an opaque `"Authorisation is required to perform that
  action"` error with no further detail
- Walking through Google's "unverified app" consent screen, expected for a
  personal-use script that hasn't gone through Google's verification process

## Takeaways

- Version drift in libraries (renamed struct fields, deprecated auth flows)
  broke more of this project than logic errors did: pin the library
  version or check the changelog before trusting an old tutorial.
- Hardware faults (the SD card) and software bugs can look identical from
  the error message alone; cross-checking at the OS level (Disk Utility)
  resolved in minutes what code changes alone could not.
- Splitting "sensor logging" (ESP32 → Sheets) from "reporting" (Apps Script
  → Telegram, on its own schedule) turned out to be the right architecture
  call: the report generation has iterated many times since without
  touching the firmware at all.
