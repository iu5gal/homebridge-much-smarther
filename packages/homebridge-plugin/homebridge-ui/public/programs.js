// The Programs tab of the setup UI: the temperatures, one line per program, and
// the editor, which opens under the chosen program with the whole week in view.
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
  nameToSave,
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
  /** Days just copied over, shown with a short flash. */
  let flashing = [];

  const levelName = (preset) => t(`ui.level.${preset.toLowerCase()}`);
  const levelTemperature = (preset) => {
    const snapshot = page.snapshot();
    const levels = snapshot?.state?.function === 'COOLING' ? snapshot?.configuration?.cooling : snapshot?.configuration?.heating;
    return levels?.[preset.toLowerCase()];
  };
  const levelText = (preset) => `${levelName(preset)} ${page.degrees(levelTemperature(preset))}`;
  const dayName = (day, style) =>
    new Date(Date.UTC(2024, 0, 1 + DAYS.indexOf(day))).toLocaleDateString(locale(), { weekday: style, timeZone: 'UTC' });

  function button(text, icon, className = 'ms-btn ms-btn-small') {
    const node = element('button', undefined, className);
    node.type = 'button';
    if (icon) {
      const glyph = element('span');
      glyph.dataset.icon = icon;
      node.append(glyph);
    }
    if (text !== undefined) node.append(element('span', text));
    drawIcons(node);
    return node;
  }

  // -------------------------------------------------------------------------
  // The temperatures and the list

  function drawLevels() {
    $('ms-program-levels').replaceChildren(
      ...LEVELS.map((preset) => {
        const tile = element('div', undefined, 'ms-level-tile');
        tile.dataset.level = preset;
        tile.append(element('small', levelName(preset)), element('strong', page.degrees(levelTemperature(preset))));
        return tile;
      }),
    );
  }

  function drawList() {
    drawLevels();
    drawVersions();
    // An open editor stays as it is, whatever arrives from the thermostat.
    if (editing) return;
    const full = view.programs.length >= MAX_PROGRAMS;
    $('ms-program-new').disabled = full;
    $('ms-program-new').title = full ? t('ui.error.program-full') : '';
    const active = page.snapshot()?.state?.programNumber;
    $('ms-programs').replaceChildren(
      ...(view.programs.length === 0 ? [element('p', t('ui.program.none'), 'ms-hint mt-2 mb-0')] : []),
      ...view.programs.map((program) => programLine(program, program.number === active)),
    );
  }

  function programLine(program, inUse) {
    const item = element('div', undefined, `ms-program${inUse ? ' in-use' : ''}`);
    item.dataset.number = String(program.number);
    const row = element('div', undefined, 'ms-program-row');
    const name = element('button', program.name ?? String(program.number), 'ms-program-name');
    name.type = 'button';
    name.addEventListener('click', () => void openExisting(program.number));
    const choice = element('button', undefined, `ms-choice${inUse ? ' active' : ''}`);
    choice.type = 'button';
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
    const edit = button(t('ui.program.edit'), 'pencil', 'ms-btn ms-btn-small ms-program-edit');
    edit.setAttribute('aria-label', t('ui.program.edit'));
    edit.addEventListener('click', () => void openExisting(program.number));
    row.append(name, choice, edit);
    item.append(row);
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
        const restore = button(t('ui.program.restore'));
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
    return true;
  }

  async function afterChange() {
    await load();
    await page.refresh();
  }

  async function restoreVersion(version, name, time) {
    if (!window.confirm(t('ui.program.restoreConfirm', { name, time }))) return;
    if (await change('/program/restore', { number: version.number, id: version.id }, t('ui.program.restored'))) await afterChange();
  }

  // -------------------------------------------------------------------------
  // The editor

  /** Opens the editor under its program, or at the top for a new one. The other lines wait. */
  function open(draft) {
    editing = { selected: DAYS[0], ...draft };
    editing.original = JSON.stringify([editing.name, editing.days]);
    flashing = [];
    const list = $('ms-programs');
    let item = list.querySelector(`[data-number="${editing.number}"]`);
    if (editing.number === undefined) {
      item = element('div', undefined, 'ms-program');
      const row = element('div', undefined, 'ms-program-row');
      row.append(element('span', t('ui.program.new'), 'ms-program-name'));
      item.append(row);
      list.prepend(item);
    }
    const body = element('div', undefined, 'ms-program-body');
    body.id = 'ms-program-editor';
    item.append(body);
    item.querySelector('.ms-btn')?.classList.add('ms-hidden');
    for (const other of list.querySelectorAll('.ms-program')) other.inert = other !== item;
    $('ms-program-new').disabled = true;
    drawEditor();
    if (editing.name === '') $('ms-program-name').focus();
    item.scrollIntoView?.({ block: 'nearest' });
  }

  function close() {
    editing = undefined;
    drawList();
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
    if (editing) return;
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

  const isDirty = () => JSON.stringify([editing.name, editing.days]) !== editing.original;
  const editingInUse = () => editing.number !== undefined && editing.number === page.snapshot()?.state?.programNumber;

  /** Leaves the editor, asking first if something would be lost. */
  function leave() {
    if (isDirty() && !window.confirm(t('ui.program.discard'))) return false;
    close();
    return true;
  }

  function drawEditor() {
    const body = $('ms-program-editor');
    const nameBox = element('div', undefined, 'mt-2 mb-3');
    const nameLabel = element('label', t('ui.program.name'), 'form-label mb-1');
    nameLabel.htmlFor = 'ms-program-name';
    const nameInput = element('input', undefined, 'form-control');
    nameInput.id = 'ms-program-name';
    nameInput.dir = 'auto';
    nameInput.autocomplete = 'off';
    nameInput.value = editing.name;
    // A name already on the thermostat can be longer than a new one, and must still show whole.
    nameInput.maxLength = Math.max(NAME_MAX, editing.existingName?.length ?? 0);
    const nameHint = element('div', undefined, 'ms-hint mt-1');
    nameHint.id = 'ms-program-name-hint';
    nameInput.addEventListener('input', () => {
      editing.name = nameInput.value;
      drawName();
      drawSaveButton();
    });
    nameBox.append(nameLabel, nameInput, nameHint);

    const chooseDay = element('div', t('ui.program.chooseDay'), 'ms-label mb-1');
    const weekBox = element('div');
    weekBox.id = 'ms-program-week';
    const dayBox = element('div', undefined, 'ms-program-day');
    dayBox.id = 'ms-program-day';

    const footer = element('div', undefined, 'ms-editor-footer');
    if (editingInUse()) footer.append(element('div', t('ui.program.activeHint'), 'alert alert-warning py-2 mb-2'));
    const actions = element('div', undefined, 'ms-editor-actions');
    const side = element('div', undefined, 'ms-editor-side');
    if (editing.number !== undefined) side.append(duplicateButton(), deleteButton());
    const main = element('div', undefined, 'ms-editor-side ms-editor-main');
    const cancel = button(t('ui.picker.cancel'), undefined, 'ms-btn ms-btn-quiet');
    cancel.addEventListener('click', () => leave());
    const save = button(t('ui.program.save'), undefined, 'ms-btn ms-btn-primary');
    save.id = 'ms-program-save';
    save.addEventListener('click', () => void saveEditing());
    main.append(cancel, save);
    actions.append(side, main);
    footer.append(actions);

    body.replaceChildren(nameBox, chooseDay, weekBox, dayBox, footer);
    drawName();
    drawWeekAndDay();
  }

  function duplicateButton() {
    const node = button(t('ui.program.duplicate'), 'copy', 'ms-btn ms-btn-small ms-btn-quiet');
    node.disabled = view.programs.length >= MAX_PROGRAMS;
    if (node.disabled) node.title = t('ui.error.program-full');
    node.addEventListener('click', () => {
      const { name, days } = editing;
      if (!leave()) return;
      open({ name: nameForCopy(name), days });
    });
    return node;
  }

  function deleteButton() {
    const node = button(t('ui.program.delete'), 'trash', 'ms-btn ms-btn-small ms-btn-quiet');
    node.disabled = editingInUse();
    if (node.disabled) node.title = t('ui.error.program-in-use');
    node.addEventListener('click', async () => {
      const name = editing.existingName ?? String(editing.number);
      if (!window.confirm(t('ui.program.deleteConfirm', { name }))) return;
      if (!(await change('/program/delete', { number: editing.number }, t('ui.program.deleted')))) return;
      editing = undefined;
      await afterChange();
    });
    return node;
  }

  function drawName() {
    const saved = nameToSave(editing.name, editing.existingName);
    const hint = $('ms-program-name-hint');
    const changed = saved !== '' && saved !== editing.name;
    hint.textContent = changed ? t('ui.program.savedAs', { name: saved }) : t('ui.program.nameHint', { max: NAME_MAX });
    $('ms-program-name').classList.toggle('is-invalid', editing.name !== '' && saved === '');
  }

  /** Nothing to save until something changed: every write goes to the thermostat's flash memory. */
  function drawSaveButton() {
    const unchanged = editing.number !== undefined && !isDirty();
    $('ms-program-save').disabled = unchanged || !canSave(editing, view.maxSlotsPerDay);
  }

  function week() {
    const box = element('div', undefined, 'ms-week');
    for (const day of DAYS) {
      const row = element('button', undefined, `ms-week-row${day === editing.selected ? ' active' : ''}${flashing.includes(day) ? ' ms-flash' : ''}`);
      row.type = 'button';
      row.setAttribute('aria-pressed', String(day === editing.selected));
      row.append(element('span', dayName(day, 'short'), 'ms-week-day'), dayBar(editing.days[day] ?? []));
      row.addEventListener('click', () => {
        editing.selected = day;
        drawWeekAndDay();
      });
      box.append(row);
    }
    const axis = element('div', undefined, 'ms-week-axis');
    const hours = element('span', undefined, 'ms-axis-hours');
    hours.append(...AXIS.map((hour) => element('small', hour)));
    axis.append(element('span'), hours);
    box.append(axis);
    return box;
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

  /** Everything that depends on the slots. Called after each change to them. */
  function drawWeekAndDay() {
    $('ms-program-week').replaceChildren(week());
    flashing = [];
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
    const add = button(t('ui.program.addSlot'), 'plus', 'ms-add');
    const atLimit = mergedDay(slots).length >= view.maxSlotsPerDay;
    add.disabled = atLimit;
    add.addEventListener('click', () => setSlots(withSlotAdded(slots)));
    const problems = dayProblems(slots, view.maxSlotsPerDay);
    const notes = [];
    if (problems.sameTime) notes.push(element('div', t('ui.program.sameTime'), 'ms-problem'));
    if (problems.tooMany) notes.push(element('div', t('ui.program.slotLimit', { max: view.maxSlotsPerDay }), 'ms-problem'));
    $('ms-program-day').replaceChildren(
      element('div', dayName(selected, 'long'), 'ms-program-day-title'),
      ...slots.map((slot, index) => slotRow(slots, slot, index)),
      ...notes,
      add,
      ...(atLimit && !problems.tooMany ? [element('div', t('ui.program.slotLimit', { max: view.maxSlotsPerDay }), 'ms-hint mt-1')] : []),
      copyRow(),
    );
  }

  function slotRow(slots, slot, index) {
    const row = element('div', undefined, 'ms-slot');
    row.dataset.level = slot.preset;
    row.append(element('span', t('ui.program.from')));
    if (index === 0) {
      const time = element('span', slot.time, 'ms-slot-time ms-fixed');
      time.dir = 'ltr';
      row.append(time);
    } else {
      const [hour = '00', minute = '00'] = slot.time.split(':');
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
      row.append(time);
    }
    row.append(levelButtons(slot.preset, (preset) => setSlots(withLevel(slots, index, preset))));
    if (index > 0) {
      const remove = button(undefined, 'close', 'ms-icon-btn ms-slot-remove');
      remove.setAttribute('aria-label', t('ui.program.removeSlot'));
      remove.title = t('ui.program.removeSlot');
      remove.addEventListener('click', () => setSlots(withSlotRemoved(slots, index)));
      row.append(remove);
    } else {
      row.append(element('span', undefined, 'ms-slot-spacer'));
    }
    return row;
  }

  /** One button for each temperature, in its colour. The temperature tells them apart without the colour too. */
  function levelButtons(current, onPick) {
    const group = element('div', undefined, 'ms-levels');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', t('ui.program.level'));
    for (const preset of LEVELS) {
      const temperature = levelTemperature(preset);
      const node = element('button', temperature === undefined ? levelName(preset) : page.degrees(temperature), 'ms-level');
      node.type = 'button';
      node.dataset.level = preset;
      node.setAttribute('role', 'radio');
      node.setAttribute('aria-checked', String(preset === current));
      node.setAttribute('aria-label', levelText(preset));
      node.title = levelText(preset);
      if (preset !== current) node.addEventListener('click', () => onPick(preset));
      group.append(node);
    }
    return group;
  }

  function select(values, current, label) {
    const node = element('select', undefined, 'form-select form-select-sm');
    node.setAttribute('aria-label', label);
    for (const value of values) {
      const option = element('option', value);
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
      const others = targets.filter((day) => day !== selected);
      editing.days = withDayCopied(editing.days, selected, others);
      flashing = others;
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
    const { number, version, name, days, existingName } = editing;
    const merged = Object.fromEntries(DAYS.map((day) => [day, mergedDay(days[day])]));
    const payload = { ...(number === undefined ? {} : { number, version }), name: nameToSave(name, existingName), days: merged };
    if (!(await change('/program/save', payload, t('ui.program.saved')))) return;
    editing = undefined;
    await afterChange();
  }

  function wire() {
    $('ms-program-new').addEventListener('click', () => {
      if (!editing) open({ name: '', days: newProgramDays() });
    });
  }

  return { wire, load };
}
