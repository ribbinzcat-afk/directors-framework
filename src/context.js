/**
 * Builds the message array a single stage sends to the model: system preamble, card/persona,
 * World Info, recent history, upstream stage results, then the stage's own prompt.
 *
 * World Info is scanned ONCE PER RUN (not once per stage) via `scanWorldInfo()` below, and the
 * result is threaded through to every stage that wants it. Two reasons: it's the same
 * information every stage would get from the same history anyway, and - critically - the scan
 * MUST run with `isDryRun: true` or it drives World Info's timed effects (sticky/cooldown/delay)
 * for real, which would desync from what the actual reply generation does right after us.
 *
 * Memory (`scanMemory()`) follows the same once-per-run pattern for the same first reason
 * (every stage would query with the same text anyway), plus it's a network round trip best not
 * paid three times. It queries all three tiers - short-term (verbatim recent replies),
 * medium-term (periodic summaries, see summarize.js), and long-term (manually pinned facts,
 * see pins.js) - independently, since each has its own enabled flag and top-K. Long-term is
 * NOT gated by memory.enabled the way medium-term is: pins are curated by hand, so recall
 * should work even with short-term recording off entirely.
 */
import { queryShortTermMemory, queryMediumTermMemory, queryLongTermMemory } from './memory.js';
import { settings } from './store.js';

/**
 * @param {ReturnType<import('./store.js').activePreset>} preset
 * @param {any} stContext SillyTavern.getContext()
 * @returns {Promise<{worldInfoBefore: string, worldInfoAfter: string, worldInfoDepthText: string}>}
 */
export async function scanWorldInfo(preset, stContext) {
    const empty = { worldInfoBefore: '', worldInfoAfter: '', worldInfoDepthText: '' };
    if (!preset.includeWorldInfo) return empty;
    if (typeof stContext.getWorldInfoPrompt !== 'function') return empty;

    const depth = preset.worldInfoScanDepth ?? preset.historyDepth;
    const recent = getRecentHistory(stContext, depth);

    // getWorldInfoPrompt expects "<name>: <mes>" strings, oldest-last (reverse chronological) -
    // see chatForWI in SillyTavern's own Generate() (public/script.js).
    const chatForWI = recent.map(m => `${m.name}: ${m.mes}`).reverse();

    const fields = safeCardFields(stContext);
    const globalScanData = {
        personaDescription: fields.persona,
        characterDescription: fields.description,
        characterPersonality: fields.personality,
        characterDepthPrompt: fields.charDepthPrompt,
        scenario: fields.scenario,
        creatorNotes: fields.creatorNotes,
        trigger: 'normal',
    };

    try {
        // isDryRun MUST be true: false would fire WORLD_INFO_ACTIVATED and advance sticky/cooldown
        // timers for real, desyncing World Info state from the reply generation that follows.
        const result = await stContext.getWorldInfoPrompt(chatForWI, stContext.maxContext, true, globalScanData);
        const depthEntries = Array.isArray(result?.worldInfoDepth)
            ? result.worldInfoDepth.map(e => (Array.isArray(e?.entries) ? e.entries.join('\n') : '')).filter(Boolean).join('\n')
            : '';
        return {
            worldInfoBefore: result?.worldInfoBefore || '',
            worldInfoAfter: result?.worldInfoAfter || '',
            worldInfoDepthText: depthEntries,
        };
    } catch (error) {
        console.error('[directors-framework] World Info scan failed:', error);
        return empty;
    }
}

/**
 * Queries all three memory tiers once for the whole run, using the latest chat message (almost
 * always the user's message that triggered this generation) as the search text. Each tier is
 * independently gated by its own enabled flag - any combination may come back empty.
 * @param {ReturnType<import('./store.js').activePreset>} preset
 * @param {any} stContext
 * @returns {Promise<{shortTerm: string[], mediumTerm: string[], longTerm: string[]}>}
 */
export async function scanMemory(preset, stContext) {
    const empty = { shortTerm: [], mediumTerm: [], longTerm: [] };
    if (!preset.includeMemory) return empty;

    const memoryCfg = settings().memory;
    const chat = Array.isArray(stContext.chat) ? stContext.chat : [];
    const searchText = chat[chat.length - 1]?.mes;
    if (!searchText) return empty;

    const [shortTerm, mediumTerm, longTerm] = await Promise.all([
        memoryCfg.enabled ? queryShortTermMemory(stContext, searchText, memoryCfg.topK) : [],
        memoryCfg.enabled && memoryCfg.medium.enabled ? queryMediumTermMemory(stContext, searchText, memoryCfg.medium.topK) : [],
        memoryCfg.long.enabled ? queryLongTermMemory(stContext, searchText, memoryCfg.long.topK) : [],
    ]);
    return { shortTerm, mediumTerm, longTerm };
}

export function safeCardFields(stContext) {
    try {
        return typeof stContext.getCharacterCardFields === 'function'
            ? stContext.getCharacterCardFields()
            : {};
    } catch (error) {
        console.error('[directors-framework] getCharacterCardFields failed:', error);
        return {};
    }
}

