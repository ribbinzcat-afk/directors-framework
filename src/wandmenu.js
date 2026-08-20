/**
 * Shortcuts in the wand (extensions) menu next to the chat box, so the pipeline and memory
 * recording can each be switched on/off without opening the settings drawer. Same
 * "list-group-item" structure every extension's own wand-menu button uses (e.g.
 * quick-prompt/index.js's addWandButton) - the difference here is these are toggles (reflect
 * and flip a settings flag) rather than actions that open something.
 *
 * Two separate buttons, not one: memory recording (settings().memory.enabled) already runs
 * independently of the pipeline (settings().enabled) - see onMessageReceived in index.js, it
 * only checks memory.enabled - but with a single wand-menu button that wasn't obvious. Someone
 * who wants memory without ever running the (LLM-calling) pipeline needs a way to see and
 * control that independence directly.
 */
import { settings, save } from './store.js';

/**
 * Builds one toggle: the wand-menu button plus its refresh function. Not exported directly -
 * see the two instances (directorToggle/memoryToggle) below and their thin exported wrappers.
 * @param {{id: string, title: string, icon: string, label: string, checkboxId: string, getEnabled: () => boolean, setEnabled: (v: boolean) => void}} spec
 */
function makeWandToggle({ id, title, icon, label, checkboxId, getEnabled, setEnabled }) {
    function refresh() {
        const button = document.getElementById(id);
        if (!button) return;
        const enabled = getEnabled();
        const toggleIcon = button.querySelector('.df-wand-toggle-icon');
        toggleIcon?.classList.toggle('fa-toggle-on', enabled);
        toggleIcon?.classList.toggle('fa-toggle-off', !enabled);
        button.classList.toggle('df-wand-enabled', enabled);
    }

    function add() {
        if (document.getElementById(id)) return; // idempotent
        const container = document.getElementById('extensionsMenu');
        if (!(container instanceof HTMLElement)) return;

        const button = document.createElement('div');
        button.id = id;
        button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable', 'df-wand-btn');
        button.title = title;
        button.innerHTML = `
            <div class="fa-fw fa-solid ${icon} extensionsMenuExtensionButton"></div>
            <span>${label}</span>
            <i class="fa-solid fa-toggle-off df-wand-toggle-icon"></i>`;

        button.addEventListener('click', () => {
            setEnabled(!getEnabled());
            save();
            refresh();
            // Keep the matching settings checkbox in sync too, in case the drawer is open.
            const checkbox = document.getElementById(checkboxId);
            if (checkbox instanceof HTMLInputElement) {
                checkbox.checked = getEnabled();
            }
        });

        container.append(button);
        refresh();
    }

    return { add, refresh };
}

const directorToggle = makeWandToggle({
    id: 'df_wand_toggle',
    title: "Toggle Director's Framework (the automatic stage pipeline) on/off",
    icon: 'fa-clapperboard',
    label: "Director's Framework",
    checkboxId: 'df_enabled',
    getEnabled: () => settings().enabled,
    setEnabled: v => { settings().enabled = v; },
});

const memoryToggle = makeWandToggle({
    id: 'df_wand_memory_toggle',
    title: 'Toggle memory recording on/off - works independently of the pipeline above, no extra LLM calls (short-term recording is a free local vector search, not a model call)',
    icon: 'fa-brain',
    label: 'DF Memory',
    checkboxId: 'df_memory_enabled',
    getEnabled: () => settings().memory.enabled,
    setEnabled: v => { settings().memory.enabled = v; },
});

/**
 * Adds both wand-menu toggle buttons. Call once at startup.
 * @param {any} stContext Unused directly, kept for signature symmetry with the rest of the
 *   codebase's init-time functions and in case a future toggle needs it.
 */
export function addWandToggleButtons(stContext) {
    directorToggle.add();
    memoryToggle.add();
}

/** Syncs the Director's Framework wand button with settings().enabled. Call whenever that flag
 * might have changed elsewhere (the settings checkbox, a preset import, ...). */
export function refreshWandToggleState() {
    directorToggle.refresh();
}

/** Syncs the Memory wand button with settings().memory.enabled. Call whenever that flag might
 * have changed elsewhere (the settings checkbox, ...). */
export function refreshMemoryWandToggleState() {
    memoryToggle.refresh();
}
