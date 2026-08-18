/**
 * Long-term memory's write side: manually curated facts ("pins"). Never auto-written, never
 * auto-deleted - the opposite end of the spectrum from short-term (everything, automatic) and
 * medium-term (periodic, automatic). Something ends up here because a person decided it
 * mattered enough to keep indefinitely.
 *
 * The vector store alone can't answer "what's pinned right now" - /api/vector/list only
 * returns hashes, not text, and querying needs a search string, not a listing. So pins are
 * also tracked as a small local index in chat metadata (getChatMeta), kept in sync with the
 * vector collection: every pin/unpin touches both. The vector side is what recall (scanMemory)
 * actually queries; the local index is purely for the settings UI to list/manage entries.
 */
import { getStringHash } from '../../../../utils.js';
import { getChatMeta, recordLongTermMemory, deleteLongTermMemoryByHashes, purgeLongTermMemory } from './memory.js';

function pinsList(stContext) {
    const meta = getChatMeta(stContext);
    if (!Array.isArray(meta.longTermPins)) meta.longTermPins = [];
    return meta.longTermPins;
}

/**
 * Returns the current chat's pinned long-term memories, newest first.
 * @param {any} stContext
 * @returns {{id: string, text: string, hash: number, pinnedAt: number}[]}
 */
export function listPins(stContext) {
    return [...pinsList(stContext)].sort((a, b) => b.pinnedAt - a.pinnedAt);
}

/**
 * Pins a fact to long-term memory: stores it in the vector collection (so recall can find it)
 * and adds it to the local pin index (so the settings UI can list/manage it). If the vector
 * store write fails, no pin is added - the two must never drift out of sync.
 * @param {any} stContext
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function pinToLongTermMemory(stContext, text) {
    if (typeof text !== 'string' || !text.trim()) return false;
    const trimmed = text.trim();

    const stored = await recordLongTermMemory(stContext, trimmed);
    if (!stored) return false;

    pinsList(stContext).push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: trimmed,
        hash: getStringHash(trimmed),
        pinnedAt: Date.now(),
    });
    stContext.saveMetadataDebounced?.();
    return true;
}

/**
 * Removes a single pin by id: deletes it from the local index and from the vector collection.
 * @param {any} stContext
 * @param {string} pinId
 * @returns {Promise<boolean>}
 */
export async function unpinFromLongTermMemory(stContext, pinId) {
    const pins = pinsList(stContext);
    const index = pins.findIndex(p => p.id === pinId);
    if (index === -1) return false;

    const [removed] = pins.splice(index, 1);
    stContext.saveMetadataDebounced?.();
    await deleteLongTermMemoryByHashes(stContext, [removed.hash]);
    return true;
}

/**
 * Clears every pin for the current chat, both the local index and the vector collection.
 * @param {any} stContext
 * @returns {Promise<boolean>}
 */
export async function clearAllPins(stContext) {
    const meta = getChatMeta(stContext);
    meta.longTermPins = [];
    stContext.saveMetadataDebounced?.();
    return await purgeLongTermMemory(stContext);
}
