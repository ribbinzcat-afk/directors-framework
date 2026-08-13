import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { uuidv4 } from '../../../../utils.js';

/** Must match the folder name exactly. */
export const extensionName = 'directors-framework';

export const INJECT_MODES = /** @type {const} */ (['replace-reasoning', 'before-reasoning', 'prompt-only']);
export const MESSAGE_ROLES = /** @type {const} */ (['system', 'user', 'assistant']);
export const TOOL_MODES = /** @type {const} */ (['auto', 'required']);
/** Generation types the pipeline is allowed to run for. Deliberately excludes
 * 'quiet' (used internally by other extensions/slash commands) and 'impersonate'. */
export const RUNNABLE_TYPES = ['normal', 'regenerate', 'swipe', 'continue'];

/**
 * @typedef {Object} Stage
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {string} profileId Connection Manager profile id. '' = currently selected profile.
 * @property {string} prompt
 * @property {'system'|'user'|'assistant'} role
 * @property {number} maxTokens
 * @property {string[]} dependsOn Stage ids (must be earlier in the list) whose output is fed in.
 * @property {boolean} includeHistory
 * @property {number|null} historyDepth null = use preset default
 * @property {boolean|null} includeWorldInfo null = use preset default
 * @property {boolean} includeInFinal
 * @property {{enabled: boolean, names: string[], mode: 'auto'|'required'}} tools
 */

/**
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} name
 * @property {'replace-reasoning'|'before-reasoning'|'prompt-only'} injectMode
 * @property {'system'|'user'|'assistant'} injectRole
 * @property {number} injectDepth
 * @property {string} injectTemplate Must contain {{output}}.
 * @property {number} historyDepth
 * @property {boolean} includeCard
 * @property {boolean} includePersona
 * @property {boolean} includeWorldInfo
 * @property {number|null} worldInfoScanDepth null = use historyDepth
 * @property {boolean} showInChat Also prepend the combined output to the reply's visible text, not just the reasoning block.
 * @property {number} stageDelaySeconds Wait this long before each stage after the first. Helps avoid provider rate limits when several stages hit the same API key back to back.
 * @property {Stage[]} stages
 */

export function defaultInjectTemplate() {
    return '<director_notes>\n{{output}}\n</director_notes>';
}

/** @returns {Stage} */
export function makeStage(overrides = {}) {
    return {
        id: uuidv4(),
        name: 'New stage',
        enabled: true,
        profileId: '',
        prompt: '',
        role: 'user',
        maxTokens: 512,
        dependsOn: [],
        includeHistory: true,
        historyDepth: null,
        includeWorldInfo: null,
        includeInFinal: true,
        tools: { enabled: false, names: [], mode: 'auto' },
        ...overrides,
    };
}

/** @returns {Preset} */
export function makePreset(overrides = {}) {
    return {
        id: uuidv4(),
        name: 'New preset',
        injectMode: 'before-reasoning',
        injectRole: 'system',
        injectDepth: 0,
        injectTemplate: defaultInjectTemplate(),
        historyDepth: 10,
        includeCard: true,
        includePersona: true,
        includeWorldInfo: true,
        worldInfoScanDepth: null,
        showInChat: false,
        stageDelaySeconds: 0,
        stages: [],
        ...overrides,
    };
}

/** A single starter preset so the drawer is never empty on first install. */
function makeStarterPreset() {
    const planning = makeStage({
        name: 'Planning',
        prompt: 'Think through the scene: character goals, tone, and what should happen next. Be terse; this is a private planning note, not the reply itself.',
        maxTokens: 400,
    });
    const consistency = makeStage({
        name: 'Consistency check',
        prompt: 'Check the planning note above against the character card and recent history. Flag anything that contradicts established facts. If nothing is wrong, say so briefly.',
        dependsOn: [planning.id],
        includeInFinal: true,
        maxTokens: 250,
    });
    return makePreset({
        name: 'Plan then check',
        stages: [planning, consistency],
    });
}

export function defaultSettings() {
    const starter = makeStarterPreset();
    return {
        enabled: false,
        activePresetId: starter.id,
        runOnTypes: ['normal', 'regenerate', 'swipe'],
        showStatusBar: true,
        keepLastRun: true,
        presets: [starter],
    };
}

/** @returns {ReturnType<typeof defaultSettings>} */
export function settings() {
    return extension_settings[extensionName];
}

export function save() {
    saveSettingsDebounced();
}

/**
 * Ensures extension_settings[extensionName] exists and has every default key.
 * Safe to call multiple times; never overwrites data the user already has.
 */
