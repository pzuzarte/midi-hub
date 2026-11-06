"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Routing = require("../routing.js");

const route = (fields) => Routing.route({ from: "Keys", to: "Protein", ...fields });

test("ports are recognised by name", () => {
  assert.equal(Routing.guessRole("Bass Station II"), "bassStation");
  assert.equal(Routing.guessRole("S-1"), "s1");
  assert.equal(Routing.guessRole("Waldorf Protein"), "protein");
  assert.equal(Routing.guessRole("MPC Sample"), "mpcSample");
  assert.equal(Routing.guessRole("MPC One MIDI Port"), "mpcOne");
  assert.equal(Routing.guessRole("Arturia KeyStep 37"), "keyboard");
  assert.equal(Routing.guessRole("IAC Driver Bus 1"), "other");
  assert.equal(Routing.guessRole("JS-10"), "other");
});

test("notes pass through, moved to the target's channel and transposed", () => {
  assert.deepEqual(Routing.transform([0x90, 60, 100], route({ toChannel: 3 })), [0x92, 60, 100]);
  assert.deepEqual(Routing.transform([0x85, 60, 0], route()), [0x85, 60, 0]);
  assert.deepEqual(Routing.transform([0x90, 60, 100], route({ transpose: -12 })), [0x90, 48, 100]);
  assert.equal(Routing.transform([0x90, 120, 100], route({ transpose: 12 })), null);
  assert.equal(Routing.transform([0x90, 60, 100], route({ notes: false })), null);
});

test("a route can listen to one channel only", () => {
  const s1 = route({ fromChannel: 3, toChannel: 1 });
  assert.deepEqual(Routing.transform([0x92, 64, 90], s1), [0x90, 64, 90]);
  assert.equal(Routing.transform([0x90, 64, 90], s1), null);
});

test("controllers, programs and clock each pass only when allowed", () => {
  const plain = route();
  assert.deepEqual(Routing.transform([0xB0, 74, 10], plain), [0xB0, 74, 10]);
  assert.deepEqual(Routing.transform([0xE0, 0, 64], plain), [0xE0, 0, 64]);
  assert.deepEqual(Routing.transform([0xD0, 50], plain), [0xD0, 50]);
  assert.equal(Routing.transform([0xC0, 5], plain), null);
  assert.equal(Routing.transform([0xF8], plain), null);
  assert.equal(Routing.transform([0xB0, 74, 10], route({ controls: false })), null);
  assert.deepEqual(Routing.transform([0xC0, 5], route({ programs: true, toChannel: 2 })), [0xC1, 5]);
  const clock = route({ clock: true, notes: false, controls: false });
  for (const status of [0xF8, 0xFA, 0xFB, 0xFC]) assert.deepEqual(Routing.transform([status], clock), [status]);
  assert.deepEqual(Routing.transform([0xF2, 1, 2], clock), [0xF2, 1, 2]);
  assert.equal(Routing.transform([0xFE], clock), null, "active sensing stays local");
  assert.equal(Routing.transform([0xF0, 0x41, 0xF7], clock), null);
  assert.equal(Routing.transform([0x90, 60, 100], clock), null);
});

test("held notes are released when a route stops", () => {
  const held = Routing.tracker();
  held.note([0x92, 60, 100]);
  held.note([0x92, 64, 100]);
  held.note([0x82, 60, 0]);
  held.note([0x92, 67, 0]);
  assert.equal(held.size, 1);
  assert.deepEqual(held.release(), [[0x82, 64, 0]]);
  assert.equal(held.size, 0);
});

test("a device's input and output count as the same device", () => {
  assert.ok(Routing.sameDevice("S-1", "S-1"));
  assert.ok(Routing.sameDevice("MPC One MIDI In", "MPC One MIDI Out"));
  assert.ok(!Routing.sameDevice("S-1", "Protein"));
});

test("messages are described for the monitor", () => {
  assert.equal(Routing.describe([0x92, 60, 100]), "Ch 3 Note on C4 vel 100");
  assert.equal(Routing.describe([0x90, 61, 0]), "Ch 1 Note off C#4");
  assert.equal(Routing.describe([0xB0, 74, 3]), "Ch 1 CC 74 = 3");
  assert.equal(Routing.describe([0xE0, 0, 64]), "Ch 1 Pitch bend 0");
  assert.equal(Routing.describe([0xFA]), "Start");
});
