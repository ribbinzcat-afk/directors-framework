/**
 * Medium-term memory's write side: every N recorded replies (settings().memory.medium.
 * everyNReplies), compress the last N chat messages into a short summary via a normal LLM
 * call, store it in the medium tier, and delete the short-term entries it was built from so
 * that window of conversation doesn't sit in both tiers at once.
 *
 * Called from index.js right after recordShortTermMemory, fire-and-forget (never awaited) so
 * an LLM call here never delays the reply that triggered it.
 */
import { getStringHash } from '../../../../utils.js';
import { settings } from './store.js';
import { recordMediumTermMemory, deleteShortTermMemoryByHashes, getChatMeta } from './memory.js';

/**
 * Sends the chunk to the configured (or currently active) Connection Profile and returns the
 * trimmed summary text, or '' if there's no usable profile / the response was empty.
 * @param {any} stContext
 * @param {{name: string, mes: string}[]} chunk
 * @param {{summaryProfileId: string, summaryPrompt: string}} cfg
 * @returns {Promise<string>}
 */
async function summarizeChunk(stContext, chunk, cfg) {
    const svc = stContext.ConnectionManagerRequestService;
    const profileId = cfg.summaryProfileId || stContext.extensionSettings?.connectionManager?.selectedProfile || '';
    if (!profileId || !svc) return '';

    const transcript = chunk.map(m => `${m.name}: ${m.mes}`).join('\n');
    const template = cfg.summaryPrompt || '';
    const rawPrompt = template.includes('{{chunk}}') ? template.split('{{chunk}}').join(transcript) : `${template}\n\n${transcript}`;
    const prompt = typeof stContext.substituteParams === 'function' ? stContext.substituteParams(rawPrompt) : rawPrompt;

    const result = await svc.sendRequest(profileId, [{ role: 'user', content: prompt }], 400, { stream: false, extractData: true });
    const output = typeof result === 'string' ? result : (result?.content ?? '');
    return output.trim();
}

/**
 * Advances the per-chat reply counter and, once it reaches the configured threshold,
 * summarizes the last N messages into medium-term memory. Best-effort and self-healing: on
 * any failure (no profile configured, request error, empty response) the counter is left at
 * or above the threshold so the very next reply retries, instead of silently losing that
 * window of conversation. Never throws.
 * @param {any} stContext
 */
export async function maybeSummarize(stContext) {
    const memoryCfg = settings().memory;
    const cfg = memoryCfg.medium;
    if (!memoryCfg.enabled || !cfg.enabled || cfg.everyNReplies <= 0) return;
    if (typeof stContext.getCurrentChatId !== 'function' || !stContext.getCurrentChatId()) return;

    const meta = getChatMeta(stContext);
    meta.repliesSinceSummary = (meta.repliesSinceSummary || 0) + 1;
    stContext.saveMetadataDebounced?.();

    if (meta.repliesSinceSummary < cfg.everyNReplies) return;

    const chat = Array.isArray(stContext.chat) ? stContext.chat : [];
    const chunk = chat
        .slice(-cfg.everyNReplies)
        .filter(m => m && typeof m.mes === 'string' && m.mes.trim() && !m.is_system)
        .map(m => ({ name: m.name || (m.is_user ? stContext.name1 : stContext.name2), mes: m.mes }));

    try {
        if (chunk.length === 0) throw new Error('No messages in the window to summarize.');

        const summary = await summarizeChunk(stContext, chunk, cfg);
        if (!summary) throw new Error('Summary was empty - check the Medium-term Connection Profile.');

        await recordMediumTermMemory(stContext, summary);
        await deleteShortTermMemoryByHashes(stContext, chunk.map(m => getStringHash(m.mes)));

        meta.repliesSinceSummary = 0;
        stContext.saveMetadataDebounced?.();
    } catch (error) {
        console.error('[directors-framework] Medium-term summarization failed, will retry next reply:', error);
    }
}
