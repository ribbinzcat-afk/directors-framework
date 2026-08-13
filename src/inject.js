/**
 * Applying the pipeline's output has two independent halves:
 *
 * 1. Prompt injection - `setExtensionPrompt` at IN_CHAT depth 0 (or wherever the preset says),
 *    so the model that writes the actual reply can read what the stages produced. This is not
 *    exposed on SillyTavern.getContext(), so extension_prompt_types/roles are imported directly.
 * 2. Reasoning injection - written into the resulting message's `extra.reasoning` once that
 *    message exists. This can't happen at the same time as (1) because the message doesn't
 *    exist yet when the prompt is being built; it has to wait for MESSAGE_RECEIVED. See the
 *    module-level pending slot below.
 */
import { extension_prompt_types, extension_prompt_roles } from '../../../../../script.js';

const INJECT_KEY = 'directors_framework_output';

function roleNameToEnum(roleName) {
    switch (roleName) {
        case 'user': return extension_prompt_roles.USER;
        case 'assistant': return extension_prompt_roles.ASSISTANT;
        case 'system':
        default: return extension_prompt_roles.SYSTEM;
    }
}

/**
 * @param {any} stContext
 * @param {import('./store.js').Preset} preset
 * @param {string} finalText
 */
export function applyPromptInjection(stContext, preset, finalText) {
    if (!finalText) {
        clearPromptInjection(stContext);
        return;
    }
    const text = preset.injectTemplate.includes('{{output}}')
        ? preset.injectTemplate.split('{{output}}').join(finalText)
        : `${preset.injectTemplate}\n${finalText}`;

    stContext.setExtensionPrompt(
        INJECT_KEY,
        text,
        extension_prompt_types.IN_CHAT,
        preset.injectDepth,
        false,
        roleNameToEnum(preset.injectRole),
    );
}

export function clearPromptInjection(stContext) {
    stContext.setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0, false);
}

// ---------------------------------------------------------------- reasoning injection

/**
 * Set right after a successful pipeline run, consumed once by the next MESSAGE_RECEIVED.
 * A module-level slot (rather than passing the value through the event) because
 * GENERATION_AFTER_COMMANDS and MESSAGE_RECEIVED are separate event emissions with no shared
 * call stack between them.
 * @type {{mode: 'replace-reasoning'|'before-reasoning', text: string} | null}
 */
let pendingReasoning = null;

/**
 * @param {'replace-reasoning'|'before-reasoning'|'prompt-only'} mode
 * @param {string} finalText
 */
export function setPendingReasoning(mode, finalText) {
    pendingReasoning = (mode === 'prompt-only' || !finalText) ? null : { mode, text: finalText };
}

export function clearPendingReasoning() {
    pendingReasoning = null;
}

/**
 * Writes the pending reasoning (if any) into the message that was just received, then clears
 * the slot so it can't leak onto a later, unrelated message. Also rewrites the message's
 * current swipe_info entry: SillyTavern's streaming path strips `reasoning` out of swipe_info
 * before emitting MESSAGE_RECEIVED (see public/script.js finalizeIntermediaryMessage), so
 * without this a swipe away-and-back would silently lose our reasoning.
 * @param {any} stContext
 * @param {number} messageId
 */
export function applyPendingReasoningToMessage(stContext, messageId) {
    if (!pendingReasoning) return;

    const chat = stContext.chat;
    const message = Array.isArray(chat) ? chat[messageId] : null;
    if (!message) {
        pendingReasoning = null;
        return;
    }

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }

    const existing = message.extra.reasoning || '';
    const combined = pendingReasoning.mode === 'replace-reasoning'
        ? pendingReasoning.text
        : (existing ? `${pendingReasoning.text}\n\n${existing}` : pendingReasoning.text);

    message.extra.reasoning = combined;
    message.extra.reasoning_type = 'directors_framework';

    const swipeEntry = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id] : null;
    if (swipeEntry) {
        if (!swipeEntry.extra || typeof swipeEntry.extra !== 'object') {
            swipeEntry.extra = {};
        }
        swipeEntry.extra.reasoning = combined;
        swipeEntry.extra.reasoning_type = 'directors_framework';
    }

    pendingReasoning = null;
}

/**
 * Re-renders the reasoning block DOM from `chat[messageId].extra.reasoning`. Must run after
 * `applyPendingReasoningToMessage`, and after the message element exists in the DOM (i.e. at
 * CHARACTER_MESSAGE_RENDERED, not MESSAGE_RECEIVED).
 * @param {any} stContext
 * @param {number} messageId
 */
export function renderReasoningUI(stContext, messageId) {
    try {
        stContext.updateReasoningUI(messageId);
    } catch (error) {
        console.error('[directors-framework] updateReasoningUI failed:', error);
    }
}
