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
 * @property {boolean|null} includeMemory null = use preset default
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
 * @property {boolean} includeMemory Fold short-term memory (see settings().memory) into stage context.
 * @property {Stage[]} stages
 */

/**
 * @typedef {Object} ReviseTemplate
 * @property {string} id
 * @property {string} name
 * @property {string} prompt Must contain {{draft}}; should contain {{instruction}} if it's meant to react to free-typed instructions.
 */

export function defaultInjectTemplate() {
    return '<director_notes>\n{{output}}\n</director_notes>';
}

export function defaultSummaryPrompt() {
    return 'Summarize the following exchange in 3-5 sentences. Keep only facts, events, and '
        + "changes to characters' relationships or state - do not quote dialogue verbatim, "
        + 'and do not add commentary.\n\n{{chunk}}';
}

/** Appended to every default revise template: carries {{draft}}/{{instruction}} and the
 * guardrails that keep the model from adding a preamble or drifting the story. */
function reviseStandardEnding() {
    return '\n\n<draft>\n{{draft}}\n</draft>\n\n{{instruction}}\n\n'
        + 'ห้ามเปลี่ยน: มุมมอง ภาษา และตัวตนของตัวละคร\n'
        + 'ผลลัพธ์: เนื้อเรื่องฉบับแก้แล้วล้วนๆ ห้ามมีคำนำ ห้ามอธิบายว่าแก้อะไร ห้ามมีหัวข้อ';
}

/** @returns {ReviseTemplate} */
export function makeReviseTemplate(overrides = {}) {
    return {
        id: uuidv4(),
        name: 'New template',
        prompt: reviseStandardEnding(),
        ...overrides,
    };
}

