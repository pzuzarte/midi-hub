"use strict";

const STORE_KEY = "midi-hub";
const THEME_KEY = "midi-hub-theme";
const MONITOR_LINES = 200;
const LIGHT_MS = 120;

const $ = (id) => document.getElementById(id);
const INSTRUMENTS = Routing.INSTRUMENTS;
const ROLE_NAMES = { keyboard: "Keyboard", other: "Other", ...Object.fromEntries(INSTRUMENTS.map((item) => [item.id, item.name])) };

const state = {
  routes: [],
  roles: {}, // Port name to role, where the name alone guessed wrong.
  channels: {}, // Instrument id to the channel it listens on, 1-16.
  keysOctave: 0,
  clockFrom: "",
  scenes: [],
  monitorOn: false,
};

const live = {
  midi: null,
  inputs: new Map(),
  outputs: new Map(),
  held: new Map(), // Route id to the notes it's holding.
  lights: new Map(),
  saveTimer: null,
};

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").title = message;
  $("status").classList.toggle("error", isError);
}

/* ---------- Saving in this browser ---------- */

function saveSoon() {
  window.clearTimeout(live.saveTimer);
  live.saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (error) {
      setStatus("Couldn't save in this browser. Use Back up to keep your setup.", true);
    }
  }, 300);
}

// Keeps only what this page understands, as saved data or a backup file could be anything.
function cleanData(data) {
  if (!data || typeof data !== "object") throw new Error("It isn't a MIDI Hub setup.");
  const text = (value) => (typeof value === "string" ? value : "");
  const channel = (value) => (Number.isInteger(value) && value >= 1 && value <= 16 ? value : null);
  const routes = (list) => (Array.isArray(list) ? list : []).filter((item) => item && typeof item === "object").map((item) => Routing.route({
    id: text(item.id) || undefined,
    from: text(item.from),
    fromChannel: channel(item.fromChannel) || 0,
    to: text(item.to),
    toChannel: channel(item.toChannel) || 0,
    notes: item.notes !== false,
    controls: item.controls !== false,
    programs: item.programs === true,
    clock: item.clock === true,
    transpose: Number.isInteger(item.transpose) && Math.abs(item.transpose) <= 48 ? item.transpose : 0,
    on: item.on !== false,
    quick: ["keys", "s1", "clock"].includes(item.quick) ? item.quick : null,
  }));
  const roles = {};
  for (const [name, role] of Object.entries(data.roles || {})) if (ROLE_NAMES[role]) roles[name] = role;
  const channels = {};
  for (const item of INSTRUMENTS) if (channel(data.channels?.[item.id])) channels[item.id] = data.channels[item.id];
  return {
    routes: routes(data.routes),
    roles,
    channels,
    keysOctave: Number.isInteger(data.keysOctave) && Math.abs(data.keysOctave) <= 4 ? data.keysOctave : 0,
    clockFrom: text(data.clockFrom),
    scenes: (Array.isArray(data.scenes) ? data.scenes : []).filter((scene) => scene && typeof scene.name === "string")
      .map((scene) => ({ name: scene.name.slice(0, 60), routes: routes(scene.routes), clockFrom: text(scene.clockFrom), keysOctave: Number.isInteger(scene.keysOctave) ? scene.keysOctave : 0 })),
    monitorOn: data.monitorOn === true,
  };
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved) Object.assign(state, cleanData(saved));
  } catch (error) {
    // A missing or unreadable save just means starting fresh.
  }
}

/* ---------- Devices ---------- */