/**
 * @param {any} stContext
 * @param {number} depth Number of most recent messages to include.
 * @param {number} [beforeIndex] If given, only consider messages before this chat index -
 *   used by revise.js, since a revise button can sit on any past message, not just the last
 *   one, and showing the model chat lines that come *after* the message it's revising would
 *   be actively confusing (it'd see "future" dialogue while asked to rewrite an earlier line).
 * @returns {{name: string, mes: string, isUser: boolean}[]} Oldest-first.
 */
export function getRecentHistory(stContext, depth, beforeIndex) {
    const chat = Array.isArray(stContext.chat) ? stContext.chat : [];
    const upTo = Number.isFinite(beforeIndex) ? chat.slice(0, beforeIndex) : chat;
    const n = Number.isFinite(depth) && depth > 0 ? depth : 0;
    const slice = n > 0 ? upTo.slice(-n) : upTo.slice();
    return slice
        .filter(m => m && typeof m.mes === 'string' && !m.is_system)
        .map(m => ({ name: m.name || (m.is_user ? stContext.name1 : stContext.name2), mes: m.mes, isUser: !!m.is_user }));
}

/**
 * Assembles the full chat-completion-style message array for one stage.
 * @param {import('./store.js').Preset} preset
 * @param {import('./store.js').Stage} stage
 * @param {any} stContext
 * @param {{worldInfoBefore: string, worldInfoAfter: string, worldInfoDepthText: string}} worldInfo Pre-scanned, shared across stages.
 * @param {Record<string, {stage: import('./store.js').Stage, output: string}>} priorResults Results of stages that already ran this run, keyed by stage id.
 * @param {{shortTerm: string[], mediumTerm: string[], longTerm: string[]}} [memory] Pre-queried memory, shared across stages.
 * @returns {{role: string, content: string}[]}
 */
export function buildStageMessages(preset, stage, stContext, worldInfo, priorResults, memory = { shortTerm: [], mediumTerm: [], longTerm: [] }) {
    const messages = [];
    const fields = safeCardFields(stContext);

    const includeCard = preset.includeCard;
    const includePersona = preset.includePersona;
    const includeWorldInfo = stage.includeWorldInfo ?? preset.includeWorldInfo;

    if (includeCard && (fields.description || fields.personality || fields.scenario)) {
        const parts = [];
        if (fields.description) parts.push(`Description: ${fields.description}`);
        if (fields.personality) parts.push(`Personality: ${fields.personality}`);
        if (fields.scenario) parts.push(`Scenario: ${fields.scenario}`);
        messages.push({ role: 'system', content: parts.join('\n') });
    }

    if (includePersona && fields.persona) {
        messages.push({ role: 'system', content: `User persona: ${fields.persona}` });
    }

    if (includeWorldInfo) {
        const wiText = [worldInfo.worldInfoBefore, worldInfo.worldInfoDepthText, worldInfo.worldInfoAfter]
            .filter(Boolean)
            .join('\n');
        if (wiText) {
            messages.push({ role: 'system', content: `<world_info>\n${wiText}\n</world_info>` });
        }
    }

    const includeMemory = stage.includeMemory ?? preset.includeMemory;
    if (includeMemory) {
        // Pinned facts first (permanent, curated - most foundational), then summaries (older,
        // compressed background), then verbatim recent excerpts (specific, immediate) - so the
        // stage reads from general/permanent context down to specific/recent detail, same
        // ordering principle as World Info's before/depth/after.
        if (memory.longTerm?.length > 0) {
            const text = memory.longTerm.map(t => `- ${t}`).join('\n');
            messages.push({ role: 'system', content: `<memory_pinned>\n${text}\n</memory_pinned>` });
        }
        if (memory.mediumTerm?.length > 0) {
            const text = memory.mediumTerm.map(t => `- ${t}`).join('\n');
            messages.push({ role: 'system', content: `<memory_summary>\n${text}\n</memory_summary>` });
        }
        if (memory.shortTerm?.length > 0) {
            const text = memory.shortTerm.map(t => `- ${t}`).join('\n');
            messages.push({ role: 'system', content: `<memory_recent>\n${text}\n</memory_recent>` });
        }
    }

    if (stage.includeHistory) {
        const depth = stage.historyDepth ?? preset.historyDepth;
        const history = getRecentHistory(stContext, depth);
        for (const m of history) {
            messages.push({ role: m.isUser ? 'user' : 'assistant', name: m.name, content: m.mes });
        }
    }

    for (const depId of stage.dependsOn) {
        const upstream = priorResults[depId];
        if (upstream && upstream.output) {
            messages.push({
                role: 'system',
                content: `[${upstream.stage.name}]\n${upstream.output}`,
            });
        }
    }

    const promptText = typeof stContext.substituteParams === 'function'
        ? stContext.substituteParams(stage.prompt)
        : stage.prompt;
    messages.push({ role: stage.role, content: promptText });

    return messages;
}
