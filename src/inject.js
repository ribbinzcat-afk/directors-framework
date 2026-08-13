/**
 * Applying the pipeline's output has two independent halves, each independently toggleable:
 *
 * 1. Prompt injection - `setExtensionPrompt` at IN_CHAT depth 0 (or wherever the preset says),
 *    so the model that writes the actual reply can read what the stages produced. This is not
 *    exposed on SillyTavern.getContext(), so extension_prompt_types/roles are imported directly.
 * 2. Message injection - written into the resulting message once it exists: into
 *    `extra.reasoning` (unless the preset is "prompt only"), and/or prepended to the visible
 *    `mes` text if "show in chat" is on - useful because not every model/provider actually
 *    returns a reasoning block, so relying on it alone can make the pipeline's output silently
 *    invisible. This can't happen at the same time as (1) because the message doesn't exist
 *    yet when the prompt is being built; it has to wait for MESSAGE_RECEIVED. See the
 *    module-level pending slot below.
 */
import { extension_prompt_types, extension_prompt_roles, syncMesToSwipe } from '../../../../../script.js';

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

// ---------------------------------------------------------------- reasoning + chat-visible injection

/**
 * Set right after a successful pipeline run, consumed once by the next MESSAGE_RECEIVED.
 * A module-level slot (rather than passing the value through the event) because
 * GENERATION_AFTER_COMMANDS and MESSAGE_RECEIVED are separate event emissions with no shared
 * call stack between them.
 * @type {{reasoningMode: 'replace-reasoning'|'before-reasoning'|'prompt-only', showInChat: boolean, text: string} | null}
 */
let pendingOutput = null;

/** Message id that applyPendingOutputToMessage actually touched, so the next
 * CHARACTER_MESSAGE_RENDERED knows whether it needs to re-render anything. */
let touchedMessageId = null;

/**
 * @param {import('./store.js').Preset} preset
 * @param {string} finalText
 */
export function setPendingOutput(preset, finalText) {
    const wantsReasoning = preset.injectMode !== 'prompt-only';
    if ((!wantsReasoning && !preset.showInChat) || !finalText) {
        pendingOutput = null;
        return;
    }
    pendingOutput = { reasoningMode: preset.injectMode, showInChat: preset.showInChat, text: finalText };
}

export function clearPendingOutput() {
    pendingOutput = null;
}

/**
 * Formats the pipeline output as a markdown blockquote so it reads as a clearly separate note
 * when prepended to the model's own reply text. Blockquote (not raw HTML) because SillyTavern's
 * markdown renderer supports it in every theme regardless of tag-encoding settings.
 * @param {string} text
 */
function formatChatBlock(text) {
    const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
    return `> **🎬 Director's Notes**\n${quoted}\n\n`;
}

/**
 * Writes the pending output (if any) into the message that was just received, then clears the
 * slot so it can't leak onto a later, unrelated message. Handles both halves independently:
 * - reasoning: written to `extra.reasoning`, replacing or prepended to the model's own.
 * - chat-visible: prepended to `mes` itself as a blockquote, so it's guaranteed visible even
 *   when the model produced no reasoning block at all (some models/providers just don't).
 * Finishes with `syncMesToSwipe`, SillyTavern's own helper for copying `mes`/`extra` into the
 * current swipe's storage - without it, swiping away and back would silently lose the edit.
 * @param {any} stContext
 * @param {number} messageId
 * @returns {boolean} Whether the message was actually touched (i.e. whether the caller should re-render it).
 */
export function applyPendingOutputToMessage(stContext, messageId) {
    if (!pendingOutput) return false;

    const chat = stContext.chat;
    const message = Array.isArray(chat) ? chat[messageId] : null;
    if (!message) {
        pendingOutput = null;
        return false;
    }

    if (pendingOutput.reasoningMode !== 'prompt-only') {
        if (!message.extra || typeof message.extra !== 'object') {
            message.extra = {};
        }
        const existing = message.extra.reasoning || '';
        message.extra.reasoning = pendingOutput.reasoningMode === 'replace-reasoning'
            ? pendingOutput.text
            : (existing ? `${pendingOutput.text}\n\n${existing}` : pendingOutput.text);
        message.extra.reasoning_type = 'directors_framework';
    }

    if (pendingOutput.showInChat) {
        message.mes = formatChatBlock(pendingOutput.text) + (message.mes ?? '');
    }

    syncMesToSwipe(messageId);

    pendingOutput = null;
    touchedMessageId = messageId;
    return true;
}

/**
 * Re-renders the message's DOM (text + reasoning block) from its current data, but only if
 * `applyPendingOutputToMessage` actually touched this message - calling SillyTavern's
 * `updateMessageBlock` unconditionally on every message would be wasted work for the common
 * case (extension disabled, or nothing to inject). Must run after the message element exists
 * in the DOM, i.e. at CHARACTER_MESSAGE_RENDERED, not MESSAGE_RECEIVED.
 * @param {any} stContext
 * @param {number} messageId
 */
export function renderMessageIfTouched(stContext, messageId) {
    if (touchedMessageId !== messageId) return;
    touchedMessageId = null;

    try {
        stContext.updateMessageBlock(messageId, stContext.chat[messageId]);
    } catch (error) {
        console.error('[directors-framework] updateMessageBlock failed:', error);
    }
}
