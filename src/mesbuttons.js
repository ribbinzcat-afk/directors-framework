/**
 * The revise button that appears on every AI message (`.extraMesButtons`, the same slot the
 * built-in Translate/Narrate buttons live in), plus its popup and the undo button that shows
 * up once a message has been revised at least once.
 *
 * Uses a DELEGATED click handler on `document` (bound once, in bindReviseButtonHandlers),
 * never a listener attached to individual buttons - SillyTavern re-renders message DOM
 * constantly (swipe, edit, scroll-load), so per-button listeners would silently stop working.
 * The built-in `translate` extension uses the same pattern for `.mes_translate`
 * (public/scripts/extensions/translate/index.js).
 */
import { settings } from './store.js';
import { runRevise, undoRevise } from './revise.js';
import { showStatus, hideStatus, describeStatusEvent } from './status.js';

const REVISE_BTN_CLASS = 'df-mes-revise';
const UNDO_BTN_CLASS = 'df-mes-revise-undo';

function messageIdFromButton(btn) {
    const mesEl = btn.closest('.mes');
    const idAttr = mesEl?.getAttribute('mesid');
    return idAttr !== null && idAttr !== '' ? Number(idAttr) : NaN;
}

/**
 * Injects (or updates) the revise/undo buttons on every AI message currently in the DOM.
 * Idempotent - safe to call on every render event, skips messages that already have the
 * button they need. Skips user and system messages entirely (revising your own message, or a
 * system note, isn't a supported case).
 * @param {any} stContext
 */
export function injectReviseButtons(stContext) {
    if (!settings().revise.showButton) return;
    const chat = stContext.chat;
    if (!Array.isArray(chat)) return;

    for (const mesEl of document.querySelectorAll('#chat .mes')) {
        const idAttr = mesEl.getAttribute('mesid');
        if (idAttr === null || idAttr === '') continue;
        const messageId = Number(idAttr);
        const message = chat[messageId];
        if (!message || message.is_user || message.is_system) continue;

        const container = mesEl.querySelector('.extraMesButtons');
        if (!container) continue;

        if (!container.querySelector(`.${REVISE_BTN_CLASS}`)) {
            const btn = document.createElement('div');
            btn.title = 'Revise this message';
            btn.className = `mes_button ${REVISE_BTN_CLASS} fa-solid fa-wand-magic-sparkles interactable`;
            container.appendChild(btn);
        }

        const hasOriginal = typeof message.extra?.df_revise_original === 'string';
        const undoBtn = container.querySelector(`.${UNDO_BTN_CLASS}`);
        if (hasOriginal && !undoBtn) {
            const btn = document.createElement('div');
            btn.title = 'Undo revise (restore the original reply)';
            btn.className = `mes_button ${UNDO_BTN_CLASS} fa-solid fa-rotate-left interactable`;
            container.appendChild(btn);
        } else if (!hasOriginal && undoBtn) {
            undoBtn.remove();
        }
    }
}

/** Removes every revise/undo button from the DOM. Used when "showButton" is turned off. */
export function removeReviseButtons() {
    document.querySelectorAll(`.${REVISE_BTN_CLASS}, .${UNDO_BTN_CLASS}`).forEach(el => el.remove());
}

/** Injects or removes buttons depending on the current showButton setting. Call this instead
 * of injectReviseButtons directly whenever the setting itself might have just changed. */
export function refreshReviseButtons(stContext) {
    if (settings().revise.showButton) {
        injectReviseButtons(stContext);
    } else {
        removeReviseButtons();
    }
}

/**
 * Builds the popup content: a template picker and an optional free-text instruction. Not built
 * with `Popup.show.input()` - that helper only returns a single string, and can't represent a
 * dropdown plus a textarea. Same "build a DOM element, hand it to `new Popup(...)`" pattern
 * quick-prompt's picker (`openPicker`) already uses.
 * @param {ReturnType<typeof settings>['revise']} cfg
 */
function buildRevisePopupContent(cfg) {
    const wrapper = document.createElement('div');
    wrapper.className = 'df-revise-popup';

    const templateLabel = document.createElement('label');
    templateLabel.textContent = 'Template';
    const select = document.createElement('select');
    select.className = 'text_pole df-revise-template-select';
    for (const template of cfg.templates) {
        const option = document.createElement('option');
        option.value = template.id;
        option.textContent = template.name;
        select.appendChild(option);
    }
    select.value = cfg.templates.some(t => t.id === cfg.defaultTemplateId) ? cfg.defaultTemplateId : cfg.templates[0]?.id;

    const instructionLabel = document.createElement('label');
    instructionLabel.textContent = 'Instruction (optional)';
    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole df-revise-instruction';
    textarea.rows = 3;
    textarea.placeholder = 'e.g. shorter / more dialogue / stronger emotion';

    wrapper.append(templateLabel, select, instructionLabel, textarea);
    return { wrapper, select, textarea };
}

/**
 * Opens the revise popup for one message, and runs revise if the user confirms.
 * @param {any} stContext
 * @param {number} messageId
 */
async function openRevisePopup(stContext, messageId) {
    const cfg = settings().revise;
    if (!Array.isArray(cfg.templates) || cfg.templates.length === 0) {
        toastr.error('No revise templates configured.', 'Revise');
        return;
    }

    const { wrapper, select, textarea } = buildRevisePopupContent(cfg);
    const popup = new stContext.Popup(wrapper, stContext.POPUP_TYPE.CONFIRM, '', {
        wide: true,
        okButton: 'Revise',
        cancelButton: 'Cancel',
    });
    const result = await popup.show();
    if (!result) return; // NEGATIVE (0) or CANCELLED (null) - both falsy, both mean "don't revise"

    const templateId = select.value;
    const instruction = textarea.value;

    showStatus('Revising message...');
    try {
        const onStatus = event => {
            // Only 'rate-limited' is worth surfacing here - the start/end phases runRevise
            // also emits exist for callers that want them (e.g. tests), not for this UI.
            if (event.phase === 'rate-limited') {
                showStatus(describeStatusEvent(event));
            }
        };
        const ok = await runRevise(stContext, messageId, templateId, instruction, onStatus);
        if (ok) {
            refreshReviseButtons(stContext);
        }
    } finally {
        hideStatus();
    }
}

/**
 * Binds the delegated click handlers for the revise and undo buttons. Call once at startup.
 * @param {any} stContext
 */
export function bindReviseButtonHandlers(stContext) {
    $(document).on('click', `.${REVISE_BTN_CLASS}`, function () {
        const messageId = messageIdFromButton(this);
        if (!Number.isFinite(messageId)) return;
        void openRevisePopup(stContext, messageId);
    });

    $(document).on('click', `.${UNDO_BTN_CLASS}`, function () {
        const messageId = messageIdFromButton(this);
        if (!Number.isFinite(messageId)) return;
        if (undoRevise(stContext, messageId)) {
            refreshReviseButtons(stContext);
        }
    });
}
