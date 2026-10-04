// Nano Cortex Controller in the browser: the board's firmware (WebAssembly, nano-controller.js) with the screen on a
// canvas, the footswitches as buttons, Web Bluetooth to the Nano Cortex and Web MIDI for a MIDI controller.
'use strict';

const SERVICE_UUIDS = ['0000a002-0000-1000-8000-00805f9b34fb', '0000a003-0000-1000-8000-00805f9b34fb'];
const C304_UUID = '0000c304-0000-1000-8000-00805f9b34fb';
const C305_UUID = '0000c305-0000-1000-8000-00805f9b34fb';
const HOLD_MS = 600;                                // FOOTSWITCH_HOLD_MS of the board
const FS = { PRESS: 0, RELEASE: 1, HOLD: 2 };       // footswitch_event_t
const SCREEN_W = 800, SCREEN_H = 480;

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d', { alpha: false });
const connectButton = document.getElementById('connect');
const statusText = document.getElementById('status');

function setStatus(text, kind = '') {
  statusText.textContent = text;
  statusText.dataset.kind = kind;
}

// ---- the firmware ----
// The module object: app.js offers the functions the firmware calls, the firmware adds its own (_web_...).
// Calls from the firmware are answered later (setTimeout / promises), never while it is still running.

const M = {
  ctx,
  nanoWrite(bytes) {
    if (!link.c304) { setTimeout(() => M._web_nano_written(0)); return; }
    link.c304.writeValueWithResponse(bytes).then(
      () => M._web_nano_written(1),
      (e) => { console.warn('Write failed', e); M._web_nano_written(0); });
  },
  midiSearch(on) { setTimeout(() => midiSearch(on)); },
  midiUse(name) { setTimeout(() => midiUse(name)); },
  print: (text) => console.log(text),
  printErr: (text) => console.warn(text),
};

let started = false;
createNanoController(M).then(() => {
  started = true;
  setInterval(() => M._web_platform_run(), 100);   // timers also while the tab is in the background
  if (!navigator.bluetooth) {
    setStatus('Web Bluetooth is not available here - use Chrome or Edge (on iPhone: the Bluefy browser)', 'error');
  }
}).catch((e) => setStatus('Could not start: ' + e, 'error'));

function toFirmware(bytes, fn) {
  const p = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, p);
  fn(p, bytes.length);
  M._free(p);
}

// ---- Web Bluetooth ----

const link = { device: null, c304: null, c305: null, ready: false, userClosed: false, retry: null };

function onNotify(event) {
  const v = event.target.value;
  toFirmware(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), (p, n) => M._web_nano_packet(p, n));
}

async function openLink() {
  const device = link.device;
  setStatus('Connecting to ' + (device.name || 'the device') + ' ...', 'busy');
  const server = await device.gatt.connect();
  link.c304 = link.c305 = null;
  for (const uuid of SERVICE_UUIDS) {
    let service;
    try { service = await server.getPrimaryService(uuid); } catch (e) { continue; }
    for (const ch of await service.getCharacteristics()) {
      if (ch.uuid === C304_UUID) link.c304 = ch;
      if (ch.uuid === C305_UUID) link.c305 = ch;
    }
    if (link.c304 && link.c305) break;
  }
  if (!link.c304 || !link.c305) {
    link.c304 = link.c305 = null;
    link.userClosed = true;
    device.gatt.disconnect();
    throw new Error('"' + (device.name || 'This device') + '" is not a Nano Cortex.');
  }
  link.c305.addEventListener('characteristicvaluechanged', onNotify);   // the same listener is added only once
  await link.c305.startNotifications();
  link.ready = true;
  connectButton.textContent = 'DISCONNECT';
  setStatus('Connected: ' + (device.name || 'Nano Cortex'), 'ok');
  M._web_nano_link(1);
}

function onDisconnected() {
  const was = link.ready;
  link.ready = false;
  link.c304 = link.c305 = null;
  if (was) M._web_nano_link(0);
  connectButton.textContent = 'CONNECT';
  if (link.userClosed || !link.device) {
    setStatus('Not connected');
    return;
  }
  setStatus('Connection lost - connecting again ...', 'busy');
  retryLater();
}

function retryLater() {
  clearTimeout(link.retry);
  link.retry = setTimeout(async () => {
    if (link.userClosed || link.ready || !link.device) return;
    try { await openLink(); } catch (e) { retryLater(); }
  }, 3000);
}

