// Ghost CTF target — hidden-protocol firmware (shipped as HEX; source private).
// Link: SoftwareSerial 4800 8N1 on D3(RX)/D4(TX), bit-banged so a logic probe
// can sniff it. Frame: 7E LEN <cmd><payload...> XOR, where LEN = cmd+payload
// byte count and XOR = LEN ^ cmd ^ payload bytes.
//
//   beacon (unsolicited, ~2 Hz)  cmd 0x01  payload "GH0ST" + rolling nonce
//   PING  cmd 0x10 (no payload) -> PONG cmd 0x11 payload "ECHO-7A3"
//   AUTH  cmd 0x20 payload=<current nonce> -> FLAG cmd 0x21 payload PICO{...}
//   anything else -> ERR cmd 0x1F
#include <SoftwareSerial.h>

SoftwareSerial link(3, 4);           // RX=D3 (from player), TX=D4 (to player)
const char TOKEN[] = "GH0ST";
const char ECHO[]  = "ECHO-7A3";
const char FLAG[]  = "PICO{gh0st_on_th3_w1r3}";

uint8_t nonce = 0x41;                // first beacon nonce
uint8_t lastNonce = 0x41;            // nonce of the most recent beacon (AUTH key)
unsigned long last = 0;

void sendFrame(uint8_t cmd, const uint8_t* p, uint8_t plen) {
  uint8_t len = plen + 1, x = len ^ cmd;
  link.write(0x7E); link.write(len); link.write(cmd);
  for (uint8_t i = 0; i < plen; i++) { link.write(p[i]); x ^= p[i]; }
  link.write(x);
}

void handle(uint8_t len, uint8_t* d) {   // d[0]=cmd, d[1..len-1]=payload
  uint8_t cmd = d[0];
  if (cmd == 0x10) {                                    // PING
    sendFrame(0x11, (const uint8_t*)ECHO, sizeof(ECHO) - 1);
  } else if (cmd == 0x20 && len == 2 &&
             (d[1] == lastNonce || d[1] == (uint8_t)(lastNonce - 1))) {  // AUTH
    sendFrame(0x21, (const uint8_t*)FLAG, sizeof(FLAG) - 1);
  } else {
    uint8_t e = 'E';
    sendFrame(0x1F, &e, 1);                             // ERR
  }
}

uint8_t buf[40], st = 0, L = 0, idx = 0;
void pump() {
  while (link.available()) {
    uint8_t b = link.read();
    if (st == 0) { if (b == 0x7E) st = 1; }
    else if (st == 1) { L = b; idx = 0; st = (L > 0 && L < sizeof(buf)) ? 2 : 0; }
    else {                                              // collect L data + 1 xor
      if (idx < L) buf[idx++] = b;
      else { uint8_t x = L; for (uint8_t i = 0; i < L; i++) x ^= buf[i];
             if (x == b) handle(L, buf); st = 0; }
    }
  }
}

bool beaconDue = true;
void setup() { link.begin(4800); }
void loop() {
  if (beaconDue || millis() - last > 300) {             // first beacon immediately
    uint8_t p[6]; memcpy(p, TOKEN, 5); p[5] = nonce;    // "GH0ST" + nonce
    sendFrame(0x01, p, 6);
    lastNonce = nonce; nonce++; last = millis(); beaconDue = false;
  }
  pump();
}
