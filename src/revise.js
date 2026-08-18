/**
 * On-demand revise (Phase 4): unlike the automatic pipeline (runner.js), this runs exactly
 * once, only when the user clicks the revise button on a specific message, against a chosen
 * template + optional typed instruction. No "draft" stage is needed - the reply SillyTavern
 * already generated *is* the draft; this edits it in place.
 *
 * Reuses runner.js's rate-limit retry/error explanation and context.js's card/WI/memory/history
 * builders directly - settings().revise is shaped to match what those functions already expect
 * from a preset-like object (includeWorldInfo, includeMemory, historyDepth, ...), so no adapter
 * is needed.
 */
import { syncMesToSwipe } from '../../../../../script.js';
import { getRecentHistory, safeCardFields, scanWorldInfo, scanMemory } from './context.js';
import { settings, resolveReviseTemplate } from './store.js';
import { withRateLimitRetry, describeError, isRunning } from './runner.js';

/** True while a revise request is in flight. Separate from runner.js's isRunning() (which
 * tracks the automatic pipeline) - revise blocks on both, so neither can stomp on the other. */
let reviseInFlight = false;

export function isRevising() {
    return reviseInFlight;
}

/**
 * Fills a revise template's {{draft}}/{{instruction}} placeholders. If the template (a custom
 * one a user edited, most likely - the 6 shipped defaults always have both) is missing either
 * placeholder, the value is appended rather than silently dropped, mirroring how summarize.js
 * handles a summaryPrompt without {{chunk}}.
 * @param {import('./store.js').ReviseTemplate} template
 * @param {string} draftText
 * @param {string} instruction
 * @returns {string}
 */
export function fillReviseTemplate(template, draftText, instruction) {
    let prompt = template?.prompt || '';
    const trimmedInstruction = typeof instruction === 'string' ? instruction.trim() : '';

    if (prompt.includes('{{draft}}')) {
        prompt = prompt.split('{{draft}}').join(draftText);
    } else {
        prompt += `\n\n<draft>\n${draftText}\n</draft>`;
    }

    if (prompt.includes('{{instruction}}')) {
        prompt = prompt.split('{{instruction}}').join(trimmedInstruction);
    } else if (trimmedInstruction) {
        prompt += `\n\n${trimmedInstruction}`;
    }

    return prompt;
}

/**
 * Assembles the message array sent to the model for one revise request. Same building blocks
 * and ordering as a pipeline stage (card/persona -> World Info -> memory -> history), ending
 * with the filled template as the user turn.
 * @param {any} stContext
 * @param {ReturnType<typeof settings>['revise']} cfg
 * @param {import('./store.js').ReviseTemplate} template
 * @param {string} draftText The message's current text, before this revise.
 * @param {string} instruction Free-typed instruction from the popup; may be empty.
 * @param {number} messageId The message being revised - history is scoped to *before* it.
 * @returns {Promise<{role: string, content: string}[]>}
 */
export async function buildReviseMessages(stContext, cfg, template, draftText, instruction, messageId) {
    const messages = [];
    const fields = safeCardFields(stContext);

    if (cfg.includeCard && (fields.description || fields.personality || fields.scenario)) {
        const parts = [];
        if (fields.description) parts.push(`Description: ${fields.description}`);
        if (fields.personality) parts.push(`Personality: ${fields.personality}`);
        if (fields.scenario) parts.push(`Scenario: ${fields.scenario}`);
        messages.push({ role: 'system', content: parts.join('\n') });
    }

    if (cfg.includePersona && fields.persona) {
        messages.push({ role: 'system', content: `User persona: ${fields.persona}` });
    }

    if (cfg.includeWorldInfo) {
        const worldInfo = await scanWorldInfo(cfg, stContext);
        const wiText = [worldInfo.worldInfoBefore, worldInfo.worldInfoDepthText, worldInfo.worldInfoAfter]
            .filter(Boolean)
            .join('\n');
        if (wiText) {
            messages.push({ role: 'system', content: `<world_info>\n${wiText}\n</world_info>` });
        }
    }

    if (cfg.includeMemory) {
        const memory = await scanMemory(cfg, stContext);
        if (memory.longTerm?.length > 0) {
            messages.push({ role: 'system', content: `<memory_pinned>\n${memory.longTerm.map(t => `- ${t}`).join('\n')}\n</memory_pinned>` });
        }
        if (memory.mediumTerm?.length > 0) {
            messages.push({ role: 'system', content: `<memory_summary>\n${memory.mediumTerm.map(t => `- ${t}`).join('\n')}\n</memory_summary>` });
        }
        if (memory.shortTerm?.length > 0) {
            messages.push({ role: 'system', content: `<memory_recent>\n${memory.shortTerm.map(t => `- ${t}`).join('\n')}\n</memory_recent>` });
        }
    }

    if (cfg.includeHistory) {
        const history = getRecentHistory(stContext, cfg.historyDepth, messageId);
        for (const m of history) {
            messages.push({ role: m.isUser ? 'user' : 'assistant', name: m.name, content: m.mes });
        }
    }

    const filled = fillReviseTemplate(template, draftText, instruction);
    const finalPrompt = typeof stContext.substituteParams === 'function' ? stContext.substituteParams(filled) : filled;
    messages.push({ role: 'user', content: finalPrompt });

    return messages;
}

