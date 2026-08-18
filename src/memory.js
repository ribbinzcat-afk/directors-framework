/**
 * Three-tier memory, all backed by SillyTavern's own /api/vector/* endpoints - the same
 * server-side API the built-in "Vectors" extension uses, called directly here so this works
 * whether or not that extension is enabled:
 *
 * - Short-term: every AI reply, stored verbatim, one item per reply.
 * - Medium-term (Phase 2, see summarize.js): a compressed summary every N replies, replacing
 *   the short-term entries it was built from so the same window of conversation doesn't sit in
 *   both tiers at once.
 * - Long-term / "pinned" (Phase 3, see pins.js): manually curated facts. Never auto-written,
 *   never auto-deleted - the opposite end of the spectrum from the other two tiers, which are
 *   both fully automatic.
 *
 * All three are queried back in as extra context for any stage that wants them (context.js).
 *
 * Deliberately hardcoded to the 'transformers' embedding source: it is the only source that
 * needs zero configuration (runs inside the SillyTavern server process, no API key, downloads
 * its model once on first use), and it's what /api/vector itself falls back to when no source
 * is given. Other sources (openai, cohere, ollama, ...) need extra per-provider fields the
 * built-in Vectors extension pulls from its own settings object - out of scope for this pass;
 * see README for how to extend this if a specific source is needed later.
 */
import { getStringHash } from '../../../../utils.js';

const SOURCE = 'transformers';

function collectionId(tier, chatId) {
    return `directors_framework_${tier}_${chatId}`;
}

async function vectorFetch(stContext, path, body) {
    const response = await fetch(`/api/vector/${path}`, {
        method: 'POST',
        headers: stContext.getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`/api/vector/${path} failed (${response.status})`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

/**
 * Stores one item of text in the given tier's collection for the current chat. Best-effort:
 * logs and gives up on failure rather than ever blocking the pipeline or the reply that
 * triggered it - memory is a bonus, not something worth breaking a chat over. Returns whether
 * it actually succeeded, for the one caller that needs to know (pins.js - a manual pin should
 * tell the user if it didn't take).
 * @param {any} stContext
 * @param {'short'|'medium'|'long'} tier
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function record(stContext, tier, text) {
    if (typeof stContext.getCurrentChatId !== 'function') return false;
    const chatId = stContext.getCurrentChatId();
    if (!chatId || typeof text !== 'string' || !text.trim()) return false;

    try {
        await vectorFetch(stContext, 'insert', {
            collectionId: collectionId(tier, chatId),
            source: SOURCE,
            items: [{ hash: getStringHash(text), text }],
        });
        return true;
    } catch (error) {
        console.error(`[directors-framework] Failed to record ${tier}-term memory:`, error);
        return false;
    }
}

/**
 * Returns the topK most relevant texts from the given tier's collection for the current chat,
 * most relevant first. Empty array (never throws) if there's nothing stored yet, no chat, or
 * the request fails - a cold/empty collection is the normal case early in any chat, not an
 * error.
 * @param {any} stContext
 * @param {'short'|'medium'|'long'} tier
 * @param {string} searchText
 * @param {number} topK
 * @returns {Promise<string[]>}
 */
async function query(stContext, tier, searchText, topK) {
    if (typeof stContext.getCurrentChatId !== 'function') return [];
    const chatId = stContext.getCurrentChatId();
    if (!chatId || typeof searchText !== 'string' || !searchText.trim()) return [];

    try {
        const result = await vectorFetch(stContext, 'query', {
            collectionId: collectionId(tier, chatId),
            source: SOURCE,
            searchText,
            topK: Math.max(1, Number(topK) || 1),
        });
        return Array.isArray(result?.metadata)
            ? result.metadata.map(m => m?.text).filter(t => typeof t === 'string' && t)
            : [];
    } catch (error) {
        console.error(`[directors-framework] Failed to query ${tier}-term memory:`, error);
        return [];
    }
}

/**
 * Deletes every item from the given tier's collection for the current chat.
 * @param {any} stContext
 * @param {'short'|'medium'|'long'} tier
 * @returns {Promise<boolean>}
 */
async function purge(stContext, tier) {
    if (typeof stContext.getCurrentChatId !== 'function') return false;
    const chatId = stContext.getCurrentChatId();
    if (!chatId) return false;

    try {
        await vectorFetch(stContext, 'purge', { collectionId: collectionId(tier, chatId) });
        return true;
    } catch (error) {
        console.error(`[directors-framework] Failed to purge ${tier}-term memory:`, error);
        return false;
    }
}

/**
 * Deletes specific items from the given tier's collection by content hash.
 * @param {any} stContext
 * @param {'short'|'medium'|'long'} tier
 * @param {number[]} hashes
 * @returns {Promise<boolean>}
 */
async function deleteByHashes(stContext, tier, hashes) {
    if (typeof stContext.getCurrentChatId !== 'function') return false;
    const chatId = stContext.getCurrentChatId();
    if (!chatId || !Array.isArray(hashes) || hashes.length === 0) return false;

    try {
        await vectorFetch(stContext, 'delete', {
            collectionId: collectionId(tier, chatId),
            source: SOURCE,
            hashes,
        });
        return true;
    } catch (error) {
        console.error(`[directors-framework] Failed to delete ${tier}-term memory items:`, error);
        return false;
    }
}

export const recordShortTermMemory = (stContext, text) => record(stContext, 'short', text);
export const queryShortTermMemory = (stContext, searchText, topK) => query(stContext, 'short', searchText, topK);
export const purgeShortTermMemory = (stContext) => purge(stContext, 'short');
/** Used after a chunk of short-term memory is folded into a medium-term summary (summarize.js),
 * so that window of conversation doesn't sit verbatim in short-term *and* compressed in
 * medium-term at the same time. */
export const deleteShortTermMemoryByHashes = (stContext, hashes) => deleteByHashes(stContext, 'short', hashes);

export const recordMediumTermMemory = (stContext, text) => record(stContext, 'medium', text);
export const queryMediumTermMemory = (stContext, searchText, topK) => query(stContext, 'medium', searchText, topK);
export const purgeMediumTermMemory = (stContext) => purge(stContext, 'medium');

export const recordLongTermMemory = (stContext, text) => record(stContext, 'long', text);
export const queryLongTermMemory = (stContext, searchText, topK) => query(stContext, 'long', searchText, topK);
export const purgeLongTermMemory = (stContext) => purge(stContext, 'long');
/** Used by pins.js when a single pin is removed - the vector store has no concept of "list
 * with text", so pins.js keeps its own index (see getChatMeta) and this keeps the vector
 * collection in sync with it one item at a time. */
export const deleteLongTermMemoryByHashes = (stContext, hashes) => deleteByHashes(stContext, 'long', hashes);

const CHAT_META_KEY = 'directors_framework_memory';

/**
 * Shared per-chat metadata bag for this extension's memory features: the reply counter
 * summarize.js uses to know when to summarize, and the pin index pins.js uses to list/manage
 * long-term memory (the vector API alone can't answer "what's pinned right now" - /list only
 * returns hashes, not text). Lives in SillyTavern's chat metadata (saved with the chat file
 * itself) rather than extension_settings, since this data is chat-scoped, not user-scoped.
 * @param {any} stContext
 * @returns {Record<string, any>}
 */
export function getChatMeta(stContext) {
    const meta = stContext.chatMetadata;
    if (!meta[CHAT_META_KEY] || typeof meta[CHAT_META_KEY] !== 'object') {
        meta[CHAT_META_KEY] = {};
    }
    return meta[CHAT_META_KEY];
}