/** @returns {ReviseTemplate[]} The 6 starter templates, so the revise popup is never empty. */
export function defaultReviseTemplates() {
    return [
        makeReviseTemplate({
            name: 'เกลาภาษา',
            prompt: 'เกลาข้อความต่อไปนี้ให้อ่านลื่นและเป็นธรรมชาติเหมือนคนเขียนมากขึ้น\n\n'
                + '■ จังหวะประโยค — สำคัญที่สุด\n'
                + 'ร่างที่ AI เขียนมักมีประโยคยาวเท่าๆ กันหมด ให้แก้เป็นจังหวะไม่สม่ำเสมอ:\n'
                + 'ประโยคยาวที่ไหลต่อเนื่อง แล้วตัดด้วยประโยคสั้น. สั้นมาก. แล้วค่อยยาวอีก\n'
                + 'อนุญาตให้ใช้ประโยคไม่สมบูรณ์เพื่อเน้นจังหวะ\n\n'
                + '■ ต้องลบทิ้ง\n'
                + '- "ไม่ใช่...แต่..." → เขียนตรงๆ\n'
                + '- การเรียงสามชิ้นทุกครั้ง ("เย็น เงียบ และว่างเปล่า") → เหลือสองหรือหนึ่งที่คมกว่า\n'
                + '- ประโยคสรุปปิดท้ายย่อหน้าที่อธิบายว่าย่อหน้านั้นแปลว่าอะไร → ตัด จบตรงภาพหรือการกระทำ\n'
                + '- การบอกชื่ออารมณ์หลังแสดงไปแล้ว ("...เธอรู้สึกเจ็บปวด") → เหลือแต่ภาพ\n'
                + '- วลีสวยหรูที่ไม่ให้ข้อมูล ("บางอย่างในอากาศเปลี่ยนไป") → แทนด้วยรายละเอียดจับต้องได้\n\n'
                + '■ วลีต้องห้าม (คลิเช AI)\n'
                + 'ลมหายใจสะดุด / หัวใจเต้นแรงขึ้น / บางอย่างวาบขึ้นในดวงตา / กลืนน้ำลาย /\n'
                + 'กำมือแน่นจนข้อนิ้วขาว / มุมปากกระตุก / ขากรรไกรแข็งเกร็ง / เวลาเหมือนหยุดนิ่ง\n\n'
                + '■ คำฟุ่มเฟือย\n'
                + 'ตัด "ราวกับ" "ดูเหมือนว่า" "เกือบจะ" "อย่างช้าๆ" "เบาๆ" ที่ไม่จำเป็น\n'
                + 'ตัดชื่อตัวละครที่ซ้ำเกินไป — ภาษาไทยละประธานได้ ให้ละ\n'
                + 'ระวังประโยคที่โครงสร้างเหมือนแปลจากอังกฤษ\n\n'
                + '■ ห้ามแก้\n'
                + 'เนื้อเรื่อง ลำดับเหตุการณ์ จำนวนย่อหน้า และความยาวโดยรวม\n'
                + 'ตัดคำฟุ่มเฟือย ไม่ใช่ตัดฉาก'
                + reviseStandardEnding(),
        }),
        makeReviseTemplate({
            name: 'ตัดให้กระชับ',
            prompt: 'ตัดข้อความต่อไปนี้ให้กระชับขึ้นประมาณ 30% โดยไม่ให้เนื้อหาหาย\n\n'
                + '- ตัดคำขยายที่ไม่จำเป็น ประโยคซ้ำความ และการบรรยายที่ยืดเยื้อ\n'
                + '- เก็บบทสนทนาและ beat สำคัญไว้ให้ครบทุกอัน\n'
                + '- ห้ามตัดฉากหรือเหตุการณ์ออก ตัดแค่คำ'
                + reviseStandardEnding(),
        }),
        makeReviseTemplate({
            name: 'ขยายรายละเอียด',
            prompt: 'ขยายข้อความต่อไปนี้ให้มีมิติขึ้น โดยไม่เพิ่มเหตุการณ์ใหม่\n\n'
                + '- เพิ่มรายละเอียดทางประสาทสัมผัสที่เฉพาะเจาะจงกับฉากนี้ (ไม่ใช่การไล่เช็คลิสต์ กลิ่น/เสียง/แสง)\n'
                + '- เพิ่มความคิดหรือปฏิกิริยาภายในของตัวละครตรงจุดที่ขาด\n'
                + '- ห้ามเพิ่ม beat หรือเหตุการณ์ใหม่ ห้ามเปลี่ยนตอนจบ\n'
                + '- ห้ามยืดด้วยคำฟุ่มเฟือยหรือวลีคลิเช'
                + reviseStandardEnding(),
        }),
        makeReviseTemplate({
            name: 'เพิ่มบทสนทนา',
            prompt: 'ปรับสัดส่วนของข้อความต่อไปนี้ให้มีบทสนทนามากขึ้น\n\n'
                + '- แปลงคำบรรยายที่สรุปว่าตัวละคร "พูดอะไร" ให้เป็นคำพูดจริง\n'
                + '- ให้ตัวละครพูดขัดจังหวะ พูดไม่จบประโยค หรือตอบไม่ตรงคำถามได้ตามธรรมชาติ\n'
                + '- ไม่ต้องใส่ action beat ต่อท้ายทุกบรรทัด บางบรรทัดปล่อยเป็นคำพูดเปล่าๆ\n'
                + '- เหตุการณ์และตอนจบต้องเหมือนเดิม'
                + reviseStandardEnding(),
        }),
        makeReviseTemplate({
            name: 'ตรวจความสอดคล้อง',
            prompt: 'ตรวจข้อความต่อไปนี้เทียบกับการ์ดตัวละคร ข้อมูลโลก และบทสนทนาที่ผ่านมา\n\n'
                + 'แก้เฉพาะจุดที่ขัดแย้งจริง:\n'
                + '- {{char}} พูดหรือทำหลุดนิสัย\n'
                + '- ขัดกับข้อเท็จจริงที่เคยระบุไว้ (ชื่อ สถานที่ ความสัมพันธ์ เหตุการณ์)\n'
                + '- ขัดกับสิ่งที่เพิ่งเกิดขึ้นในบทสนทนา\n\n'
                + 'ถ้าไม่พบความขัดแย้ง ให้ส่งข้อความเดิมคืนมาทั้งหมดโดยไม่แก้อะไรเลย\n'
                + 'ห้ามเกลาสำนวนหรือปรับความยาวในโหมดนี้ แก้เฉพาะความขัดแย้งเท่านั้น'
                + reviseStandardEnding(),
        }),
        makeReviseTemplate({
            name: 'ตามคำสั่ง',
            prompt: 'แก้ไขข้อความต่อไปนี้ตามคำสั่งด้านล่าง\n\n'
                + 'แก้เฉพาะสิ่งที่คำสั่งระบุ ส่วนที่เหลือเก็บไว้ให้เหมือนเดิมมากที่สุด'
                + reviseStandardEnding(),
        }),
    ];
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
        includeMemory: null,
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
        includeMemory: false,
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
        // Short-term memory: separate top-level toggle from `enabled` above, since recording
        // happens on every reply regardless of which preset (if any) is active or whether the
        // pipeline even ran for that message.
        // Medium-term (Phase 2) nests under it: it's short-term's overflow tier, so it can
        // only run while short-term recording itself is on (see maybeSummarize's guard).
        // Long-term (Phase 3) is independent of both: manually curated ("pinned"), never
        // auto-written or auto-deleted, so it does NOT depend on memory.enabled the way
        // medium does - a user can pin facts and recall them with short-term off entirely.
        memory: {
            enabled: false,
            topK: 3,
            medium: {
                enabled: false,
                everyNReplies: 10,
                topK: 3,
                summaryProfileId: '', // '' = use the currently selected Connection Profile
                summaryPrompt: defaultSummaryPrompt(),
            },
            long: {
                enabled: false,
                topK: 3,
            },
        },
        // On-demand revise (Phase 4): a button on each AI message, not part of the automatic
        // pipeline - runs once, only when clicked, against a chosen template + optional typed
        // instruction. Top-level like memory, not per-preset: revise applies to whatever
        // message is on screen regardless of which preset produced it.
        revise: (() => {
            const templates = defaultReviseTemplates();
            return {
                enabled: true,
                showButton: true,
                profileId: '', // '' = use the currently selected Connection Profile
                maxTokens: 1800, // must be large enough for a full reply - 512 (stage default) cuts it off
                templates,
                defaultTemplateId: templates[0].id, // "เกลาภาษา"
                includeHistory: true,
                historyDepth: 10,
                includeCard: true,
                includePersona: true,
                includeWorldInfo: false, // off by default - revise is mostly a language pass
                includeMemory: false,
            };
        })(),
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
    if (!stored.memory || typeof stored.memory !== 'object') {
        stored.memory = structuredClone(defaults.memory);
    } else {
        if (typeof stored.memory.enabled !== 'boolean') stored.memory.enabled = false;
        if (!Number.isFinite(stored.memory.topK) || stored.memory.topK < 1) stored.memory.topK = 3;
        if (!stored.memory.medium || typeof stored.memory.medium !== 'object') {
            stored.memory.medium = structuredClone(defaults.memory.medium);
        } else {
            const medium = stored.memory.medium;
            if (typeof medium.enabled !== 'boolean') medium.enabled = false;
            if (!Number.isFinite(medium.everyNReplies) || medium.everyNReplies < 1) medium.everyNReplies = 10;
            if (!Number.isFinite(medium.topK) || medium.topK < 1) medium.topK = 3;
            if (typeof medium.summaryProfileId !== 'string') medium.summaryProfileId = '';
            if (typeof medium.summaryPrompt !== 'string' || !medium.summaryPrompt) medium.summaryPrompt = defaultSummaryPrompt();
        }
        if (!stored.memory.long || typeof stored.memory.long !== 'object') {
            stored.memory.long = structuredClone(defaults.memory.long);
        } else {
            if (typeof stored.memory.long.enabled !== 'boolean') stored.memory.long.enabled = false;
            if (!Number.isFinite(stored.memory.long.topK) || stored.memory.long.topK < 1) stored.memory.long.topK = 3;
        }
    }
    if (!stored.revise || typeof stored.revise !== 'object') {
        stored.revise = structuredClone(defaults.revise);
    } else {
        const revise = stored.revise;
        if (typeof revise.enabled !== 'boolean') revise.enabled = true;
        if (typeof revise.showButton !== 'boolean') revise.showButton = true;
        if (typeof revise.profileId !== 'string') revise.profileId = '';
        if (!Number.isFinite(revise.maxTokens) || revise.maxTokens < 1) revise.maxTokens = 1800;
        if (typeof revise.includeHistory !== 'boolean') revise.includeHistory = true;
        if (!Number.isFinite(revise.historyDepth) || revise.historyDepth < 0) revise.historyDepth = 10;
        if (typeof revise.includeCard !== 'boolean') revise.includeCard = true;
        if (typeof revise.includePersona !== 'boolean') revise.includePersona = true;
        if (typeof revise.includeWorldInfo !== 'boolean') revise.includeWorldInfo = false;
        if (typeof revise.includeMemory !== 'boolean') revise.includeMemory = false;
        if (!Array.isArray(revise.templates) || revise.templates.length === 0) {
            revise.templates = defaultReviseTemplates();
        } else {
            revise.templates = revise.templates
                .filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.prompt === 'string')
                .map(t => makeReviseTemplate(t));
            if (revise.templates.length === 0) revise.templates = defaultReviseTemplates();
        }
        if (!revise.templates.some(t => t.id === revise.defaultTemplateId)) {
            revise.defaultTemplateId = revise.templates[0].id;
        }
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

// ---------------------------------------------------------------- revise template CRUD

export function findReviseTemplate(templateId) {
    return settings().revise.templates.find(t => t.id === templateId) ?? null;
}

/** Resolves a template for runRevise: the requested id, falling back to defaultTemplateId,
 * falling back to the first template in the list. Never returns null as long as the list is
 * non-empty, which loadSettings()/deleteReviseTemplate() both guarantee. */
export function resolveReviseTemplate(templateId) {
    return findReviseTemplate(templateId)
        ?? findReviseTemplate(settings().revise.defaultTemplateId)
        ?? settings().revise.templates[0]
        ?? null;
}

export function addReviseTemplate(name) {
    const template = makeReviseTemplate({ name: name || 'New template' });
    settings().revise.templates.push(template);
    save();
    return template;
}

export function duplicateReviseTemplate(templateId) {
    const source = findReviseTemplate(templateId);
    if (!source) return null;
    const clone = makeReviseTemplate({ ...source, id: uuidv4(), name: `${source.name} (copy)` });
    const templates = settings().revise.templates;
    templates.splice(templates.indexOf(source) + 1, 0, clone);
    save();
    return clone;
}

/** Removes a template. If it was the last one, a fresh default set is restored (never leave
 * the revise popup with nothing to pick). If it was defaultTemplateId, that now points at
 * whatever ends up first in the list. */
export function deleteReviseTemplate(templateId) {
    const revise = settings().revise;
    const index = revise.templates.findIndex(t => t.id === templateId);
    if (index === -1) return false;
    revise.templates.splice(index, 1);
    if (revise.templates.length === 0) {
        revise.templates = defaultReviseTemplates();
    }
    if (!revise.templates.some(t => t.id === revise.defaultTemplateId)) {
        revise.defaultTemplateId = revise.templates[0].id;
    }
    save();
    return true;
}

export function renameReviseTemplate(templateId, name) {
    const template = findReviseTemplate(templateId);
    if (!template || !name) return;
    template.name = name;
    save();
}

export function updateReviseTemplatePrompt(templateId, prompt) {
    const template = findReviseTemplate(templateId);
    if (!template) return;
    template.prompt = String(prompt ?? '');
    save();
}

export function setDefaultReviseTemplate(templateId) {
    const revise = settings().revise;
    if (!revise.templates.some(t => t.id === templateId)) return;
    revise.defaultTemplateId = templateId;
    save();
}

export function reorderReviseTemplates(orderedTemplateIds) {
    const revise = settings().revise;
    const byId = new Map(revise.templates.map(t => [t.id, t]));
    const reordered = orderedTemplateIds.map(id => byId.get(id)).filter(Boolean);
    for (const template of revise.templates) {
        if (!orderedTemplateIds.includes(template.id)) reordered.push(template);
    }
    revise.templates = reordered;
    save();
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
                includeMemory: typeof rawStage.includeMemory === 'boolean' ? rawStage.includeMemory : null,
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
            includeMemory: !!rawPreset.includeMemory,
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
