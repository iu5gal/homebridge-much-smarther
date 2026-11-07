// Line icons for the setup page: 24×24, stroked with the current text colour.
// Fixed markup only; nothing here comes from users or the thermostat.
const SHAPES = {
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  power: '<path d="M12 3.5v8"/><path d="M6.6 6.8a7.6 7.6 0 1 0 10.8 0"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  bolt: '<path d="M13 2.5 5.5 13.5h6l-1 8 8-11h-6z"/>',
  flame:
    '<path d="M12 21.5a6.5 6.5 0 0 0 6.5-6.5c0-3.6-2.4-5.8-3.9-7.9-.9-1.3-1.4-2.7-1.5-4.6-2.6 1.6-4.4 4.2-4.6 7.1-.8-.6-1.3-1.5-1.5-2.6-1.4 1.6-1.5 5.3-1.5 8A6.5 6.5 0 0 0 12 21.5z"/><path d="M12 21.5a3 3 0 0 1-3-3c0-1.8 1.4-2.9 3-4.9 1.6 2 3 3.1 3 4.9a3 3 0 0 1-3 3z"/>',
  snowflake:
    '<path d="M12 12V3M12 6.4l2.3-2.3M12 6.4 9.7 4.1M12 12 4.2 7.5M7.2 9.2l-.9-3.1M7.2 9.2l-3.1.8M12 12l-7.8 4.5M7.2 14.8l-3.1-.8M7.2 14.8l-.9 3.1M12 12v9M12 17.6l-2.3 2.3M12 17.6l2.3 2.3M12 12l7.8 4.5M16.8 14.8l.9 3.1M16.8 14.8l3.1-.8M12 12l7.8-4.5M16.8 9.2l3.1.8M16.8 9.2l.9-3.1"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.6 3.8v4.6H15"/>',
  check: '<path d="M5 12.5 9.5 17 19 7.5"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pencil: '<path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5z"/><path d="M14.5 6l3.5 3.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
};

/** Fills every `[data-icon]` element with its icon. */
export function drawIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    const shape = SHAPES[node.dataset.icon];
    if (!shape || node.firstChild) continue;
    node.classList.add('ms-icon');
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${shape}</svg>`;
  }
}