export function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const stored = extension_settings[extensionName];
    const defaults = defaultSettings();

    for (const [key, value] of Object.entries(defaults)) {
        if (!Object.hasOwn(stored, key)) {
            stored[key] = structuredClone(value);
        }
    }

    if (!Array.isArray(stored.presets)) {
        stored.presets = [];
    }
    if (stored.presets.length === 0) {
        const starter = makeStarterPreset();
        stored.presets.push(starter);
        stored.activePresetId = starter.id;
    }
    if (!stored.activePresetId || !stored.presets.some(p => p.id === stored.activePresetId)) {
        stored.activePresetId = stored.presets[0].id;
    }
    if (!Array.isArray(stored.runOnTypes) || stored.runOnTypes.length === 0) {
        stored.runOnTypes = ['normal', 'regenerate', 'swipe'];
    }

    // Backfill any fields added to the schema after presets/stages already existed on disk.
    for (const preset of stored.presets) {
        const presetDefaults = makePreset();
        for (const [key, value] of Object.entries(presetDefaults)) {
            if (key === 'stages') continue;
            if (!Object.hasOwn(preset, key)) {
                preset[key] = structuredClone(value);
            }
        }
        if (!Array.isArray(preset.stages)) preset.stages = [];
        for (const stage of preset.stages) {
            const stageDefaults = makeStage();
            for (const [key, value] of Object.entries(stageDefaults)) {
                if (!Object.hasOwn(stage, key)) {
                    stage[key] = structuredClone(value);
                }
            }
            if (!stage.tools || typeof stage.tools !== 'object') {
                stage.tools = { enabled: false, names: [], mode: 'auto' };
            }
            if (!Array.isArray(stage.tools.names)) stage.tools.names = [];
            if (!Array.isArray(stage.dependsOn)) stage.dependsOn = [];
        }
    }
}

// ---------------------------------------------------------------- preset CRUD

export function findPreset(presetId) {
    return settings().presets.find(p => p.id === presetId) ?? null;
}

export function activePreset() {
    return findPreset(settings().activePresetId);
}

export function addPreset(name) {
    const preset = makePreset({ name: name || 'New preset' });
    settings().presets.push(preset);
    settings().activePresetId = preset.id;
    save();
    return preset;
}

export function duplicatePreset(presetId) {
    const source = findPreset(presetId);
    if (!source) return null;
    const clone = structuredClone(source);
    clone.id = uuidv4();
    clone.name = `${source.name} (copy)`;
    for (const stage of clone.stages) {
        const oldId = stage.id;
        const newId = uuidv4();
        stage.id = newId;
        // Fix up any dependsOn references that pointed at the old stage id.
        for (const s of clone.stages) {
            s.dependsOn = s.dependsOn.map(id => id === oldId ? newId : id);
        }
    }
    settings().presets.push(clone);
    settings().activePresetId = clone.id;
    save();
    return clone;
}

export function deletePreset(presetId) {
    const list = settings().presets;
    const index = list.findIndex(p => p.id === presetId);
    if (index === -1) return false;
    list.splice(index, 1);
    if (list.length === 0) {
        list.push(makeStarterPreset());
    }
    if (settings().activePresetId === presetId) {
        settings().activePresetId = list[0].id;
    }
    save();
    return true;
}

export function renamePreset(presetId, name) {
    const preset = findPreset(presetId);
    if (!preset || !name) return;
    preset.name = name;
    save();
}

// ---------------------------------------------------------------- stage CRUD

export function addStage(presetId) {
    const preset = findPreset(presetId);
    if (!preset) return null;
    const stage = makeStage({ name: `Stage ${preset.stages.length + 1}` });
    preset.stages.push(stage);
    save();
    return stage;
}

export function duplicateStage(presetId, stageId) {
    const preset = findPreset(presetId);
    if (!preset) return null;
    const source = preset.stages.find(s => s.id === stageId);
    if (!source) return null;
    const clone = structuredClone(source);
    clone.id = uuidv4();
    clone.name = `${source.name} (copy)`;
    const index = preset.stages.indexOf(source);
    preset.stages.splice(index + 1, 0, clone);
    save();
    return clone;
}

/** Removes a stage and scrubs any dependsOn/tools references to it from the other stages. */
export function deleteStage(presetId, stageId) {
    const preset = findPreset(presetId);
    if (!preset) return false;
    const index = preset.stages.findIndex(s => s.id === stageId);
    if (index === -1) return false;
    preset.stages.splice(index, 1);
    for (const stage of preset.stages) {
        stage.dependsOn = stage.dependsOn.filter(id => id !== stageId);
    }
    save();
    return true;
}

/**
 * Reapplies stage order and prunes any dependsOn id that now points to a stage which is no
 * longer earlier in the list (dependencies must always point backwards to prevent cycles).
 * @param {string} presetId
 * @param {string[]} orderedStageIds
 */
export function reorderStages(presetId, orderedStageIds) {
    const preset = findPreset(presetId);
    if (!preset) return;
    const byId = new Map(preset.stages.map(s => [s.id, s]));
    const reordered = orderedStageIds.map(id => byId.get(id)).filter(Boolean);
    // Any stage not present in orderedStageIds (shouldn't happen) is appended to be safe.
    for (const stage of preset.stages) {
        if (!orderedStageIds.includes(stage.id)) reordered.push(stage);
    }
    preset.stages = reordered;
    pruneForwardDependencies(preset);
    save();
}