async function connect() {
  if (!navigator.bluetooth) {
    setStatus('Web Bluetooth is not available here - use Chrome or Edge (on iPhone: the Bluefy browser)', 'error');
    return;
  }
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICE_UUIDS });
  } catch (e) {
    if (e.name !== 'NotFoundError') setStatus(e.message, 'error');   // NotFoundError = chooser closed
    return;
  }
  link.device = device;
  link.userClosed = false;
  device.addEventListener('gattserverdisconnected', onDisconnected);
  try {
    await openLink();
  } catch (e) {
    console.warn(e);
    setStatus(e.message || String(e), 'error');
    if (!link.userClosed) retryLater();
  }
}

connectButton.addEventListener('click', () => {
  if (!started) return;
  if (link.ready || link.retry && !link.userClosed && link.device) {
    link.userClosed = true;
    clearTimeout(link.retry);
    link.retry = null;
    if (link.device && link.device.gatt.connected) link.device.gatt.disconnect();
    else setStatus('Not connected');
    connectButton.textContent = 'CONNECT';
    return;
  }
  connect();
});

// ---- touch screen: mouse or finger on the canvas ----

let pointerDown = false;

function screenPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [Math.round((e.clientX - r.left) * SCREEN_W / r.width), Math.round((e.clientY - r.top) * SCREEN_H / r.height)];
}

canvas.addEventListener('pointerdown', (e) => {
  if (!started || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  pointerDown = true;
  M._web_pointer(...screenPoint(e), 1);
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  if (pointerDown) M._web_pointer(...screenPoint(e), 1);
});
for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, (e) => {
    if (!pointerDown) return;
    pointerDown = false;
    M._web_pointer(...screenPoint(e), 0);
  });
}
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- footswitches: buttons below the screen and the keys 1-8 ----

const footswitch = {};   // number -> { down, timer }

function switchButton(n) {
  return document.querySelector('.fs[data-n="' + n + '"]');
}

function switchDown(n) {
  const s = footswitch[n] || (footswitch[n] = {});
  if (!started || s.down) return;
  s.down = true;
  switchButton(n).classList.add('down');
  M._web_footswitch(n, FS.PRESS);
  s.timer = setTimeout(() => { if (s.down) M._web_footswitch(n, FS.HOLD); }, HOLD_MS);
}

function switchUp(n) {
  const s = footswitch[n];
  if (!s || !s.down) return;
  s.down = false;
  clearTimeout(s.timer);
  switchButton(n).classList.remove('down');
  M._web_footswitch(n, FS.RELEASE);
}

for (const button of document.querySelectorAll('.fs')) {
  const n = Number(button.dataset.n);
  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    button.setPointerCapture(e.pointerId);
    switchDown(n);
    e.preventDefault();
  });
  button.addEventListener('pointerup', () => switchUp(n));
  button.addEventListener('pointercancel', () => switchUp(n));
  button.addEventListener('contextmenu', (e) => e.preventDefault());
}

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key >= '1' && e.key <= '8') switchDown(Number(e.key));
});
window.addEventListener('keyup', (e) => {
  if (e.key >= '1' && e.key <= '8') switchUp(Number(e.key));
});
window.addEventListener('blur', () => {
  for (let n = 1; n <= 8; n++) switchUp(n);
});

// ---- Web MIDI: a MIDI input of the computer instead of Bluetooth MIDI ----

const midi = { access: null, input: null, wanted: '' };

async function midiAccess() {
  if (midi.access) return midi.access;
  if (!navigator.requestMIDIAccess) return null;
  try {
    midi.access = await navigator.requestMIDIAccess();
  } catch (e) {
    console.warn('MIDI not allowed', e);
    return null;
  }
  midi.access.addEventListener('statechange', () => { midiList(); midiAttach(); });
  return midi.access;
}

function midiList() {
  M._web_midi_inputs_clear();
  if (midi.access) {
    for (const input of midi.access.inputs.values()) {
      if (input.state === 'connected') M.ccall('web_midi_input', null, ['string'], [input.name || 'MIDI input']);
    }
  }
  M._web_midi_changed(midi.input ? 1 : 0);
}

async function midiSearch(on) {
  if (!on) return;
  await midiAccess();
  midiList();
}

async function midiUse(name) {
  midi.wanted = name;
  if (name) await midiAccess();
  midiAttach();
}

function onMidi(e) {
  const d = e.data;
  if (d.length && d[0] >= 0x80 && d[0] < 0xF0) M._web_midi_message(d[0], d[1] || 0, d[2] || 0);
}

function midiAttach() {
  let found = null;
  if (midi.access && midi.wanted) {
    for (const input of midi.access.inputs.values()) {
      if (input.name === midi.wanted && input.state === 'connected') found = input;
    }
  }
  if (found !== midi.input) {
    if (midi.input) midi.input.onmidimessage = null;
    midi.input = found;
    if (found) found.onmidimessage = onMidi;
  }
  M._web_midi_changed(found ? 1 : 0);
}
