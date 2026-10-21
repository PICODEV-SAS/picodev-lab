/**
 * Picodev Lab setups, shown in the examples gallery and openable by direct
 * link (/example/<id>). Each one mirrors a physical bench of the lab, so a
 * visitor can rehearse in simulation before flashing the real board.
 */
import type { ExampleProject } from '@velxio/data/examples';

export const proExamples: ExampleProject[] = [
  {
    id: 'picodev-setup-a',
    title: 'Picodev Lab · Setup A : servo, bouton et LED',
    description:
      'Le banc A du labo Picodev : un servo appuie sur un bouton, une LED témoigne de la pression. ' +
      'Modifiez le code, simulez, puis (bientôt) flashez le vrai banc et regardez-le en webcam.',
    category: 'robotics',
    difficulty: 'beginner',
    boardType: 'arduino-nano',
    boardFilter: 'arduino-nano',
    libraries: ['Servo'],
    code: `// Picodev Lab - Setup A
// Servo on D9 presses the button on D2; the LED on D6 shows the button state.
// In simulation you can also click the button yourself.

#include <Servo.h>

const int SERVO_PIN = 9;
const int BUTTON_PIN = 2;
const int LED_PIN = 6;

const int REST_ANGLE = 20;
const int PRESS_ANGLE = 70;

Servo arm;
unsigned long lastPress = 0;

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  arm.attach(SERVO_PIN);
  arm.write(REST_ANGLE);
  Serial.begin(115200);
  Serial.println("Picodev Lab - Setup A ready");
}

void loop() {
  // Every 3 seconds the arm presses the button for half a second.
  if (millis() - lastPress >= 3000) {
    lastPress = millis();
    Serial.println("Arm: press");
    arm.write(PRESS_ANGLE);
    delay(500);
    arm.write(REST_ANGLE);
  }

  bool pressed = digitalRead(BUTTON_PIN) == LOW;
  digitalWrite(LED_PIN, pressed ? HIGH : LOW);
}`,
    components: [
      { type: 'wokwi-servo', id: 'servo-arm', x: 440, y: 60, properties: {} },
      { type: 'wokwi-pushbutton', id: 'btn-target', x: 440, y: 230, properties: {} },
      { type: 'wokwi-resistor', id: 'r-led', x: 440, y: 320, properties: { value: '220' } },
      { type: 'wokwi-led', id: 'led-state', x: 560, y: 300, properties: { color: 'red' } },
    ],
    wires: [
      { id: 'sv-vcc', start: { componentId: 'arduino-uno', pinName: '5V' }, end: { componentId: 'servo-arm', pinName: 'V+' }, color: '#ff0000' },
      { id: 'sv-gnd', start: { componentId: 'arduino-uno', pinName: 'GND' }, end: { componentId: 'servo-arm', pinName: 'GND' }, color: '#000000' },
      { id: 'sv-pwm', start: { componentId: 'arduino-uno', pinName: '9' }, end: { componentId: 'servo-arm', pinName: 'PWM' }, color: '#ff8800' },
      { id: 'btn-in', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'btn-target', pinName: '1.l' }, color: '#00aaff' },
      { id: 'btn-gnd', start: { componentId: 'btn-target', pinName: '2.l' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
      { id: 'led-in', start: { componentId: 'arduino-uno', pinName: '6' }, end: { componentId: 'r-led', pinName: '1' }, color: '#ff4444' },
      { id: 'led-r', start: { componentId: 'r-led', pinName: '2' }, end: { componentId: 'led-state', pinName: 'A' }, color: '#ff4444' },
      { id: 'led-gnd', start: { componentId: 'led-state', pinName: 'C' }, end: { componentId: 'arduino-uno', pinName: 'GND' }, color: '#000000' },
    ],
    tags: ['picodev', 'setup-a', 'servo', 'button', 'led'],
  },
];