/** Removes dependsOn entries that point at a stage at the same index or later (forward/self refs). */
export function pruneForwardDependencies(preset) {
    const indexOf = new Map(preset.stages.map((s, i) => [s.id, i]));
    for (const [i, stage] of preset.stages.entries()) {
        stage.dependsOn = stage.dependsOn.filter(id => {
            const depIndex = indexOf.get(id);
            return depIndex !== undefined && depIndex < i;
        });
    }
}

// ---------------------------------------------------------------- import / export

export function exportPreset(presetId) {
    const preset = findPreset(presetId);
    if (!preset) return null;
    return { version: 1, presets: [preset] };
}

export function exportAllPresets() {
    return { version: 1, presets: settings().presets };
}

/**
 * Sanitizes untrusted imported JSON into valid Preset objects with fresh ids, so an import
 * can never collide with (or corrupt) what's already stored. Silently drops anything that
 * doesn't look like a preset/stage rather than throwing, mirroring quick-prompt's import.
 * @param {any} data Parsed JSON from an imported file.
 * @returns {Preset[]} Sanitized presets, each with newly issued ids.
 */
export function sanitizeImportedPresets(data) {
    const incoming = Array.isArray(data) ? data : data?.presets;
    if (!Array.isArray(incoming)) return [];

    const sanitized = [];
    for (const rawPreset of incoming) {
        if (!rawPreset || typeof rawPreset.name !== 'string') continue;

        const idMap = new Map();
        const rawStages = Array.isArray(rawPreset.stages) ? rawPreset.stages : [];
        for (const rawStage of rawStages) {
            if (rawStage && typeof rawStage.id === 'string') {
                idMap.set(rawStage.id, uuidv4());
            }
        }

        const stages = rawStages
            .filter(s => s && typeof s.name === 'string')
            .map(rawStage => makeStage({
                id: idMap.get(rawStage.id) ?? uuidv4(),
                name: String(rawStage.name),
                enabled: rawStage.enabled !== false,
                profileId: typeof rawStage.profileId === 'string' ? rawStage.profileId : '',
                prompt: typeof rawStage.prompt === 'string' ? rawStage.prompt : '',
                role: MESSAGE_ROLES.includes(rawStage.role) ? rawStage.role : 'user',
                maxTokens: Number.isFinite(rawStage.maxTokens) ? rawStage.maxTokens : 512,
                dependsOn: Array.isArray(rawStage.dependsOn)
                    ? rawStage.dependsOn.map(id => idMap.get(id)).filter(Boolean)
                    : [],
                includeHistory: rawStage.includeHistory !== false,
                historyDepth: Number.isFinite(rawStage.historyDepth) ? rawStage.historyDepth : null,
                includeWorldInfo: typeof rawStage.includeWorldInfo === 'boolean' ? rawStage.includeWorldInfo : null,
                includeInFinal: rawStage.includeInFinal !== false,
                tools: {
                    enabled: !!rawStage.tools?.enabled,
                    names: Array.isArray(rawStage.tools?.names) ? rawStage.tools.names.filter(n => typeof n === 'string') : [],
                    mode: TOOL_MODES.includes(rawStage.tools?.mode) ? rawStage.tools.mode : 'auto',
                },
            }));

        const preset = makePreset({
            id: uuidv4(),
            name: String(rawPreset.name),
            injectMode: INJECT_MODES.includes(rawPreset.injectMode) ? rawPreset.injectMode : 'before-reasoning',
            injectRole: MESSAGE_ROLES.includes(rawPreset.injectRole) ? rawPreset.injectRole : 'system',
            injectDepth: Number.isFinite(rawPreset.injectDepth) ? rawPreset.injectDepth : 0,
            injectTemplate: typeof rawPreset.injectTemplate === 'string' && rawPreset.injectTemplate
                ? rawPreset.injectTemplate
                : defaultInjectTemplate(),
            historyDepth: Number.isFinite(rawPreset.historyDepth) ? rawPreset.historyDepth : 10,
            includeCard: rawPreset.includeCard !== false,
            includePersona: rawPreset.includePersona !== false,
            includeWorldInfo: rawPreset.includeWorldInfo !== false,
            worldInfoScanDepth: Number.isFinite(rawPreset.worldInfoScanDepth) ? rawPreset.worldInfoScanDepth : null,
            showInChat: !!rawPreset.showInChat,
            stageDelaySeconds: Number.isFinite(rawPreset.stageDelaySeconds) ? Math.max(0, rawPreset.stageDelaySeconds) : 0,
            stages,
        });
        pruneForwardDependencies(preset);
        sanitized.push(preset);
    }
    return sanitized;
}

export function importPresets(data) {
    const sanitized = sanitizeImportedPresets(data);
    if (sanitized.length === 0) return 0;
    settings().presets.push(...sanitized);
    settings().activePresetId = sanitized[sanitized.length - 1].id;
    save();
    return sanitized.length;
}
