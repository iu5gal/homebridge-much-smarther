// Browser side of the setup UI. `homebridge` is provided by the Homebridge UI.
// All dynamic text is set with textContent: program names are typed by users.
import { choiceFor, dayChoices, endInstant } from './end-time.js';
import { drawIcons } from './icons.js';
import { createProgramsTab } from './programs.js';

const REFRESH_MS = 5_000;
const SETPOINT = { min: 7, max: 40, step: 0.5 };
const $ = (id) => document.getElementById(id);
let messages = {};
let snapshot;
let status = { running: false, pinSet: false };
let config = { platform: 'MuchSmarther' };
/** The page keeps the language it opened with; a new one applies after saving. */
let pageLocale = 'en-GB';
let pageRtl = false;
let setpoint;
let setpointTouched = false;
let manualAt;

const t = (key, values = {}) =>
  (messages[key] ?? key).replace(/\{([a-z]+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
const locale = () => pageLocale;
const number = (value, digits = 1) =>
  new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
/** A value with its unit, written the language's way and kept in one piece inside right-to-left text. */
const unit = (value, options) => `\u2068${new Intl.NumberFormat(locale(), options).format(value)}\u2069`;
const celsius = { style: 'unit', unit: 'celsius', minimumFractionDigits: 1, maximumFractionDigits: 1 };
const degrees = (value) => (value === undefined || value === null ? '–' : unit(value, celsius));
const minutes = (value) => unit(value, { style: 'unit', unit: 'minute', unitDisplay: 'short' });
const percent = (value) => unit(value / 100, { style: 'percent', maximumFractionDigits: 0 });
const onOff = (value) => (value === undefined ? '–' : t(value ? 'ui.on' : 'ui.off'));
const offset = () => snapshot?.state?.utcOffsetMinutes ?? -new Date().getTimezoneOffset();

/** Formats a Date whose UTC fields hold a wall-clock time. */
const wallTime = (date) =>
  date.toLocaleString(locale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
/** A time the thermostat reports ("2026-10-31T06:15:00"): already its wall clock. */
const deviceTime = (text) => wallTime(new Date(`${text.slice(0, 19)}Z`));
/** An instant, on the thermostat's clock. */
const thermostatTime = (iso) => wallTime(new Date(new Date(iso).getTime() + offset() * 60_000));
/** A time the thermostat reports, short: "16:45" today, "sab 31, 06:15" on another day. */
function shortDeviceTime(text) {
  const date = new Date(`${text.slice(0, 19)}Z`);
  const today = new Date(Date.now() + offset() * 60_000);
  const sameDay = date.toISOString().slice(0, 10) === today.toISOString().slice(0, 10);
  return date.toLocaleString(locale(), {
    ...(sameDay ? {} : { weekday: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function errorText(error) {
  const details = error?.error ?? {};
  return t(typeof details.key === 'string' ? details.key : 'ui.error.failed', details);
}

async function call(path, payload) {
  try {
    return await homebridge.request(path, payload);
  } catch (error) {
    homebridge.toast.error(errorText(error));
    throw error;
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Runs `draw` only when `value` differs from last time: no needless redraws, no flicker. */
const drawn = new Map();
function whenChanged(key, value, draw) {
  const json = JSON.stringify(value ?? null);
  if (drawn.get(key) === json) return;
  drawn.set(key, json);
  draw();
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setClass(node, className) {
  if (node.className !== className) node.className = className;
}

// ---------------------------------------------------------------------------
// Tabs

function showTab(name) {
  for (const button of document.querySelectorAll('[data-tab]')) button.classList.toggle('active', button.dataset.tab === name);
  for (const panel of document.querySelectorAll('[data-panel]')) panel.classList.toggle('ms-hidden', panel.dataset.panel !== name);
  if (name === 'programs') void programsTab.load();
}

// ---------------------------------------------------------------------------
// Summary and quick actions

const DOT = { ready: 'ok', connecting: 'busy', waiting: 'busy', 'no-pin': 'bad' };

/** A coloured dot and a word for the connection. */
function showConnection(text, tone) {
  setClass($('ms-connection-dot'), `ms-dot ${tone}`);
  setText($('ms-connection-text'), text);
  $('ms-connection').title = text;
  $('ms-connection').setAttribute('aria-label', text);
}

function renderSummary() {
  const connection = snapshot?.status ?? 'stopped';
  showConnection(
    t(snapshot?.authenticationFailed ? 'ui.connection.rejected' : `ui.connection.${connection}`),
    snapshot?.authenticationFailed ? 'bad' : (DOT[connection] ?? ''),
  );
  setText($('ms-title'), config.name ?? 'Smarther');
  $('ms-not-running').classList.toggle('ms-hidden', status.running);
  $('ms-auth-failed').classList.toggle('ms-hidden', !snapshot?.authenticationFailed);

  const state = snapshot?.state;
  $('ms-summary').classList.toggle('ms-hidden', !state);
  $('ms-waiting').classList.toggle('ms-hidden', Boolean(state) || !status.running);
  if (!state) return;

  whenChanged('summary', [state, snapshot.nextChange], () => {
    $('ms-ambient').textContent =
      state.ambientTemperatureValid === false ? t('ui.status.invalid') : degrees(state.ambientTemperature);
    $('ms-humidity').textContent =
      state.humidityValid === false || state.humidity === undefined
        ? ''
        : `${t('ui.status.humidity')} ${percent(state.humidity)}`;
    let mode = `${t(`ui.mode.${state.mode}`)} · ${t(`ui.function.${state.function}`)}`;
    if (state.mode !== 'AUTOMATIC') {
      mode += ` · ${state.validity?.end ? t('ui.status.until', { time: deviceTime(state.validity.end) }) : t('ui.status.forever')}`;
    }
    const rows = [
      [t('ui.status.mode'), mode],
      [t('ui.status.setpoint'), degrees(state.setpoint)],
      [t('ui.status.load'), t(state.heatingActive || state.coolingActive ? 'ui.status.load.on' : 'ui.status.load.off')],
    ];
    const next = snapshot.nextChange;
    if (next) {
      rows.push([
        t('ui.status.next'),
        `${thermostatTime(next.at)} ${pageRtl ? '←' : '→'} ${t(`ui.level.${next.preset.toLowerCase()}`)} ${degrees(next.temperature)}`,
      ]);
    }
    $('ms-summary-details').replaceChildren(...rows.flatMap(([label, value]) => [element('div', label), element('div', value)]));
    $('much-smarther').classList.toggle('ms-cooling', state.function === 'COOLING');
    renderQuick(state);
    renderSeason(state.function);
  });
}

/** Highlights the tile matching the current mode, with what it means right now. */
function renderQuick(state) {
  const off = state.mode === 'PROTECTION' || state.mode === 'OFF';
  const end = state.validity?.end;
  const until = end ? t('ui.status.until', { time: shortDeviceTime(end) }) : '';
  const program = snapshot?.programs?.find((item) => item.number === state.programNumber);
  const detail = (button) => {
    if (button.dataset.quick === 'auto') {
      return state.mode === 'AUTOMATIC' ? (program?.name ?? (program?.number === 0 ? t('ui.program.system') : '')) : undefined;
    }
    if (button.dataset.quick === 'off') return off && !end ? t('ui.status.forever') : undefined;
    if (button.dataset.quick === 'off-until') return off && end ? until : undefined;
    return state.mode === 'BOOST' && String(state.boostMinutes) === button.dataset.boost ? until : undefined;
  };
  for (const button of document.querySelectorAll('.ms-tile')) {
    const text = detail(button);
    button.classList.toggle('active', text !== undefined);
    button.setAttribute('aria-pressed', String(text !== undefined));
    setText(button.querySelector('small'), text ?? '');
  }
}

function renderSeason(current) {
  for (const button of document.querySelectorAll('[data-season]')) {
    const active = button.dataset.season === current;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  }
}

// ---------------------------------------------------------------------------
// Temperature dial: 270 degrees, from the bottom left to the bottom right

const DIAL = { cx: 100, cy: 100, r: 80, start: 135, sweep: 270 };

function dialPoint(angle) {
  const radians = (angle * Math.PI) / 180;
  return [DIAL.cx + DIAL.r * Math.cos(radians), DIAL.cy + DIAL.r * Math.sin(radians)];
}

function arc(fromAngle, toAngle) {
  const [x1, y1] = dialPoint(fromAngle);
  const [x2, y2] = dialPoint(toAngle);
  const large = toAngle - fromAngle > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${DIAL.r} ${DIAL.r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

function drawDial() {
  const value = setpoint ?? 20;
  const angle = DIAL.start + (DIAL.sweep * (value - SETPOINT.min)) / (SETPOINT.max - SETPOINT.min);
  $('ms-dial-track').setAttribute('d', arc(DIAL.start, DIAL.start + DIAL.sweep));
  $('ms-dial-value').setAttribute('d', arc(DIAL.start, Math.max(DIAL.start + 0.01, angle)));
  const [x, y] = dialPoint(angle);
  $('ms-dial-knob').setAttribute('cx', x.toFixed(2));
  $('ms-dial-knob').setAttribute('cy', y.toFixed(2));
  $('ms-dial-text').textContent = number(value);
  $('ms-dial').setAttribute('aria-valuenow', String(value));
  $('ms-dial').setAttribute('aria-label', t('ui.dial.label'));
}

function setSetpoint(value, touched = true) {
  setpoint = Math.min(SETPOINT.max, Math.max(SETPOINT.min, Math.round(value * 10) / 10));
  if (touched) setpointTouched = true;
  drawDial();
}

function wireDial() {
  const dial = $('ms-dial');
  const fromPointer = (event) => {
    const box = dial.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * 200 - DIAL.cx;
    const y = ((event.clientY - box.top) / box.height) * 200 - DIAL.cy;
    let relative = ((((Math.atan2(y, x) * 180) / Math.PI - DIAL.start) % 360) + 360) % 360;
    if (relative > DIAL.sweep) relative = relative > (DIAL.sweep + 360) / 2 ? 0 : DIAL.sweep;
    const raw = SETPOINT.min + (relative / DIAL.sweep) * (SETPOINT.max - SETPOINT.min);
    setSetpoint(Math.round(raw / SETPOINT.step) * SETPOINT.step);
  };
  dial.addEventListener('pointerdown', (event) => {
    dial.setPointerCapture(event.pointerId);
    fromPointer(event);
  });
  dial.addEventListener('pointermove', (event) => {
    if (dial.hasPointerCapture(event.pointerId)) fromPointer(event);
  });
  dial.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : SETPOINT.step;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') setSetpoint((setpoint ?? 20) + step);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') setSetpoint((setpoint ?? 20) - step);
    else return;
    event.preventDefault();
  });
  $('ms-temp-down').addEventListener('click', () => setSetpoint((setpoint ?? 20) - SETPOINT.step));
  $('ms-temp-up').addEventListener('click', () => setSetpoint((setpoint ?? 20) + SETPOINT.step));
}

// ---------------------------------------------------------------------------
// Manual end choices

function renderManualEnd() {
  const next = snapshot?.nextChange;
  const nextRadio = $('ms-manual-next');
  setText($('ms-next-label'), next ? t('ui.command.until', { time: thermostatTime(next.at) }) : t('ui.command.nextChangeNone'));
  nextRadio.disabled = !next;
  if (!document.querySelector('input[name="ms-manual-end"]:checked') || (!next && nextRadio.checked)) {
    (next ? nextRadio : $('ms-manual-forever')).checked = true;
  }
  setText($('ms-at-label'), manualAt ? t('ui.command.until', { time: thermostatTime(manualAt) }) : t('ui.command.pickEnd'));
}

function manualEnd() {
  const choice = document.querySelector('input[name="ms-manual-end"]:checked')?.value;
  if (choice === 'next' && snapshot?.nextChange) return snapshot.nextChange.at;
  if (choice === 'at' && manualAt) return manualAt;
  return null;
}

// ---------------------------------------------------------------------------
// Day and time picker: a strip of days, then hour and minutes

const MINUTES = ['00', '15', '30', '45'];
const pad = (value) => String(value).padStart(2, '0');
let picker;

function proposedChoice(now) {
  const next = snapshot?.nextChange && choiceFor(new Date(snapshot.nextChange.at), now, offset());
  if (next) return next;
  const hour = (new Date(now.getTime() + offset() * 60_000).getUTCHours() + 1) % 24;
  return { days: hour === 0 ? 1 : 0, time: `${pad(hour)}:00` };
}

function drawPicker() {
  for (const button of $('ms-pick-days').children) {
    const active = Number(button.dataset.days) === picker.days;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('ms-pick-hour').textContent = pad(picker.hour);
  $('ms-pick-minute').textContent = MINUTES[picker.quarter];
  const at = endInstant(picker.days, `${pad(picker.hour)}:${MINUTES[picker.quarter]}`, new Date(), offset());
  const past = at.getTime() <= Date.now();
  $('ms-pick-summary').textContent = t('ui.command.until', { time: thermostatTime(at.toISOString()) });
  $('ms-pick-past').textContent = past ? t('ui.picker.past') : '';
  $('ms-pick-confirm').disabled = past;
  picker.at = at.toISOString();
}

/** Moves the hour (0–23) or the quarter hour (0–3) by `step`, wrapping around. */
function spin(part, step) {
  if (part === 'hour') picker.hour = (picker.hour + step + 24) % 24;
  else picker.quarter = (picker.quarter + step + MINUTES.length) % MINUTES.length;
  drawPicker();
}

function openPicker(title, anchor, onConfirm, onCancel) {
  const now = new Date();
  const proposed = proposedChoice(now);
  picker = {
    days: proposed.days,
    hour: Number(proposed.time.slice(0, 2)),
    quarter: MINUTES.indexOf(proposed.time.slice(3)),
    onConfirm,
    onCancel,
  };
  $('ms-modal-title').textContent = title;
  $('ms-pick-days').replaceChildren(
    ...dayChoices(now, offset()).map(({ days, year, month, day }) => {
      const date = new Date(year, month - 1, day);
      const name =
        days === 0
          ? t('ui.command.today')
          : days === 1
            ? t('ui.command.tomorrow')
            : date.toLocaleDateString(locale(), { weekday: 'short' });
      const button = element('button', undefined, 'ms-day');
      button.type = 'button';
      button.dataset.days = String(days);
      button.title = date.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
      button.append(element('small', name), element('strong', String(day)));
      button.addEventListener('click', () => {
        picker.days = days;
        drawPicker();
      });
      return button;
    }),
  );
  drawPicker();
  $('ms-modal-box').style.visibility = 'hidden';
  $('ms-modal').classList.remove('ms-hidden');
  void placePicker(anchor);
}

/**
 * The part of the page on screen. The page sits in a frame as tall as its
 * content, inside the Homebridge window that scrolls; an IntersectionObserver
 * reports what of the frame that window shows.
 */
function visibleArea() {
  return new Promise((resolve) => {
    const observer = new IntersectionObserver((entries) => {
      observer.disconnect();
      resolve(entries[0]?.intersectionRect);
    });
    observer.observe($('much-smarther'));
  });
}

/** Centres the picker on screen, or puts it next to what opened it if that is unknown. */
async function placePicker(anchor) {
  const page = $('much-smarther').getBoundingClientRect();
  const box = $('ms-modal-box');
  const visible = await visibleArea();
  let top;
  if (visible && visible.height > box.offsetHeight / 2) {
    top = visible.top - page.top + Math.max(8, (visible.height - box.offsetHeight) / 2);
  } else {
    top = anchor.getBoundingClientRect().top - page.top - 60;
  }
  box.style.top = `${Math.round(Math.max(8, Math.min(top, page.height - box.offsetHeight - 8)))}px`;
  box.style.visibility = '';
}

function closePicker(confirmed) {
  $('ms-modal').classList.add('ms-hidden');
  const current = picker;
  picker = undefined;
  if (!current) return;
  if (confirmed) current.onConfirm(current.at);
  else current.onCancel?.();
}

function wirePicker() {
  for (const spinner of document.querySelectorAll('.ms-spin')) {
    const part = spinner.dataset.part;
    for (const button of spinner.querySelectorAll('[data-step]')) {
      button.type = 'button';
      button.setAttribute('aria-label', t(Number(button.dataset.step) > 0 ? 'ui.picker.later' : 'ui.picker.earlier'));
      button.addEventListener('click', () => spin(part, Number(button.dataset.step)));
    }
    const value = spinner.querySelector('output');
    value.setAttribute('aria-label', t(part === 'hour' ? 'ui.picker.hour' : 'ui.picker.minute'));
    value.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') spin(part, 1);
      else if (event.key === 'ArrowDown') spin(part, -1);
      else return;
      event.preventDefault();
    });
    value.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (Math.abs(event.deltaY) >= 1) spin(part, event.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
  }
  $('ms-pick-close').setAttribute('aria-label', t('ui.picker.cancel'));
  $('ms-pick-close').addEventListener('click', () => closePicker(false));
  $('ms-pick-cancel').addEventListener('click', () => closePicker(false));
  $('ms-pick-confirm').addEventListener('click', () => closePicker(true));
  $('ms-modal').addEventListener('click', (event) => {
    if (event.target === $('ms-modal')) closePicker(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picker) closePicker(false);
  });
}

// ---------------------------------------------------------------------------
// Programs and thermostat settings

const programsTab = createProgramsTab({
  $,
  t,
  element,
  call,
  locale,
  degrees,
  thermostatTime,
  command: (payload) => command(payload),
  refresh: () => refresh(),
  snapshot: () => snapshot,
});

/** The list follows the programs on the thermostat, also when they change elsewhere. */
function renderPrograms() {
  whenChanged('programs', [snapshot?.programs, snapshot?.state?.programNumber, snapshot?.configuration], () => void programsTab.load());
}

function renderThermostat() {
  const configuration = snapshot?.configuration;
  const diagnostic = snapshot?.diagnostic;
  whenChanged('thermostat', [configuration, diagnostic], () => {
    $('ms-levels').replaceChildren(
      ...['day', 'night', 'away', 'protection'].map((level) => {
        const row = element('tr');
        row.append(
          element('th', t(`ui.level.${level}`)),
          element('td', degrees(configuration?.heating?.[level])),
          element('td', degrees(configuration?.cooling?.[level])),
        );
        return row;
      }),
    );
    const sensors = [diagnostic?.humidityAndTemperatureSensorWorking, diagnostic?.capacitiveSensorWorking];
    const brightness = configuration?.standByBrightness?.replace('STAND_BY_BRIGHTNESS_', '').replaceAll('_', ' ').toLowerCase();
    const facts = [
      [t('ui.settings.hysteresis'), degrees(configuration?.heating?.regulationBand)],
      [t('ui.settings.calibration'), degrees(configuration?.ambientTemperatureCalibration)],
      [t('ui.settings.keys'), onOff(configuration?.keysEnabled)],
      [t('ui.settings.buzzer'), onOff(configuration?.buzzer)],
      [t('ui.settings.haptic'), onOff(configuration?.haptic)],
      [t('ui.settings.brightness'), brightness ?? '–'],
      [t('ui.diag.firmware'), diagnostic?.applicationFirmwareVersion ?? '–'],
      [t('ui.diag.hardware'), diagnostic?.hardwareVersion ?? '–'],
      [t('ui.diag.model'), [diagnostic?.brand, diagnostic?.deviceType].filter(Boolean).join(' ') || '–'],
      [t('ui.diag.sensors'), diagnostic ? t(sensors.includes(false) ? 'ui.diag.fault' : 'ui.diag.ok') : '–'],
    ];
    $('ms-facts').replaceChildren(
      ...facts.map(([label, value]) => {
        const fact = element('div', undefined, 'ms-fact');
        fact.append(element('small', label), element('div', value));
        return fact;
      }),
    );
  });
}

function renderConnection() {
  const connected = status.pinSet && snapshot?.status === 'ready';
  setText($('ms-pin-text'), t(connected ? 'ui.connect.done' : status.pinSet ? 'ui.pin.set' : 'ui.pin.unset'));
  setClass($('ms-pin-dot'), `ms-dot ${connected ? 'ok' : status.pinSet ? 'busy' : 'bad'}`);
  $('ms-retry').classList.toggle('ms-hidden', connected || !status.pinSet || !status.running);
}

function render(next) {
  status = next;
  snapshot = next.snapshot;
  renderConnection();
  renderSummary();
  renderPrograms();
  renderThermostat();
  renderManualEnd();
  renderProgramChoices();
  if (!setpointTouched && snapshot?.state?.setpoint !== undefined && snapshot.state.setpoint !== setpoint) {
    setSetpoint(snapshot.state.setpoint, false);
  }
}

// ---------------------------------------------------------------------------
// Actions

async function command(payload) {
  await call('/command', payload);
  homebridge.toast.success(t('ui.command.done'));
  await refresh();
}

async function refresh() {
  try {
    render(await homebridge.request('/status'));
  } catch (error) {
    showConnection(errorText(error), 'bad');
  }
}

function fillConfigForm() {
  const set = (id, value) => ($(`ms-cfg-${id}`).value = value === undefined ? '' : String(value));
  set('name', config.name ?? 'Smarther');
  set('host', config.host ?? '');
  set('port', config.port);
  set('language', config.language ?? 'en');
  set('automaticMode', config.automaticMode ?? 'auto');
  set('manualEnd', config.manualEnd ?? 'nextChange');
  set('manualMinutes', config.manualMinutes ?? 120);
  $('ms-cfg-humiditySensor').checked = config.humiditySensor ?? true;
  const boosts = Array.isArray(config.boostSwitches) ? config.boostSwitches : config.boostSwitches === false ? [] : [30, 60, 90];
  for (const box of document.querySelectorAll('[data-boost-switch]')) box.checked = boosts.includes(Number(box.dataset.boostSwitch));
  $('ms-cfg-offSwitch').checked = config.offSwitch ?? false;
  $('ms-cfg-seasonFromHome').checked = config.seasonFromHome ?? false;
  showMinutes();
}

function showMinutes() {
  $('ms-cfg-manualMinutes').classList.toggle('ms-hidden', $('ms-cfg-manualEnd').value !== 'duration');
}

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** A field the plugin would reject is marked, and keeps the last good value. */
function checked(id, valid) {
  $(`ms-cfg-${id}`).classList.toggle('is-invalid', !valid);
  return valid;
}

/**
 * Hands the form to Homebridge on every change, so its own Save button
 * (which also restarts Homebridge) stores what is on screen.
 */
async function updateConfig() {
  const host = $('ms-cfg-host').value.trim();
  const port = $('ms-cfg-port').value.trim();
  const minutes = Number($('ms-cfg-manualMinutes').value);
  const valid = [
    checked('host', HOST.test(host)),
    checked('port', port === '' || (Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535)),
    checked('manualMinutes', Number.isInteger(minutes) && minutes >= 15 && minutes <= 1440 && minutes % 15 === 0),
  ];
  if (valid.includes(false)) return;
  const next = {
    ...config,
    platform: 'MuchSmarther',
    name: $('ms-cfg-name').value.trim() || 'Smarther',
    host,
    language: $('ms-cfg-language').value,
    automaticMode: $('ms-cfg-automaticMode').value,
    manualEnd: $('ms-cfg-manualEnd').value,
    manualMinutes: minutes,
    humiditySensor: $('ms-cfg-humiditySensor').checked,
    boostSwitches: [...document.querySelectorAll('[data-boost-switch]:checked')].map((box) => Number(box.dataset.boostSwitch)),
    programSwitches: programChoices ?? config.programSwitches ?? [],
    offSwitch: $('ms-cfg-offSwitch').checked,
    seasonFromHome: $('ms-cfg-seasonFromHome').checked,
  };
  if (port === '') delete next.port;
  else next.port = Number(port);
  if (next.manualEnd !== 'duration') delete next.manualMinutes;
  config = next;
  await homebridge.updatePluginConfig([next]);
}

// The programs on the thermostat, each with a box for its switch in the Home app.
// `programChoices` stays undefined until the user changes a box, so that
// `programSwitches: true` (every program, also future ones) survives other edits.
let programChoices;

function renderProgramChoices() {
  const programs = (snapshot?.programs ?? []).filter((program) => program.number !== 0);
  whenChanged('program-choices', programs, () => {
    const wanted = config.programSwitches;
    const box = $('ms-cfg-programs');
    if (programs.length === 0) return box.replaceChildren(element('span', t('ui.config.programSwitchesNone'), 'ms-hint'));
    box.replaceChildren(
      ...programs.map((program) => {
        const item = element('div', undefined, 'form-check');
        const input = element('input', undefined, 'form-check-input');
        input.type = 'checkbox';
        input.id = `ms-cfg-program-${program.number}`;
        input.dataset.program = String(program.number);
        input.checked =
          programChoices?.includes(program.number) ??
          (wanted === true || (Array.isArray(wanted) && wanted.includes(program.number)));
        const label = element('label', program.name ?? t('service.program', { number: program.number }), 'form-check-label');
        label.htmlFor = input.id;
        item.append(input, label);
        return item;
      }),
    );
  });
}

function showGateways(gateways) {
  const list = $('ms-gateways');
  if (gateways.length === 0) return list.replaceChildren(element('li', t('ui.cloud.none')));
  list.replaceChildren(
    ...gateways.map((gateway) => {
      const item = element('li', undefined, 'mb-1');
      const button = element('button', t('ui.cloud.choose'), 'ms-btn ms-btn-small ms-btn-primary ms-gap-start');
      button.addEventListener('click', async () => {
        await call('/cloud/choose', { id: gateway.id });
        list.replaceChildren();
        homebridge.toast.success(t('ui.pin.saved'));
        setTimeout(refresh, 2_000);
      });
      item.append(element('span', `${gateway.description} (${gateway.mac})`), button);
      return item;
    }),
  );
}

function wire() {
  for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => showTab(button.dataset.tab));
  for (const button of document.querySelectorAll('[data-boost]')) {
    button.addEventListener('click', () => command({ action: 'boost', minutes: Number(button.dataset.boost) }));
  }
  for (const button of document.querySelectorAll('[data-quick]')) {
    if (button.dataset.quick === 'off-until') {
      button.addEventListener('click', () =>
        openPicker(t('ui.picker.offTitle'), button, (until) => command({ action: 'off', until })),
      );
    } else button.addEventListener('click', () => command({ action: button.dataset.quick }));
  }
  wireDial();
  wirePicker();
  programsTab.wire();
  for (const radio of document.querySelectorAll('input[name="ms-manual-end"]')) {
    radio.addEventListener('change', () => {
      if (radio.value !== 'at' || !radio.checked) return;
      const previous = manualAt;
      openPicker(
        t('ui.picker.manualTitle'),
        radio,
        (until) => {
          manualAt = until;
          renderManualEnd();
        },
        () => {
          if (!previous) (snapshot?.nextChange ? $('ms-manual-next') : $('ms-manual-forever')).checked = true;
          renderManualEnd();
        },
      );
    });
  }
  $('ms-manual-send').addEventListener('click', async () => {
    await command({ action: 'manual', setpoint: setpoint ?? 20, until: manualEnd() });
    setpointTouched = false;
  });
  for (const button of document.querySelectorAll('[data-season]')) {
    button.addEventListener('click', async () => {
      const wanted = button.dataset.season;
      if (wanted === snapshot?.state?.function) return;
      if (!window.confirm(t('ui.command.seasonConfirm', { season: t(`ui.function.${wanted}`) }))) return;
      await command({ action: 'season', function: wanted });
    });
  }
  $('ms-refresh').title = t('ui.refresh');
  $('ms-refresh').setAttribute('aria-label', t('ui.refresh'));
  $('ms-refresh').addEventListener('click', async () => {
    $('ms-refresh').classList.add('ms-busy');
    try {
      await command({ action: 'refresh' });
    } finally {
      $('ms-refresh').classList.remove('ms-busy');
    }
  });
  $('ms-pin-save').addEventListener('click', async () => {
    await call('/pin/save', { pin: $('ms-pin').value });
    $('ms-pin').value = '';
    homebridge.toast.success(t('ui.pin.saved'));
    setTimeout(refresh, 2_000);
  });
  $('ms-reconnect').addEventListener('click', () => command({ action: 'reload' }));
  $('ms-retrieve').addEventListener('click', async () => {
    homebridge.showSpinner();
    try {
      const gateways = await call('/cloud/retrieve', { email: $('ms-email').value, password: $('ms-account-password').value });
      $('ms-account-password').value = '';
      showGateways(gateways);
    } finally {
      homebridge.hideSpinner();
    }
  });
  $('ms-cfg-manualEnd').addEventListener('change', showMinutes);
  $('ms-cfg-programs').addEventListener('change', () => {
    programChoices = [...$('ms-cfg-programs').querySelectorAll('input:checked')].map((input) => Number(input.dataset.program));
    void updateConfig();
  });
  for (const field of document.querySelectorAll('[id^="ms-cfg-"]')) {
    field.addEventListener(field.type === 'checkbox' || field.tagName === 'SELECT' ? 'change' : 'input', () => void updateConfig());
  }
}

async function main() {
  const blocks = await homebridge.getPluginConfig();
  config = blocks[0] ?? config;
  const i18n = await homebridge.request('/i18n', { language: config.language ?? 'en' });
  messages = i18n.messages;
  pageLocale = i18n.locale;
  pageRtl = i18n.rtl;
  const root = $('much-smarther');
  root.lang = i18n.locale;
  root.dir = i18n.rtl ? 'rtl' : 'ltr';
  $('ms-cfg-language').replaceChildren(
    ...i18n.languages.map(({ code, name }) => {
      const option = element('option', name);
      option.value = code;
      option.lang = code;
      return option;
    }),
  );
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-minutes]')) node.textContent = minutes(Number(node.dataset.minutes));
  $('ms-dial-unit').textContent = new Intl.NumberFormat(locale(), celsius)
    .formatToParts(0)
    .filter((part) => part.type === 'unit')
    .map((part) => part.value)
    .join('');
  drawIcons();
  $('ms-email').placeholder = t('ui.cloud.email');
  $('ms-account-password').placeholder = t('ui.cloud.password');
  $('ms-pin').placeholder = t('ui.pin.manual');
  $('ms-cfg-manualMinutes').placeholder = t('ui.config.manualMinutes');
  $('ms-cfg-manualMinutes').setAttribute('aria-label', t('ui.config.manualMinutes'));
  $('ms-pick-days').setAttribute('aria-label', t('ui.picker.day'));
  fillConfigForm();
  wire();
  drawDial();
  const first = await homebridge.request('/status').catch(() => ({ running: false, pinSet: false }));
  render(first);
  const needsSetup = !first.running || !first.pinSet || !config.host || first.snapshot?.authenticationFailed;
  showTab(needsSetup ? 'settings' : 'commands');
  setInterval(() => {
    if (!document.hidden && !picker) void refresh();
  }, REFRESH_MS);
}

main().catch((error) => homebridge.toast.error(errorText(error)));