const roleOf = (name) => state.roles[name] ?? Routing.guessRole(name);
const channelOf = (id) => state.channels[id] ?? INSTRUMENTS.find((item) => item.id === id).channel;
const instrumentName = (id) => ROLE_NAMES[id] || id;
const outputFor = (role) => [...live.outputs.keys()].find((name) => roleOf(name) === role) || null;
const inputFor = (role) => [...live.inputs.keys()].find((name) => roleOf(name) === role) || null;

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiPill("MIDI needs Chrome or Edge", "warn");
    return;
  }
  $("midi-retry").hidden = true;
  try {
    live.midi = await navigator.requestMIDIAccess({ sysex: false });
  } catch (error) {
    setMidiPill("MIDI blocked", "warn");
    $("midi-retry").hidden = false;
    setStatus(`Chrome blocked MIDI (${error.name}). Click the icon left of the address, set MIDI devices to Allow, then click Allow MIDI.`, true);
    return;
  }
  live.midi.onstatechange = refreshPorts;
  refreshPorts();
  setStatus("Ready. Click an instrument under Quick routes to start.");
}

function setMidiPill(text, kind) {
  $("midi-state").textContent = text;
  $("midi-state").className = `pill ${kind || ""}`;
}

function refreshPorts() {
  if (!live.midi) return;
  for (const port of live.inputs.values()) port.onmidimessage = null;
  live.inputs = new Map([...live.midi.inputs.values()].filter((port) => port.state !== "disconnected").map((port) => [port.name, port]));
  live.outputs = new Map([...live.midi.outputs.values()].filter((port) => port.state !== "disconnected").map((port) => [port.name, port]));
  for (const [name, port] of live.inputs) port.onmidimessage = (event) => handleInput(name, event.data);
  const found = INSTRUMENTS.filter((item) => outputFor(item.id)).length;
  setMidiPill(`${found} of ${INSTRUMENTS.length} instruments`, found ? "ok" : "warn");
  renderAll();
}

/* ---------- Routing ---------- */

function handleInput(name, data) {
  if (data[0] === 0xFE) return;
  flash(name);
  if (state.monitorOn && data[0] !== 0xF8) log(`In   ${name.padEnd(18).slice(0, 18)} ${Routing.describe(data)}`);
  for (const item of state.routes) {
    if (!item.on || item.from !== name) continue;
    const output = live.outputs.get(item.to);
    if (!output) continue;
    const message = Routing.transform(data, item);
    if (!message) continue;
    try {
      output.send(message);
    } catch (error) {
      continue;
    }
    heldFor(item).note(message);
    flash(item.to);
  }
}

function heldFor(item) {
  if (!live.held.has(item.id)) live.held.set(item.id, Routing.tracker());
  return live.held.get(item.id);
}

// Ends a route's held notes, before it changes or goes away.
function releaseRoute(item) {
  const held = live.held.get(item.id);
  if (!held) return;
  const output = live.outputs.get(item.to);
  for (const message of held.release()) output?.send(message);
}

function addRoute(fields) {
  if (fields.from && fields.to && Routing.sameDevice(fields.from, fields.to)) {
    setStatus(`${fields.from} can't be routed to itself, as that would loop.`, true);
    return null;
  }
  const item = Routing.route(fields);
  state.routes.push(item);
  return item;
}

function removeRoute(item) {
  releaseRoute(item);
  live.held.delete(item.id);
  state.routes = state.routes.filter((other) => other !== item);
}

function changeRoute(item, changes) {
  const next = { ...item, ...changes };
  if (next.from && next.to && Routing.sameDevice(next.from, next.to)) {
    setStatus(`${next.from} can't be routed to itself, as that would loop.`, true);
    renderRoutes();
    return;
  }
  releaseRoute(item);
  Object.assign(item, changes);
  saveSoon();
  renderAll();
}

/* ---------- Quick routes ---------- */

const QUICK = {
  keys: {
    source: () => inputFor("keyboard"),
    missing: "No keyboard found. Set your keyboard controller to Keyboard in the Devices list.",
    fields: (id) => ({ fromChannel: 0, toChannel: channelOf(id), notes: true, controls: true, transpose: state.keysOctave * 12 }),
  },
  s1: {
    source: () => inputFor("s1"),
    missing: "The S-1 isn't connected.",
    fields: (id) => ({ fromChannel: channelOf("s1"), toChannel: channelOf(id), notes: true, controls: false }),
  },
  clock: {
    source: () => (live.inputs.has(state.clockFrom) ? state.clockFrom : null),
    missing: "Choose where the clock comes from first.",
    fields: () => ({ notes: false, controls: false, clock: true }),
  },
};

