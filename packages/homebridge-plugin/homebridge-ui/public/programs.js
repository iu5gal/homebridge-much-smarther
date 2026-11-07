// The Programs tab of the setup UI: the list, and the editor on a single screen.
// All dynamic text is set with textContent: program names are typed by users.
// A program goes to the plugin only as values, which it validates again.
import { drawIcons } from './icons.js';
import {
  canSave,
  dayProblems,
  DAYS,
  LEVELS,
  mergedDay,
  NAME_MAX,
  nameForCopy,
  nameIsValid,
  newProgramDays,
  QUARTERS,
  stretches,
  withDayCopied,
  withLevel,
  withSlotAdded,
  withSlotRemoved,
  withTime,
  WORKING_DAYS,
} from './program-edit.js';

const MAX_PROGRAMS = 10;
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
const AXIS = ['0', '6', '12', '18', '24'];

/**
 * @param {object} page what the page offers: `$`, `t`, `element`, `call`, `command`, `refresh`,
 *   `locale`, `degrees`, `thermostatTime`, `snapshot`.
 */
export function createProgramsTab(page) {
  const { $, t, element, call, locale } = page;
  let view = { programs: [], versions: [], maxSlotsPerDay: 10 };
  /** What is being edited: { number?, version?, existingName?, name, days, selected, original }. */
  let editing;

  const levelName = (preset) => t(`ui.level.${preset.toLowerCase()}`);
  const levelTemperatures = () => {
    const snapshot = page.snapshot();
    const levels = snapshot?.state?.function === 'COOLING' ? snapshot?.configuration?.cooling : snapshot?.configuration?.heating;
    return { DAY: levels?.day, NIGHT: levels?.night, AWAY: levels?.away, PROTECTION: levels?.protection };
  };
  const levelText = (preset) => `${levelName(preset)} ${page.degrees(levelTemperatures()[preset])}`;
  const dayName = (day, style) =>
    new Date(Date.UTC(2024, 0, 1 + DAYS.indexOf(day))).toLocaleDateString(locale(), { weekday: style, timeZone: 'UTC' });

  function button(text, icon, className = 'ms-btn ms-btn-small ms-btn-quiet') {
    const node = element('button', undefined, className);
    node.type = 'button';
    if (icon) {
      const glyph = element('span');
      glyph.dataset.icon = icon;
      node.append(glyph);
    }
    node.append(element('span', text));
    drawIcons(node);
    return node;
  }

  /** One day as a bar of coloured stretches. They follow the direction of the language. */
  function dayBar(slots) {
    const bar = element('span', undefined, 'ms-bar');
    for (const stretch of stretches(slots)) {
      const part = element('span', undefined, 'ms-stretch');
      part.dataset.level = stretch.preset;
      part.style.flexGrow = String(stretch.minutes);
      part.title = `${stretch.from}–${stretch.to} ${levelText(stretch.preset)}`;
      bar.append(part);
    }
    return bar;
  }

  /** The week as seven bars. With `onSelect` the days can be chosen. */
  function week(days, selected, onSelect) {
    const box = element('div', undefined, 'ms-week');
    for (const day of DAYS) {
      const row = element(onSelect ? 'button' : 'div', undefined, `ms-week-row${day === selected ? ' active' : ''}`);
      row.append(element('span', dayName(day, 'short'), 'ms-week-day'), dayBar(days[day] ?? []));
      if (onSelect) {
        row.type = 'button';
        row.setAttribute('aria-pressed', String(day === selected));
        row.addEventListener('click', () => onSelect(day));
      }
      box.append(row);
    }
    const axis = element('div', undefined, 'ms-week-axis');
    const hours = element('span', undefined, 'ms-axis-hours');
    hours.append(...AXIS.map((hour) => element('small', hour)));
    axis.append(element('span'), hours);
    box.append(axis);
    return box;
  }

  function legend() {
    const box = element('div', undefined, 'ms-legend');
    for (const preset of LEVELS) {
      const item = element('span', undefined, 'ms-legend-item');
      const dot = element('span', undefined, 'ms-level-dot');
      dot.dataset.level = preset;
      item.append(dot, element('span', levelText(preset)));
      box.append(item);
    }
    return box;
  }

  // -------------------------------------------------------------------------
  // The list

  function drawList() {
    const active = page.snapshot()?.state?.programNumber;
    const full = view.programs.length >= MAX_PROGRAMS;
    $('ms-program-new').disabled = full;
    $('ms-program-new').title = full ? t('ui.error.program-full') : '';
    const list = $('ms-programs');
    if (view.programs.length === 0) {
      list.replaceChildren(element('p', t('ui.program.none'), 'ms-hint my-2'));
    } else {
      list.replaceChildren(...view.programs.map((program) => programItem(program, program.number === active, full)));
    }
    $('ms-program-legend').replaceChildren(legend());
    drawVersions();
  }

  function programItem(program, inUse, full) {
    const item = element('div', undefined, 'ms-program');
    const head = element('div', undefined, 'ms-program-head');
    const choice = element('button', undefined, `ms-choice${inUse ? ' active' : ''}`);
    choice.setAttribute('aria-pressed', String(inUse));
    if (inUse) {
      const check = element('span');
      check.dataset.icon = 'check';
      choice.append(check, element('span', t('ui.program.inUse')));
      drawIcons(choice);
    } else {
      choice.append(element('span', t('ui.program.use')));
      choice.addEventListener('click', () => page.command({ action: 'auto', program: program.number }));
    }
    head.append(element('span', program.name ?? String(program.number), 'ms-program-name'), choice);

    const actions = element('div', undefined, 'ms-program-actions');
    const edit = button(t('ui.program.edit'), 'pencil');
    edit.addEventListener('click', () => void openExisting(program.number));
    const duplicate = button(t('ui.program.duplicate'), 'copy');
    duplicate.disabled = full;
    duplicate.addEventListener('click', () => void openCopy(program.number));
    const remove = button(t('ui.program.delete'), 'trash');
    remove.disabled = inUse;
    if (inUse) remove.title = t('ui.error.program-in-use');
    remove.addEventListener('click', () => void removeProgram(program));
    actions.append(edit, duplicate, remove);

    item.append(head, week(program.days), actions);
    return item;
  }

  function drawVersions() {
    $('ms-program-versions-box').classList.toggle('ms-hidden', view.versions.length === 0);
    $('ms-program-versions').replaceChildren(
      ...view.versions.map((version) => {
        const row = element('div', undefined, 'ms-list-item');
        const name = version.name ?? String(version.number);
        const time = page.thermostatTime(version.savedAt);
        const text = element('span');
        text.append(element('span', name), element('small', ` · ${time}`, 'ms-hint'));
        const restore = button(t('ui.program.restore'), undefined, 'ms-btn ms-btn-small');
        restore.addEventListener('click', () => void restoreVersion(version, name, time));
        row.append(text, restore);
        return row;
      }),
    );
  }

  /** Reads the list again. A plugin that is not running already shows its own message. */
  async function load() {
    try {
      view = await homebridge.request('/programs');
    } catch {
      return;
    }
    drawList();
  }

  /** Runs a change on the thermostat with the page waiting, then shows the result. */
  async function change(path, payload, done) {
    homebridge.showSpinner();
    try {
      await call(path, payload);
    } catch {
      return false;
    } finally {
      homebridge.hideSpinner();
    }
    homebridge.toast.success(done);
    await load();
    await page.refresh();
    return true;
  }

  async function removeProgram(program) {
    const name = program.name ?? String(program.number);
    if (!window.confirm(t('ui.program.deleteConfirm', { name }))) return;
    await change('/program/delete', { number: program.number }, t('ui.program.deleted'));
  }

  async function restoreVersion(version, name, time) {
    if (!window.confirm(t('ui.program.restoreConfirm', { name, time }))) return;
    await change('/program/restore', { number: version.number, id: version.id }, t('ui.program.restored'));
  }

  // -------------------------------------------------------------------------
  // The editor: one screen, with the whole week always in view

  function open(draft) {
    editing = { selected: DAYS[0], ...draft };
    editing.original = JSON.stringify([editing.name, editing.days]);
    $('ms-program-list-view').classList.add('ms-hidden');
    $('ms-program-editor').classList.remove('ms-hidden');
    drawEditor();
    if (editing.name === '') $('ms-program-name').focus();
  }

  function close() {
    editing = undefined;
    $('ms-program-editor').replaceChildren();
    $('ms-program-editor').classList.add('ms-hidden');
    $('ms-program-list-view').classList.remove('ms-hidden');
  }

  async function readProgram(number) {
    homebridge.showSpinner();
    try {
      return await call('/program/read', { number });
    } catch {
      return undefined;
    } finally {
      homebridge.hideSpinner();
    }
  }

  async function openExisting(number) {
    const program = await readProgram(number);
    if (!program) return;
    open({
      number,
      version: program.version,
      ...(program.name === undefined ? {} : { existingName: program.name }),
      name: program.name ?? '',
      days: program.days,
    });
  }

  async function openCopy(number) {
    const program = await readProgram(number);
    if (program) open({ name: nameForCopy(program.name), days: program.days });
  }

  function drawEditor() {
    const box = $('ms-program-editor');
    const card = element('div', undefined, 'card');
    const body = element('div', undefined, 'card-body');
    card.append(body);

    const title = element('div', editing.number === undefined ? t('ui.program.new') : t('ui.program.editTitle'), 'card-title mb-2');
    const nameBox = element('div', undefined, 'mb-3');
    const nameLabel = element('label', t('ui.program.name'), 'form-label');
    nameLabel.htmlFor = 'ms-program-name';
    const nameInput = element('input', undefined, 'form-control');
    nameInput.id = 'ms-program-name';
    nameInput.dir = 'auto';
    nameInput.autocomplete = 'off';
    nameInput.value = editing.name;
    // A name already on the thermostat can be longer than a new one, and must still show whole.
    nameInput.maxLength = Math.max(NAME_MAX, editing.existingName?.length ?? 0);
    const nameHint = element('div', t('ui.program.nameHint', { max: NAME_MAX }), 'ms-hint');
    nameInput.addEventListener('input', () => {
      editing.name = nameInput.value;
      drawName();
      drawSaveButton();
    });
    nameBox.append(nameLabel, nameInput, nameHint);

    const chooseDay = element('div', t('ui.program.chooseDay'), 'ms-label mb-1');
    const weekBox = element('div');
    weekBox.id = 'ms-program-week';
    const legendBox = element('div', undefined, 'mt-2');
    legendBox.append(legend(), element('div', t('ui.program.levelsHint'), 'ms-hint mt-1'));
    const dayBox = element('div', undefined, 'ms-program-day');
    dayBox.id = 'ms-program-day';
    const footer = element('div', undefined, 'ms-editor-footer');
    const active = editing.number !== undefined && editing.number === page.snapshot()?.state?.programNumber;
    if (active) {
      const warning = element('div', t('ui.program.activeHint'), 'alert alert-warning py-2 mb-2');
      footer.append(warning);
    }
    const actions = element('div', undefined, 'ms-modal-actions');
    const cancel = button(t('ui.picker.cancel'));
    cancel.classList.remove('ms-btn-small');
    cancel.addEventListener('click', () => {
      if (isDirty() && !window.confirm(t('ui.program.discard'))) return;
      close();
    });
    const save = button(t('ui.program.save'), undefined, 'ms-btn ms-btn-primary');
    save.id = 'ms-program-save';
    save.addEventListener('click', () => void saveEditing());
    actions.append(cancel, save);
    footer.append(actions);

    body.append(title, nameBox, chooseDay, weekBox, legendBox, dayBox, footer);
    box.replaceChildren(card);
    drawName();
    drawWeekAndDay();
  }

  function drawName() {
    $('ms-program-name').classList.toggle('is-invalid', editing.name !== '' && !nameIsValid(editing.name, editing.existingName));
  }

  function drawSaveButton() {
    $('ms-program-save').disabled = !canSave(editing, view.maxSlotsPerDay);
  }

  const isDirty = () => JSON.stringify([editing.name, editing.days]) !== editing.original;

  /** Everything that depends on the slots. Called after each change to them. */
  function drawWeekAndDay() {
    $('ms-program-week').replaceChildren(
      week(editing.days, editing.selected, (day) => {
        editing.selected = day;
        drawWeekAndDay();
      }),
    );
    drawDay();
    drawSaveButton();
  }

  function setSlots(slots) {
    editing.days = { ...editing.days, [editing.selected]: slots };
    drawWeekAndDay();
  }

  function drawDay() {
    const { selected } = editing;
    const slots = editing.days[selected];
    const rows = slots.map((slot, index) => slotRow(slots, slot, index));
    const add = button(t('ui.program.addSlot'), 'plus', 'ms-btn ms-btn-small');
    const atLimit = mergedDay(slots).length >= view.maxSlotsPerDay;
    add.disabled = atLimit;
    add.addEventListener('click', () => setSlots(withSlotAdded(slots)));
    const problems = dayProblems(slots, view.maxSlotsPerDay);
    const notes = [];
    if (problems.sameTime) notes.push(element('div', t('ui.program.sameTime'), 'ms-problem'));
    if (atLimit || problems.tooMany) notes.push(element('div', t('ui.program.slotLimit', { max: view.maxSlotsPerDay }), problems.tooMany ? 'ms-problem' : 'ms-hint'));
    $('ms-program-day').replaceChildren(
      element('div', dayName(selected, 'long'), 'ms-program-day-title'),
      ...rows,
      ...notes,
      add,
      copyRow(),
    );
  }

  function slotRow(slots, slot, index) {
    const row = element('div', undefined, 'ms-slot');
    const dot = element('span', undefined, 'ms-level-dot');
    dot.dataset.level = slot.preset;
    row.append(dot);
    if (index === 0) {
      const time = element('span', slot.time, 'ms-slot-time ms-fixed');
      time.dir = 'ltr';
      row.append(element('span', t('ui.program.from')), time);
    } else {
      const [hour = '00', minute = '00'] = slot.time.split(':');
      const from = element('span', t('ui.program.from'));
      const hours = select(HOURS, hour, t('ui.picker.hour'));
      const quarters = select(QUARTERS.includes(minute) ? QUARTERS : [...QUARTERS, minute], minute, t('ui.picker.minute'));
      const onTime = () => setSlots(withTime(slots, index, `${hours.value}:${quarters.value}`));
      hours.addEventListener('change', onTime);
      quarters.addEventListener('change', onTime);
      const same = slots.some((other, position) => position !== index && other.time === slot.time);
      hours.classList.toggle('is-invalid', same);
      quarters.classList.toggle('is-invalid', same);
      const time = element('span', undefined, 'ms-slot-time');
      time.dir = 'ltr';
      time.append(hours, element('span', ':'), quarters);
      row.append(from, time);
    }
    const level = select(LEVELS, slot.preset, t('ui.program.level'), levelText);
    level.classList.add('ms-slot-level');
    level.addEventListener('change', () => setSlots(withLevel(slots, index, level.value)));
    row.append(level);
    if (index > 0) {
      const remove = element('button', undefined, 'ms-icon-btn ms-slot-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', t('ui.program.removeSlot'));
      remove.title = t('ui.program.removeSlot');
      const glyph = element('span');
      glyph.dataset.icon = 'close';
      remove.append(glyph);
      drawIcons(remove);
      remove.addEventListener('click', () => setSlots(withSlotRemoved(slots, index)));
      row.append(remove);
    }
    return row;
  }

  function select(values, current, label, text = (value) => value) {
    const node = element('select', undefined, 'form-select form-select-sm');
    node.setAttribute('aria-label', label);
    for (const value of values) {
      const option = element('option', text(value));
      option.value = value;
      node.append(option);
    }
    node.value = current;
    return node;
  }

  function copyRow() {
    const { selected } = editing;
    const box = element('div', undefined, 'ms-copy');
    box.append(element('div', t('ui.program.copyTo'), 'ms-label mb-1'));
    const chips = element('div', undefined, 'ms-chips');
    const copy = (targets) => {
      editing.days = withDayCopied(editing.days, selected, targets);
      drawWeekAndDay();
    };
    for (const day of DAYS.filter((candidate) => candidate !== selected)) {
      const chip = element('button', dayName(day, 'short'), 'ms-chip');
      chip.type = 'button';
      chip.title = dayName(day, 'long');
      chip.addEventListener('click', () => copy([day]));
      chips.append(chip);
    }
    for (const [text, targets] of [
      [t('ui.program.workingDays'), WORKING_DAYS],
      [t('ui.program.everyDay'), DAYS],
    ]) {
      const chip = element('button', text, 'ms-chip ms-chip-wide');
      chip.type = 'button';
      chip.addEventListener('click', () => copy(targets));
      chips.append(chip);
    }
    box.append(chips);
    return box;
  }

  async function saveEditing() {
    const { number, version, name, days } = editing;
    const merged = Object.fromEntries(DAYS.map((day) => [day, mergedDay(days[day])]));
    const saved = await change(
      '/program/save',
      { ...(number === undefined ? {} : { number, version }), name, days: merged },
      t('ui.program.saved'),
    );
    if (saved) close();
  }

  function wire() {
    $('ms-program-new').addEventListener('click', () => open({ name: '', days: newProgramDays() }));
  }

  return { wire, load, drawList };
}
