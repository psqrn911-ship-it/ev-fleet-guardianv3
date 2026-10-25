// EXAMPLE ONLY — not compiled or tested on hardware. Adapt pins, Wi-Fi, library and your existing voltage/current/temperature code.
// Shows the part that matters for shock alerts: sample the MPU6050 fast, remember the PEAK since the last post,
// and post immediately when a threshold is crossed (a 5–10 s average would hide a 100 ms impact).
// Library: "Adafruit MPU6050" (reports acceleration in m/s² and rotation in rad/s).
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <WiFi.h>
#include <HTTPClient.h>

Adafruit_MPU6050 mpu;
const char* URL = "https://YOUR-SITE/data";
const char* VEHICLE_ID = "KA01EV2341";
const char* DEVICE_KEY = "PASTE_DEVICE_KEY";   // keep out of public repos
const float POST_NOW_G = 0.4;                  // post at once above this dynamic g (match the dashboard warning threshold)

float peakG = 0, peakDps = 0, lastAx, lastAy, lastAz, lastGx, lastGy, lastGz;
unsigned long lastPost = 0;

void setup() {
  Serial.begin(115200); Wire.begin();
  mpu.begin(); mpu.setAccelerometerRange(MPU6050_RANGE_8_G); mpu.setGyroRange(MPU6050_RANGE_500_DEG); mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);
  // WiFi.begin(...) and your existing sensor setup here
}

void sample() {                                 // call every ~10-20 ms
  sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t);
  lastAx = a.acceleration.x; lastAy = a.acceleration.y; lastAz = a.acceleration.z;
  lastGx = g.gyro.x * 57.2958; lastGy = g.gyro.y * 57.2958; lastGz = g.gyro.z * 57.2958;          // rad/s -> deg/s
  float dynG = fabs(sqrt(lastAx*lastAx + lastAy*lastAy + lastAz*lastAz) / 9.80665 - 1.0);       // gravity removed, any mounting orientation
  float dps = sqrt(lastGx*lastGx + lastGy*lastGy + lastGz*lastGz);
  if (dynG > peakG) peakG = dynG; if (dps > peakDps) peakDps = dps;
}

void post() {
  HTTPClient http; http.begin(URL); http.addHeader("Content-Type", "application/json"); http.addHeader("x-device-key", DEVICE_KEY);
  String body = String("{\"vehicle_id\":\"") + VEHICLE_ID + "\"" +
    // ...your existing fields: ,\"battery\":..,\"voltage\":..,\"current\":..,\"temp\":..,\"lat\":..,\"lon\":..
    ",\"accel_unit\":\"ms2\",\"ax\":" + lastAx + ",\"ay\":" + lastAy + ",\"az\":" + lastAz +
    ",\"gx\":" + lastGx + ",\"gy\":" + lastGy + ",\"gz\":" + lastGz +
    ",\"g_peak\":" + String(peakG * 9.80665, 3) + ",\"gyro_peak\":" + peakDps + "}";             // g_peak is sent in the same unit as accel_unit
  http.POST(body); http.end();
  peakG = 0; peakDps = 0; lastPost = millis();
}

void loop() {
  sample();
  bool shock = peakG >= POST_NOW_G;
  if ((shock && millis() - lastPost > 1000) || millis() - lastPost > 8000) post();      // immediate on a shock, otherwise every ~8 s
  delay(10);
}