/**
 * Runs one revise pass against a specific message. Blocked while the automatic pipeline is
 * running or another revise is already in flight (re-entrancy guard). On success: the
 * message's *first-ever* pre-revise text is preserved in `extra.df_revise_original` (only set
 * once, so revising the same message twice still lets undo reach the true original), the
 * message is updated, synced into its current swipe slot, and re-rendered.
 * @param {any} stContext
 * @param {number} messageId
 * @param {string} templateId
 * @param {string} instruction
 * @param {(info: object) => void} [onStatus]
 * @returns {Promise<boolean>}
 */
export async function runRevise(stContext, messageId, templateId, instruction, onStatus) {
    if (isRunning() || reviseInFlight) {
        toastr.info("Director's Framework is already busy - try again in a moment.", 'Revise');
        return false;
    }

    const cfg = settings().revise;
    const template = resolveReviseTemplate(templateId);
    if (!template) {
        toastr.error('No revise template available.', 'Revise');
        return false;
    }

    const chat = stContext.chat;
    const message = Array.isArray(chat) ? chat[messageId] : null;
    if (!message || typeof message.mes !== 'string' || !message.mes.trim()) {
        toastr.info('Nothing to revise - this message is empty.', 'Revise');
        return false;
    }

    const profileId = cfg.profileId || stContext.extensionSettings?.connectionManager?.selectedProfile || '';
    if (!profileId) {
        toastr.error('No Connection Profile selected for Revise - set one in the Revise settings, or select one in the Connection Manager.', 'Revise');
        return false;
    }

    reviseInFlight = true;
    onStatus?.({ phase: 'revise-start', messageId });

    try {
        const messages = await buildReviseMessages(stContext, cfg, template, message.mes, instruction, messageId);
        const svc = stContext.ConnectionManagerRequestService;
        const result = await withRateLimitRetry(
            () => svc.sendRequest(profileId, messages, cfg.maxTokens, { stream: false, extractData: true }),
            { signal: new AbortController().signal, onStatus, stage: { name: 'Revise' } },
        );
        const output = (typeof result === 'string' ? result : (result?.content ?? '')).trim();

        if (!output) {
            toastr.warning('Revise returned an empty response - nothing was changed.', 'Revise');
            return false;
        }

        if (!message.extra || typeof message.extra !== 'object') {
            message.extra = {};
        }
        // Only capture the original once - a second/third revise must not overwrite it with an
        // already-revised text, or undo would only ever reach the previous revise, not the
        // model's actual first reply.
        if (typeof message.extra.df_revise_original !== 'string') {
            message.extra.df_revise_original = message.mes;
        }

        message.mes = output;
        syncMesToSwipe(messageId);
        stContext.updateMessageBlock(messageId, message);
        await stContext.saveChat?.();
        return true;
    } catch (error) {
        console.error('[directors-framework] Revise failed:', error);
        toastr.error(describeError(error), 'Revise');
        return false;
    } finally {
        reviseInFlight = false;
        onStatus?.({ phase: 'revise-end', messageId });
    }
}

/**
 * Restores a message to its pre-revise text (df_revise_original), if it has one.
 * @param {any} stContext
 * @param {number} messageId
 * @returns {boolean}
 */
export function undoRevise(stContext, messageId) {
    const message = stContext.chat?.[messageId];
    if (!message || typeof message.extra?.df_revise_original !== 'string') {
        return false;
    }

    message.mes = message.extra.df_revise_original;
    delete message.extra.df_revise_original;
    syncMesToSwipe(messageId);
    stContext.updateMessageBlock(messageId, message);
    void stContext.saveChat?.();
    return true;
}
