// The Programs tab of the setup UI: the temperatures, one line per program, and
// under each open line its editor, with the whole week in view. Several can be
// open at once; the program in use opens by itself.
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
  nameIsTaken,
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
  /** One line per program on the thermostat: { number, node, row, editor? }. */
  const lines = new Map();
  /** New programs being written, not on the thermostat yet: lines without a number. */
  const drafts = new Set();
  const opening = new Set();
  /** The program in use the last time it was opened by itself. */
  let lastInUse;

  const inUseNumber = () => page.snapshot()?.state?.programNumber;
  const programCount = () => view.programs.length + drafts.size;
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

  /** Updates the list around what is open: an editor stays as it is, whatever arrives from the thermostat. */
  function drawList() {
    drawLevels();
    drawVersions();
    const full = programCount() >= MAX_PROGRAMS;
    $('ms-program-new').disabled = full;
    $('ms-program-new').title = full ? t('ui.error.program-full') : '';
    const active = inUseNumber();
    for (const program of view.programs) {
      let line = lines.get(program.number);
      if (!line) {
        line = { number: program.number, node: element('div', undefined, 'ms-program'), row: element('div', undefined, 'ms-program-row') };
        line.node.append(line.row);
        lines.set(program.number, line);
      }
      drawLine(line, program, program.number === active);
    }
    for (const [number, line] of lines) {
      const gone = !view.programs.some((program) => program.number === number);
      if (gone && !line.editor?.isDirty()) lines.delete(number);
    }
    const wanted = [...drafts].map((line) => line.node);
    for (const line of [...lines.values()].sort((a, b) => a.number - b.number)) wanted.push(line.node);
    const list = $('ms-programs');
    if (wanted.length === 0) {
      list.replaceChildren(element('p', t('ui.program.none'), 'ms-hint mt-2 mb-0'));
    } else if (wanted.length !== list.children.length || wanted.some((node, index) => list.children[index] !== node)) {
      // Only when something moved: replacing the nodes would take the focus from a field being typed in.
      list.replaceChildren(...wanted);
    }
    for (const line of [...lines.values(), ...drafts]) line.editor?.refresh();
  }

  function drawLine(line, program, inUse) {
    const name = element('button', program.name ?? String(program.number), 'ms-program-name');
    name.type = 'button';
    name.addEventListener('click', () => void toggle(line));
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
    const open = Boolean(line.editor);
    const text = t(open ? 'ui.program.close' : 'ui.program.edit');
    const edit = button(text, open ? 'up' : 'pencil', 'ms-btn ms-btn-quiet ms-program-toggle');
    edit.setAttribute('aria-label', text);
    edit.setAttribute('aria-expanded', String(open));
    edit.addEventListener('click', () => void toggle(line));
    line.program = program;
    // The title of an open editor stays in place, so that a name being typed keeps the focus.
    const first = line.editor ? line.editor.title : name;
    if (line.row.firstChild !== first) line.row.replaceChildren(first);
    while (line.row.lastChild !== first) line.row.lastChild.remove();
    line.row.append(choice, edit);
  }

  function redrawLine(line) {
    if (line.program) drawLine(line, line.program, line.number === inUseNumber());
  }

  async function toggle(line) {
    if (line.editor) closeEditor(line, true);
    else await openExisting(line.number);
  }

  /** Closes an editor, asking first if `ask` and something would be lost. */
  function closeEditor(line, ask) {
    if (ask && line.editor?.isDirty() && !window.confirm(t('ui.program.discard'))) return false;
    line.editor?.node.remove();
    line.editor = undefined;
    if (drafts.delete(line)) {
      line.node.remove();
      drawList();
    } else {
      redrawLine(line);
      if (!view.programs.some((program) => program.number === line.number)) drawList();
    }
    return true;
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

  /** The program in use is open by itself. When another takes over, the old one closes, unless opened by hand or changed. */
  function followInUse() {
    const active = inUseNumber();
    if (active === undefined || active === lastInUse) return;
    if (active !== 0 && !lines.has(active)) return; // not read yet
    const previous = lines.get(lastInUse);
    lastInUse = active;
    if (previous?.editor?.auto && !previous.editor.isDirty()) closeEditor(previous, false);
    const line = lines.get(active);
    if (line && !line.editor) void openExisting(active, true);
  }

  /** Reads the list again. A plugin that is not running already shows its own message. */
  async function load() {
    try {
      view = await homebridge.request('/programs');
    } catch {
      return;
    }
    drawList();
    followInUse();
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
    if (!(await change('/program/restore', { number: version.number, id: version.id }, t('ui.program.restored')))) return;
    const line = lines.get(version.number);
    if (line?.editor) closeEditor(line, false);
    await afterChange();
    if (version.number === inUseNumber()) await openExisting(version.number, true);
  }

  // -------------------------------------------------------------------------
  // Opening

  /** Reads the program now, since it may have changed in the app. On its own it says nothing if that fails. */
  async function openExisting(number, auto = false) {
    if (opening.has(number)) return;
    opening.add(number);
    if (!auto) homebridge.showSpinner();
    try {
      const program = await (auto ? homebridge.request('/program/read', { number }) : call('/program/read', { number }));
      const line = lines.get(number);
      if (!line || line.editor) return;
      line.editor = createEditor(line, {
        number,
        version: program.version,
        ...(program.name === undefined ? {} : { existingName: program.name }),
        name: program.name ?? '',
        days: program.days,
        auto,
      });
      line.node.append(line.editor.node);
      redrawLine(line);
    } catch {
      // `call` has shown the error. Nothing to open.
    } finally {
      opening.delete(number);
      if (!auto) homebridge.hideSpinner();
    }
  }

  function openNew(name, days) {
    const line = { node: element('div', undefined, 'ms-program'), row: element('div', undefined, 'ms-program-row') };
    line.editor = createEditor(line, { name, days });
    line.row.append(line.editor.title);
    line.node.append(line.row, line.editor.node);
    drafts.add(line);
    drawList();
    line.editor.focusName();
    line.node.scrollIntoView?.({ block: 'nearest' });
  }

  // -------------------------------------------------------------------------
  // One editor. Each has its own program, with its own changes.

  function createEditor(line, draft) {
    const state = { selected: DAYS[0], timeOpen: undefined, ...draft };
    const original = JSON.stringify([state.name, state.days]);
    const isDirty = () => JSON.stringify([state.name, state.days]) !== original;
    /** Days just copied over, shown with a short flash. */
    let flashing = [];
    const inUse = () => state.number !== undefined && state.number === inUseNumber();
    const otherNames = () => view.programs.filter((program) => program.number !== state.number).map((program) => program.name);
    const savedName = () => nameToSave(state.name, state.existingName);
    const nameClash = () => savedName() !== state.existingName && nameIsTaken(savedName(), otherNames());

    const node = element('div', undefined, 'ms-program-body');
    const title = element('span', undefined, 'ms-program-title');
    const titleText = element('span', undefined, 'ms-program-name');
    const rename = button(undefined, 'pencil', 'ms-icon-btn ms-program-rename');
    rename.setAttribute('aria-label', t('ui.program.rename'));
    rename.title = t('ui.program.rename');
    const nameInput = element('input', undefined, 'form-control form-control-sm ms-program-name-field');
    nameInput.dir = 'auto';
    nameInput.autocomplete = 'off';
    nameInput.value = state.name;
    nameInput.placeholder = t('ui.program.name');
    nameInput.setAttribute('aria-label', t('ui.program.name'));
    // A name already on the thermostat can be longer than a new one, and must still show whole.
    nameInput.maxLength = Math.max(NAME_MAX, state.existingName?.length ?? 0);
    const nameHint = element('div', undefined, 'ms-small-hint mb-2');
    let typingName = false;
    /** The name is plain text with a small button beside it, and a field only while it is being changed. */
    function showName(typing) {
      typingName = typing;
      if (typing) title.replaceChildren(nameInput);
      else {
        titleText.textContent = state.name;
        title.replaceChildren(titleText, rename);
      }
      drawName();
    }
    rename.addEventListener('click', () => {
      showName(true);
      nameInput.focus();
      nameInput.select();
    });
    nameInput.addEventListener('input', () => {
      state.name = nameInput.value;
      drawName();
      drawSaveButton();
    });
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') nameInput.blur();
    });
    nameInput.addEventListener('blur', () => {
      if (savedName() !== '' && !nameClash()) showName(false);
    });

    const weekBox = element('div');
    const dayBox = element('div', undefined, 'ms-program-day');
    const note = element('div', t('ui.program.activeHint'), 'ms-note');

    const remove = button(t('ui.program.delete'), 'trash', 'ms-btn ms-btn-quiet ms-editor-delete');
    remove.addEventListener('click', () => void removeProgram());
    const duplicate = button(t('ui.program.duplicate'), 'copy', 'ms-btn ms-btn-quiet ms-editor-duplicate');
    duplicate.addEventListener('click', () => openNew(nameForCopy(state.name, view.programs.map((program) => program.name)), state.days));
    const cancel = button(t('ui.picker.cancel'), undefined, 'ms-btn ms-btn-quiet ms-editor-cancel');
    cancel.addEventListener('click', () => closeEditor(line, true));
    const save = button(t('ui.program.save'), undefined, 'ms-btn ms-btn-primary ms-editor-save');
    save.addEventListener('click', () => void saveProgram());

    const side = element('div', undefined, 'ms-editor-side');
    if (state.number !== undefined) side.append(duplicate, remove);
    const main = element('div', undefined, 'ms-editor-side ms-editor-main');
    main.append(cancel, save);
    const actions = element('div', undefined, 'ms-editor-actions');
    actions.append(side, main);
    node.append(nameHint, weekBox, dayBox, note, actions);

    function drawName() {
      const saved = savedName();
      const clash = nameClash();
      const changed = saved !== '' && saved !== state.name;
      nameHint.textContent = clash
        ? t('ui.error.program-name-taken')
        : changed
          ? t('ui.program.savedAs', { name: saved })
          : t('ui.program.nameHint', { max: NAME_MAX });
      nameHint.classList.toggle('ms-bad', clash);
      nameHint.classList.toggle('ms-hidden', !typingName && !clash && !changed);
      nameInput.classList.toggle('is-invalid', clash || (state.name !== '' && saved === ''));
    }

    /** Nothing to save until something changed: every write goes to the thermostat's flash memory. */
    function drawSaveButton() {
      const unchanged = state.number !== undefined && !isDirty();
      save.disabled = unchanged || nameClash() || !canSave(state, view.maxSlotsPerDay);
    }

    /** What depends on the thermostat rather than on this editor. */
    function refresh() {
      note.classList.toggle('ms-hidden', !inUse());
      remove.disabled = inUse();
      remove.title = inUse() ? t('ui.error.program-in-use') : '';
      duplicate.disabled = programCount() >= MAX_PROGRAMS;
      duplicate.title = duplicate.disabled ? t('ui.error.program-full') : '';
      drawName();
      drawSaveButton();
    }

    function week() {
      const box = element('div', undefined, 'ms-week');
      for (const day of DAYS) {
        const row = element('button', undefined, `ms-week-row${day === state.selected ? ' active' : ''}${flashing.includes(day) ? ' ms-flash' : ''}`);
        row.type = 'button';
        row.setAttribute('aria-pressed', String(day === state.selected));
        row.append(element('span', dayName(day, 'short'), 'ms-week-day'), dayBar(state.days[day] ?? []));
        row.addEventListener('click', () => {
          state.selected = day;
          state.timeOpen = undefined;
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
      weekBox.replaceChildren(week());
      flashing = [];
      drawDay();
      drawSaveButton();
    }

    function setSlots(slots) {
      if (state.timeOpen !== undefined && slots.length !== state.days[state.selected].length) state.timeOpen = undefined;
      state.days = { ...state.days, [state.selected]: slots };
      drawWeekAndDay();
    }

    function drawDay() {
      const slots = state.days[state.selected];
      const add = button(t('ui.program.addSlot'), 'plus', 'ms-add');
      const atLimit = mergedDay(slots).length >= view.maxSlotsPerDay;
      add.disabled = atLimit;
      add.addEventListener('click', () => setSlots(withSlotAdded(slots)));
      const problems = dayProblems(slots, view.maxSlotsPerDay);
      const notes = [];
      if (problems.sameTime) notes.push(element('div', t('ui.program.sameTime'), 'ms-problem'));
      if (problems.tooMany) notes.push(element('div', t('ui.program.slotLimit', { max: view.maxSlotsPerDay }), 'ms-problem'));
      else if (atLimit) notes.push(element('div', t('ui.program.slotLimit', { max: view.maxSlotsPerDay }), 'ms-small-hint'));
      dayBox.replaceChildren(
        element('div', dayName(state.selected, 'long'), 'ms-program-day-title'),
        ...slots.map((slot, index) => slotRow(slots, slot, index)),
        ...notes,
        add,
        copyRow(),
      );
    }

    function slotRow(slots, slot, index) {
      const row = element('div', undefined, 'ms-slot');
      row.dataset.level = slot.preset;
      row.append(element('span', t('ui.program.from'), 'ms-slot-from'));
      if (index === 0) {
        const time = element('span', slot.time, 'ms-time-fixed');
        time.dir = 'ltr';
        row.append(time);
      } else {
        const same = slots.some((other, position) => position !== index && other.time === slot.time);
        const chip = element('button', slot.time, `ms-time-chip${same ? ' ms-bad' : ''}`);
        chip.type = 'button';
        chip.dir = 'ltr';
        chip.setAttribute('aria-expanded', String(state.timeOpen === index));
        chip.setAttribute('aria-label', `${t('ui.program.from')} ${slot.time}`);
        chip.addEventListener('click', () => {
          state.timeOpen = state.timeOpen === index ? undefined : index;
          drawDay();
        });
        row.append(chip);
      }
      row.append(levelButtons(slot.preset, (preset) => setSlots(withLevel(slots, index, preset))));
      if (index > 0) {
        const removeSlot = button(undefined, 'trash', 'ms-icon-btn ms-slot-remove');
        removeSlot.setAttribute('aria-label', t('ui.program.delete'));
        removeSlot.title = t('ui.program.delete');
        removeSlot.addEventListener('click', () => {
          state.timeOpen = undefined;
          setSlots(withSlotRemoved(slots, index));
        });
        row.append(removeSlot);
      } else {
        row.append(element('span'));
      }
      if (state.timeOpen === index) row.append(timePanel(slots, slot, index));
      return row;
    }

    /** Hours and quarters as buttons: two touches for any time, on any screen. It closes when the minutes are chosen. */
    function timePanel(slots, slot, index) {
      const [hour = '00', minute = '00'] = slot.time.split(':');
      const panel = element('div', undefined, 'ms-time-panel');
      panel.dir = 'ltr';
      const choose = (time, closing) => {
        const moved = withTime(slots, index, time);
        state.timeOpen = closing ? undefined : moved.findIndex((other, position) => position > 0 && other.time === time);
        setSlots(moved);
      };
      const group = (label, values, current, className, onPick) => {
        const box = element('div', undefined, className);
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', label);
        for (const value of values) {
          const choice = element('button', value, `ms-time-choice${value === current ? ' active' : ''}`);
          choice.type = 'button';
          choice.setAttribute('aria-pressed', String(value === current));
          choice.addEventListener('click', () => onPick(value));
          box.append(choice);
        }
        return box;
      };
      panel.append(
        group(t('ui.picker.hour'), HOURS, hour, 'ms-time-hours', (value) => choose(`${value}:${minute}`, false)),
        group(t('ui.picker.minute'), QUARTERS.includes(minute) ? QUARTERS : [...QUARTERS, minute], minute, 'ms-time-quarters', (value) => choose(`${hour}:${value}`, true)),
      );
      return panel;
    }

    /** One button for each temperature: its colour, and its value to tell them apart without the colour too. */
    function levelButtons(current, onPick) {
      const group = element('div', undefined, 'ms-levels');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', t('ui.levels.title'));
      for (const preset of LEVELS) {
        const temperature = levelTemperature(preset);
        const choice = element('button', undefined, 'ms-level');
        choice.type = 'button';
        choice.dataset.level = preset;
        choice.setAttribute('role', 'radio');
        choice.setAttribute('aria-checked', String(preset === current));
        choice.setAttribute('aria-label', levelText(preset));
        choice.title = levelText(preset);
        choice.textContent = temperature === undefined ? levelName(preset) : page.degrees(temperature);
        if (preset !== current) choice.addEventListener('click', () => onPick(preset));
        group.append(choice);
      }
      return group;
    }

    function copyRow() {
      const box = element('div', undefined, 'ms-copy');
      box.append(element('div', t('ui.program.copyTo'), 'ms-copy-label'));
      const row = element('div', undefined, 'ms-copy-row');
      const days = element('div', undefined, 'ms-copy-group ms-copy-days');
      const shortcuts = element('div', undefined, 'ms-copy-group');
      row.append(days, shortcuts);
      box.append(row);
      const copy = (targets) => {
        const others = targets.filter((day) => day !== state.selected);
        state.days = withDayCopied(state.days, state.selected, others);
        flashing = others;
        drawWeekAndDay();
      };
      for (const day of DAYS.filter((candidate) => candidate !== state.selected)) {
        const chip = element('button', dayName(day, 'short'), 'ms-chip');
        chip.type = 'button';
        chip.title = dayName(day, 'long');
        chip.addEventListener('click', () => copy([day]));
        days.append(chip);
      }
      for (const [text, targets] of [
        [t('ui.program.workingDays'), WORKING_DAYS],
        [t('ui.program.everyDay'), DAYS],
      ]) {
        const chip = element('button', text, 'ms-chip');
        chip.type = 'button';
        chip.addEventListener('click', () => copy(targets));
        shortcuts.append(chip);
      }
      return box;
    }

    async function saveProgram() {
      const { number, version } = state;
      const days = Object.fromEntries(DAYS.map((day) => [day, mergedDay(state.days[day])]));
      const payload = { ...(number === undefined ? {} : { number, version }), name: savedName(), days };
      if (!(await change('/program/save', payload, t('ui.program.saved')))) return;
      closeEditor(line, false);
      await afterChange();
      // The program in use stays open, with what it holds now.
      if (number !== undefined && number === inUseNumber()) await openExisting(number, true);
    }

    async function removeProgram() {
      const name = state.existingName ?? String(state.number);
      if (!window.confirm(t('ui.program.deleteConfirm', { name }))) return;
      if (!(await change('/program/delete', { number: state.number }, t('ui.program.deleted')))) return;
      closeEditor(line, false);
      await afterChange();
    }

    showName(state.name === '');
    refresh();
    drawWeekAndDay();
    return {
      node,
      title,
      auto: draft.auto === true,
      isDirty,
      refresh,
      focusName: () => {
        if (state.name === '') nameInput.focus();
      },
    };
  }

  function wire() {
    $('ms-program-new').addEventListener('click', () => openNew('', newProgramDays()));
  }

  return { wire, load };
}
