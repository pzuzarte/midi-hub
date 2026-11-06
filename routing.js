"use strict";
/* What the hub does to each MIDI message, kept apart from the page so it can be tested.
   A route takes messages from one input and passes the kinds it allows to one output,
   optionally changing the channel and transposing notes. */
const Routing = (() => {
  const INSTRUMENTS = [
    { id: "bassStation", name: "Bass Station", match: /bass ?station/i, channel: 1 },
    { id: "s1", name: "S-1", match: /\bS-1\b/i, channel: 3 },
    { id: "protein", name: "Protein", match: /protein/i, channel: 1 },
    { id: "mpcSample", name: "MPC Sample", match: /mpc ?sample/i, channel: 1 },
    { id: "mpcOne", name: "MPC One", match: /mpc ?one/i, channel: 1 },
  ];
  const KEYBOARD = /key ?step|launch ?key|keylab|mini ?lab|impulse|oxygen|keystation|komplete kontrol|nektar|\bmpk|a-?series|sl ?mk|microkey|keyboard/i;

  // What a port probably is from its name: an instrument's id, "keyboard", or "other".
  function guessRole(name) {
    const instrument = INSTRUMENTS.find((item) => item.match.test(name));
    if (instrument) return instrument.id;
    return KEYBOARD.test(name) ? "keyboard" : "other";
  }

  const CLOCK = new Set([0xF8, 0xFA, 0xFB, 0xFC]);

  function route(fields = {}) {
    return {
      id: fields.id || `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      from: fields.from || "",
      fromChannel: fields.fromChannel || 0, // 0 is every channel.
      to: fields.to || "",
      toChannel: fields.toChannel || 0, // 0 keeps the channel it came in on.
      notes: fields.notes ?? true,
      controls: fields.controls ?? true, // Controllers, pitch bend and aftertouch.
      programs: fields.programs ?? false,
      clock: fields.clock ?? false, // Clock, start, stop, continue and song position.
      transpose: fields.transpose || 0,
      on: fields.on ?? true,
      quick: fields.quick || null, // Made by a quick route button: "keys", "s1" or "clock".
    };
  }

  // The message to send for one that arrived, or null if this route doesn't pass it.
  function transform(data, item) {
    const status = data[0];
    if (status >= 0xF0) {
      if (!item.clock) return null;
      if (CLOCK.has(status)) return [status];
      if (status === 0xF2 && data.length >= 3) return [status, data[1], data[2]];
      return null;
    }
    const kind = status & 0xF0;
    const channel = status & 0x0F;
    if (item.fromChannel && channel !== item.fromChannel - 1) return null;
    const out = item.toChannel ? item.toChannel - 1 : channel;
    if (kind === 0x80 || kind === 0x90 || kind === 0xA0) {
      if (!item.notes) return null;
      const note = data[1] + item.transpose;
      if (note < 0 || note > 127) return null;
      return [kind | out, note, data[2]];
    }
    if (kind === 0xB0 || kind === 0xE0) return item.controls ? [kind | out, data[1], data[2]] : null;
    if (kind === 0xD0) return item.controls ? [kind | out, data[1]] : null;
    if (kind === 0xC0) return item.programs ? [kind | out, data[1]] : null;
    return null;
  }

  /* Notes a route has started and not yet ended, so turning a route off, or changing it,
     doesn't leave them hanging. */
  function tracker() {
    const held = new Set();
    return {
      note(message) {
        const kind = message[0] & 0xF0;
        const key = `${message[0] & 0x0F}:${message[1]}`;
        if (kind === 0x90 && message[2] > 0) held.add(key);
        else if (kind === 0x80 || kind === 0x90) held.delete(key);
      },
      release() {
        const offs = [...held].map((key) => {
          const [channel, note] = key.split(":").map(Number);
          return [0x80 | channel, note, 0];
        });
        held.clear();
        return offs;
      },
      get size() { return held.size; },
    };
  }

  // A device's input and output share a name, and sending one back to itself would loop.
  const sameDevice = (a, b) => a.replace(/\s+(in|out|input|output)\b.*$/i, "").trim().toLowerCase()
    === b.replace(/\s+(in|out|input|output)\b.*$/i, "").trim().toLowerCase();

  function describe(data) {
    const status = data[0];
    const names = { 0xF8: "Clock", 0xFA: "Start", 0xFB: "Continue", 0xFC: "Stop", 0xF2: "Song position" };
    if (status >= 0xF0) return names[status] || "System";
    const channel = (status & 0x0F) + 1;
    const kind = status & 0xF0;
    const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const note = (n) => `${NOTES[n % 12]}${Math.floor(n / 12) - 1}`;
    if (kind === 0x90 && data[2] > 0) return `Ch ${channel} Note on ${note(data[1])} vel ${data[2]}`;
    if (kind === 0x80 || kind === 0x90) return `Ch ${channel} Note off ${note(data[1])}`;
    if (kind === 0xB0) return `Ch ${channel} CC ${data[1]} = ${data[2]}`;
    if (kind === 0xE0) return `Ch ${channel} Pitch bend ${((data[2] << 7) | data[1]) - 8192}`;
    if (kind === 0xC0) return `Ch ${channel} Program ${data[1] + 1}`;
    if (kind === 0xD0) return `Ch ${channel} Pressure ${data[1]}`;
    return `Ch ${channel} Aftertouch ${note(data[1])} ${data[2]}`;
  }

  return { INSTRUMENTS, describe, guessRole, route, sameDevice, tracker, transform };
})();

if (typeof module !== "undefined") module.exports = Routing;
