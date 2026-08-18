/**
 * A shortcut in the wand (extensions) menu next to the chat box, so the whole pipeline can be
 * switched on/off without opening the settings drawer. Same "list-group-item" structure every
 * extension's own wand-menu button uses (e.g. quick-prompt/index.js's addWandButton) - the
 * only difference here is it's a toggle (reflects and flips settings().enabled) rather than an
 * action that opens something.
 */
import { settings, save } from './store.js';

const WAND_BUTTON_ID = 'df_wand_toggle';

/**
 * Adds the toggle button to the wand menu. Idempotent (checked by id), though it's only ever
 * called once, at startup.
 * @param {any} stContext
 */
export function addWandToggleButton(stContext) {
    if (document.getElementById(WAND_BUTTON_ID)) return;

    const container = document.getElementById('extensionsMenu');
    if (!(container instanceof HTMLElement)) return;

    const button = document.createElement('div');
    button.id = WAND_BUTTON_ID;
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    button.title = "Toggle Director's Framework on/off";
    button.innerHTML = `
        <div class="fa-fw fa-solid fa-clapperboard extensionsMenuExtensionButton"></div>
        <span>Director's Framework</span>
        <i class="fa-solid fa-toggle-off df-wand-toggle-icon"></i>`;

    button.addEventListener('click', () => {
        settings().enabled = !settings().enabled;
        save();
        refreshWandToggleState();
        // Keep the settings checkbox in sync too, in case the drawer happens to be open.
        const checkbox = document.getElementById('df_enabled');
        if (checkbox instanceof HTMLInputElement) {
            checkbox.checked = settings().enabled;
        }
    });

    container.append(button);
    refreshWandToggleState();
}

/**
 * Syncs the wand button's icon/highlight with the current enabled state. Call this whenever
 * the flag might have changed elsewhere (the settings checkbox, a preset import, ...) so the
 * two controls never show contradictory states.
 */
export function refreshWandToggleState() {
    const button = document.getElementById(WAND_BUTTON_ID);
    if (!button) return;

    const enabled = settings().enabled;
    const icon = button.querySelector('.df-wand-toggle-icon');
    icon?.classList.toggle('fa-toggle-on', enabled);
    icon?.classList.toggle('fa-toggle-off', !enabled);
    button.classList.toggle('df-wand-enabled', enabled);
}
