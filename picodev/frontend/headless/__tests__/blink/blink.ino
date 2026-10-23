// Fixture of headless.test.ts. Rebuild blink.hex after a change:
//   arduino-cli compile --fqbn arduino:avr:nano --output-dir out . && cp out/blink.ino.hex blink.hex
void setup() {
  pinMode(13, OUTPUT);
  pinMode(2, OUTPUT);
  pinMode(10, INPUT_PULLUP);
  Serial.begin(9600);
  Serial.println("ready");
}

void loop() {
  digitalWrite(13, (millis() / 500) % 2);  // 500 ms pulses
  digitalWrite(2, !digitalRead(10));       // D2 follows D10, inverted
}