const quickRoute = (kind, output) => state.routes.find((item) => item.quick === kind && item.to === output);

function toggleQuick(kind, id) {
  const output = outputFor(id);
  if (!output) {
    setStatus(`${instrumentName(id)} isn't connected.`, true);
    return;
  }
  const existing = quickRoute(kind, output);
  if (existing) {
    removeRoute(existing);
  } else {
    const source = QUICK[kind].source();
    if (!source) {
      setStatus(QUICK[kind].missing, true);
      return;
    }
    if (!addRoute({ from: source, to: output, quick: kind, ...QUICK[kind].fields(id) })) return;
  }
  saveSoon();
  renderAll();
  const verb = { keys: "The keyboard plays", s1: "The S-1 sequencer plays", clock: "Clock goes to" }[kind];
  const playing = INSTRUMENTS.filter((item) => outputFor(item.id) && quickRoute(kind, outputFor(item.id))).map((item) => item.name);
  setStatus(playing.length ? `${verb} ${playing.join(", ")}.` : `${verb} nothing now.`);
}

function setKeysOctave(octave) {
  state.keysOctave = octave;
  for (const item of state.routes.filter((route) => route.quick === "keys")) {
    releaseRoute(item);
    item.transpose = octave * 12;
  }
  saveSoon();
  renderRoutes();
}

function setClockSource(name) {
  state.clockFrom = name;
  for (const item of [...state.routes.filter((route) => route.quick === "clock")]) {
    if (!name || Routing.sameDevice(name, item.to)) removeRoute(item);
    else item.from = name;
  }
  saveSoon();
  renderAll();
}

// An instrument's channel follows into the quick routes that use it.
function setChannel(id, channel) {
  state.channels[id] = channel;
  const output = outputFor(id);
  for (const item of state.routes) {
    if ((item.quick === "keys" || item.quick === "s1") && item.to === output) {
      releaseRoute(item);
      item.toChannel = channel;
    }
    if (id === "s1" && item.quick === "s1") item.fromChannel = channel;
  }
  saveSoon();
  renderAll();
}

function setRole(name, role) {
  if (role === Routing.guessRole(name)) delete state.roles[name];
  else state.roles[name] = role;
  saveSoon();
  renderAll();
}

/* ---------- Panic ---------- */

function panic() {
  for (const item of state.routes) releaseRoute(item);
  for (const output of live.outputs.values()) {
    for (let channel = 0; channel < 16; channel += 1) {
      output.send([0xB0 | channel, 123, 0]);
      output.send([0xB0 | channel, 120, 0]);
    }
  }
  setStatus(live.outputs.size ? "Sent all notes off to every instrument." : "No MIDI outputs connected.", !live.outputs.size);
}

/* ---------- Setups ---------- */

function renderScenes() {
  $("scene").replaceChildren(new Option(state.scenes.length ? "Choose a setup" : "No saved setups", ""),
    ...state.scenes.map((scene, index) => new Option(scene.name, String(index))));
  $("scene-delete").disabled = !state.scenes.length;
}

function saveScene() {
  const name = window.prompt("Name this setup", "")?.trim();
  if (!name) return;
  const scene = { name: name.slice(0, 60), routes: JSON.parse(JSON.stringify(state.routes)), clockFrom: state.clockFrom, keysOctave: state.keysOctave };
  const existing = state.scenes.findIndex((item) => item.name.toLowerCase() === scene.name.toLowerCase());
  if (existing >= 0 && !window.confirm(`Replace the setup "${state.scenes[existing].name}"?`)) return;
  if (existing >= 0) state.scenes[existing] = scene;
  else state.scenes.push(scene);
  saveSoon();
  renderScenes();
  $("scene").value = String(existing >= 0 ? existing : state.scenes.length - 1);
  setStatus(`Saved the setup "${scene.name}" with ${scene.routes.length} routes.`);
}

function loadScene(index) {
  const scene = state.scenes[index];
  if (!scene) return;
  for (const item of [...state.routes]) removeRoute(item);
  state.routes = JSON.parse(JSON.stringify(scene.routes));
  state.clockFrom = scene.clockFrom;
  state.keysOctave = scene.keysOctave;
  saveSoon();
  renderAll();
  const missing = state.routes.filter((item) => !live.inputs.has(item.from) || !live.outputs.has(item.to)).length;
  setStatus(`Loaded "${scene.name}".${missing ? ` ${missing} of its routes use a device that isn't connected.` : ""}`, Boolean(missing));
}

function deleteScene() {
  const index = Number($("scene").value);
  const scene = $("scene").value === "" ? null : state.scenes[index];
  if (!scene) {
    setStatus("Choose a setup to delete first.", true);
    return;
  }
  if (!window.confirm(`Delete the setup "${scene.name}"?`)) return;
  state.scenes.splice(index, 1);
  saveSoon();
  renderScenes();
  setStatus(`Deleted "${scene.name}".`);
}

function downloadBackup() {
  const file = new Blob([JSON.stringify({ app: "midi-hub", version: 1, ...state }, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `midi-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus("Saved your routes, setups and device settings to a file.");
}

async function restoreBackup(file) {
  let data;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed?.app !== "midi-hub") throw new Error("It isn't a MIDI Hub backup.");
    data = cleanData(parsed);
  } catch (error) {
    setStatus(`Couldn't restore ${file.name}: ${error.message}`, true);
    return;
  }
  if (!window.confirm(`Replace your routes, setups and device settings with the ones in ${file.name}?`)) return;
  for (const item of [...state.routes]) removeRoute(item);
  Object.assign(state, data);
  saveSoon();
  renderAll();
  setStatus(`Restored ${file.name}.`);
}

/* ---------- Showing it ---------- */

function chip(label, pressed, missing, onClick, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `chip${missing ? " missing" : ""}`;
  button.textContent = label;
  button.setAttribute("aria-pressed", String(pressed));
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

function renderQuick() {
  const keys = inputFor("keyboard");
  $("keys-source").textContent = keys || "No keyboard found";
  $("s1-source").textContent = inputFor("s1") ? `On channel ${channelOf("s1")}` : "S-1 not connected";
  for (const kind of ["keys", "s1", "clock"]) {
    const targets = INSTRUMENTS.filter((item) => {
      if (kind === "s1" && item.id === "s1") return false;
      if (kind === "clock" && state.clockFrom && roleOf(state.clockFrom) === item.id) return false;
      return true;
    });
    $(`${kind}-targets`).replaceChildren(...targets.map((item) => {
      const output = outputFor(item.id);
      const on = Boolean(output && quickRoute(kind, output));
      const title = output ? `${on ? "Stop routing" : "Route"} to ${item.name} on channel ${channelOf(item.id)}` : `${item.name} isn't connected`;
      return chip(item.name, on, !output, () => toggleQuick(kind, item.id), title);
    }));
  }
  const sources = [...live.inputs.keys()];
  if (state.clockFrom && !live.inputs.has(state.clockFrom)) sources.push(state.clockFrom);
  $("clock-source").replaceChildren(new Option("Nowhere", ""), ...sources.map((name) => new Option(
    `${roleOf(name) === "other" ? name : instrumentName(roleOf(name))}${live.inputs.has(name) ? "" : " (not connected)"}`, name)));
  $("clock-source").value = state.clockFrom;
  const octaves = [];
  for (let octave = -3; octave <= 3; octave += 1) octaves.push(new Option(octave > 0 ? `+${octave}` : String(octave), String(octave)));
  $("keys-octave").replaceChildren(...octaves);
  $("keys-octave").value = String(state.keysOctave);
}

function portSelect(names, value, label, onChange) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  const all = [...names];
  if (value && !all.includes(value)) all.push(value);
  select.append(new Option("Choose", ""), ...all.map((name) => new Option(`${name}${names.includes(name) ? "" : " (not connected)"}`, name)));
  select.value = value;
  select.classList.toggle("missing", Boolean(value) && !names.includes(value));
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function channelSelect(value, first, label, onChange) {
  const select = document.createElement("select");
  select.className = "channel";
  select.setAttribute("aria-label", label);
  select.append(new Option(first, "0"));
  for (let channel = 1; channel <= 16; channel += 1) select.append(new Option(String(channel), String(channel)));
  select.value = String(value);
  select.addEventListener("change", () => onChange(Number(select.value)));
  return select;
}

function checkbox(checked, label, onChange) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked));
  return input;
}

function renderRoutes() {
  const inputs = [...live.inputs.keys()];
  const outputs = [...live.outputs.keys()];
  $("routes-empty").hidden = state.routes.length > 0;
  $("routes").replaceChildren(...state.routes.map((item, index) => {
    const row = document.createElement("tr");
    row.classList.toggle("off", !item.on);
    const n = index + 1;
    const transpose = document.createElement("input");
    transpose.type = "number";
    transpose.min = -48;
    transpose.max = 48;
    transpose.step = 1;
    transpose.value = String(item.transpose);
    transpose.setAttribute("aria-label", `Route ${n} transpose`);
    transpose.addEventListener("change", () => {
      const value = Math.max(-48, Math.min(48, Math.round(Number(transpose.value) || 0)));
      changeRoute(item, { transpose: value });
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "route-delete";
    remove.textContent = "x";
    remove.title = "Remove this route";
    remove.setAttribute("aria-label", `Remove route ${n}`);
    remove.addEventListener("click", () => {
      removeRoute(item);
      saveSoon();
      renderAll();
    });
    const cells = [
      checkbox(item.on, `Route ${n} on`, (on) => changeRoute(item, { on })),
      portSelect(inputs, item.from, `Route ${n} from`, (from) => changeRoute(item, { from, quick: null })),
      channelSelect(item.fromChannel, "All", `Route ${n} from channel`, (fromChannel) => changeRoute(item, { fromChannel, quick: null })),
      portSelect(outputs, item.to, `Route ${n} to`, (to) => changeRoute(item, { to, quick: null })),
      channelSelect(item.toChannel, "Same", `Route ${n} to channel`, (toChannel) => changeRoute(item, { toChannel, quick: null })),
      checkbox(item.notes, `Route ${n} notes`, (notes) => changeRoute(item, { notes })),
      checkbox(item.controls, `Route ${n} knobs`, (controls) => changeRoute(item, { controls })),
      checkbox(item.programs, `Route ${n} program changes`, (programs) => changeRoute(item, { programs })),
      checkbox(item.clock, `Route ${n} clock`, (clock) => changeRoute(item, { clock })),
      transpose,
      remove,
    ];
    row.append(...cells.map((cell) => {
      const td = document.createElement("td");
      td.append(cell);
      return td;
    }));
    return row;
  }));
}

function renderDevices() {
  const names = [...new Set([...live.inputs.keys(), ...live.outputs.keys()])].sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    const empty = document.createElement("li");
    empty.className = "card-note";
    empty.textContent = live.midi ? "No MIDI devices found. Connect them and turn them on." : "Waiting for MIDI access.";
    $("devices").replaceChildren(empty);
    return;
  }
  live.lights.clear();
  $("devices").replaceChildren(...names.map((name) => {
    const item = document.createElement("li");
    item.className = "device";
    const light = document.createElement("span");
    light.className = "light";
    light.title = "Lights when MIDI passes";
    live.lights.set(name, light);
    const label = document.createElement("span");
    label.className = "device-name";
    label.textContent = name;
    const ways = document.createElement("small");
    ways.textContent = [live.inputs.has(name) && "sends", live.outputs.has(name) && "receives"].filter(Boolean).join(" and ");
    label.append(ways);
    const controls = document.createElement("span");
    controls.className = "device-controls";
    const role = document.createElement("select");
    role.setAttribute("aria-label", `What ${name} is`);
    role.append(...Object.entries(ROLE_NAMES).map(([id, roleName]) => new Option(roleName, id)));
    role.value = roleOf(name);
    role.addEventListener("change", () => setRole(name, role.value));
    controls.append(role);
    const instrument = INSTRUMENTS.find((entry) => entry.id === roleOf(name));
    if (instrument) {
      const select = channelSelect(channelOf(instrument.id), "", `${instrument.name} channel`, (channel) => setChannel(instrument.id, channel));
      select.firstChild.remove();
      select.value = String(channelOf(instrument.id));
      select.title = `The channel ${instrument.name} listens on`;
      controls.append(select);
    }
    item.append(light, label, controls);
    return item;
  }));
}

function renderAll() {
  renderQuick();
  renderRoutes();
  renderDevices();
  renderScenes();
  $("monitor-on").checked = state.monitorOn;
}

function flash(name) {
  const light = live.lights.get(name);
  if (!light) return;
  light.classList.add("lit");
  window.clearTimeout(light.timer);
  light.timer = window.setTimeout(() => light.classList.remove("lit"), LIGHT_MS);
}

function log(line) {
  const monitor = $("monitor");
  const atBottom = monitor.scrollHeight - monitor.scrollTop - monitor.clientHeight < 20;
  const lines = monitor.textContent ? monitor.textContent.split("\n") : [];
  lines.push(line);
  monitor.textContent = lines.slice(-MONITOR_LINES).join("\n");
  if (atBottom) monitor.scrollTop = monitor.scrollHeight;
}

function setTheme(theme) {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-toggle").textContent = theme === "light" ? "Dark mode" : "Light mode";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private windows can refuse storage, so the theme just isn't remembered.
  }
}

/* ---------- Controls ---------- */

function bindControls() {
  $("midi-retry").addEventListener("click", initMidi);
  $("panic").addEventListener("click", panic);
  $("keys-octave").addEventListener("change", (event) => setKeysOctave(Number(event.target.value)));
  $("clock-source").addEventListener("change", (event) => setClockSource(event.target.value));
  $("route-add").addEventListener("click", () => {
    addRoute({ from: inputFor("keyboard") || "", to: "" });
    saveSoon();
    renderRoutes();
  });
  $("scene").addEventListener("change", (event) => { if (event.target.value !== "") loadScene(Number(event.target.value)); });
  $("scene-save").addEventListener("click", saveScene);
  $("scene-delete").addEventListener("click", deleteScene);
  $("monitor-on").addEventListener("change", (event) => {
    state.monitorOn = event.target.checked;
    saveSoon();
  });
  $("monitor-clear").addEventListener("click", () => { $("monitor").textContent = ""; });
  $("export").addEventListener("click", downloadBackup);
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (file) restoreBackup(file);
  });
  $("theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
  $("theme-toggle").textContent = document.documentElement.dataset.theme === "light" ? "Dark mode" : "Light mode";
  $("help-open").addEventListener("click", () => $("help").showModal());
  $("help-close").addEventListener("click", () => $("help").close());
  $("help").addEventListener("click", (event) => { if (event.target === $("help")) $("help").close(); });
  window.addEventListener("keydown", (event) => {
    if (event.key === "?" && !/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName) && !$("help").open) $("help").showModal();
  });
  // Notes held when the page closes would otherwise keep sounding.
  window.addEventListener("pagehide", () => { for (const item of state.routes) releaseRoute(item); });
}

restore();
bindControls();
renderAll();
initMidi().catch((error) => setStatus(error.message, true));
