import { download, parseJsonFile, getSortableDelay } from '../../../../utils.js';
import {
    settings, save, activePreset,
    addPreset, renamePreset, duplicatePreset, deletePreset,
    addStage, duplicateStage, deleteStage, reorderStages,
    exportPreset, importPresets,
    INJECT_MODES,
} from './store.js';

const POPUP_TITLE = "Director's Framework";

// ---------------------------------------------------------------- profile dropdowns

/**
 * Fills a <select> with every Connection Manager profile the pipeline can use, plus a
 * "use currently selected profile" default. Built by hand (rather than via
 * ConnectionManagerRequestService.handleDropdown) because stage rows are re-created on every
 * preset switch / add / remove / reorder - handleDropdown attaches new eventSource listeners
 * on every call and has no matching teardown, which would leak a listener per re-render.
 * Instead, one listener (registered once in mountSettingsUI) refreshes every currently
 * rendered profile <select> in place.
 * @param {any} stContext
 * @param {HTMLSelectElement} selectEl
 * @param {string} selectedProfileId
 */
function populateProfileSelect(stContext, selectEl, selectedProfileId) {
    selectEl.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Use currently selected profile';
    selectEl.appendChild(defaultOption);

    let profiles = [];
    try {
        profiles = stContext.ConnectionManagerRequestService.getSupportedProfiles();
    } catch (error) {
        // Connection Manager extension is disabled - leave just the default option.
    }

    for (const profile of [...profiles].sort((a, b) => a.name.localeCompare(b.name))) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        selectEl.appendChild(option);
    }

    selectEl.value = selectedProfileId || '';
}

function refreshAllProfileSelects(stContext) {
    for (const select of document.querySelectorAll('#df_stages .df-stage-profile')) {
        populateProfileSelect(stContext, select, select.value);
    }
}

// ---------------------------------------------------------------- stage row

function renderDependsOn(container, preset, stage) {
    container.innerHTML = '';
    const index = preset.stages.indexOf(stage);
    const earlier = preset.stages.slice(0, index);

    if (earlier.length === 0) {
        container.innerHTML = '<p class="df-empty-hint"><small>No earlier stages to depend on yet.</small></p>';
        return;
    }

    for (const other of earlier) {
        const label = document.createElement('label');
        label.className = 'checkbox_label df-depends-item';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'df-depends-checkbox';
        input.value = other.id;
        input.checked = stage.dependsOn.includes(other.id);
        const span = document.createElement('span');
        span.textContent = other.name;
        label.append(input, span);
        container.appendChild(label);
    }
}

function renderToolsList(stContext, container, stage) {
    container.innerHTML = '';
    const tools = stContext.ToolManager?.tools ?? [];

    if (tools.length === 0) {
        container.innerHTML = '<p class="df-empty-hint"><small>No tools are registered by SillyTavern right now.</small></p>';
        return;
    }

    for (const tool of tools) {
        let name = '';
        let description = '';
        try {
            const def = tool.toFunctionOpenAI();
            name = def.function.name;
            description = def.function.description || '';
        } catch (error) {
            continue;
        }
        const label = document.createElement('label');
        label.className = 'checkbox_label df-tool-item';
        label.title = description;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'df-tool-checkbox';
        input.value = name;
        input.checked = stage.tools.names.includes(name);
        const span = document.createElement('span');
        span.textContent = tool.displayName || name;
        label.append(input, span);
        container.appendChild(label);
    }
}

function toggleToolsVisibility(stageEl, stage) {
    stageEl.querySelector('.df-tools-body')?.classList.toggle('df-hidden', !stage.tools.enabled);
}

function stageRowSkeleton() {
    const el = document.createElement('div');
    el.className = 'df-stage';
    el.innerHTML = `
        <div class="df-stage-head">
            <div class="df-handle drag-handle fa-solid fa-grip-vertical" title="Drag to reorder"></div>
            <input class="text_pole df-stage-name" type="text" autocomplete="off" />
            <label class="checkbox_label df-stage-enabled-label">
                <input type="checkbox" class="df-stage-enabled" />
                <span>On</span>
            </label>
            <div class="df-icon-btn interactable fa-solid fa-copy" data-action="duplicate-stage" tabindex="0" title="Duplicate stage"></div>
            <div class="df-icon-btn interactable fa-solid fa-trash-can" data-action="delete-stage" tabindex="0" title="Delete stage"></div>
        </div>
        <div class="df-stage-body">
            <div class="df-field-row">
                <label>Connection profile</label>
                <select class="df-stage-profile text_pole"></select>
            </div>
            <div class="df-field-row">
                <label>Prompt role</label>
                <select class="df-stage-role text_pole">
                    <option value="user">User</option>
                    <option value="system">System</option>
                    <option value="assistant">Assistant</option>
                </select>
            </div>
            <div class="df-field-row">
                <label>Max tokens</label>
                <input type="number" class="df-stage-max-tokens text_pole" min="1" />
            </div>
            <div class="df-field-row df-field-row-wide">
                <label>Prompt</label>
                <textarea class="df-stage-prompt text_pole" rows="3" autocomplete="off"></textarea>
            </div>
            <div class="df-field-row">
                <label class="checkbox_label"><input type="checkbox" class="df-stage-include-history" /><span>Include chat history</span></label>
                <input type="number" class="df-stage-history-depth text_pole" placeholder="preset default" min="0" />
            </div>
            <div class="df-field-row">
                <label>World Info</label>
                <select class="df-stage-world-info text_pole">
                    <option value="">Use preset default</option>
                    <option value="true">Include</option>
                    <option value="false">Exclude</option>
                </select>
            </div>
            <label class="checkbox_label"><input type="checkbox" class="df-stage-include-final" /><span>Include this stage's output in the final injection</span></label>

            <div class="df-stage-depends">
                <label>Depends on</label>
                <div class="df-depends-list"></div>
            </div>

            <div class="df-stage-tools">
                <label class="checkbox_label"><input type="checkbox" class="df-stage-tools-enabled" /><span>Allow tool calls (Chat Completion profiles only)</span></label>
                <div class="df-tools-body df-hidden">
                    <div class="df-field-row">
                        <label>Tool choice</label>
                        <select class="df-stage-tools-mode text_pole">
                            <option value="auto">Auto</option>
                            <option value="required">Required</option>
                        </select>
                    </div>
                    <div class="df-tools-list"></div>
                </div>
            </div>
        </div>
    `;
    return el;
}

function renderStageRow(stContext, preset, stage) {
    const el = stageRowSkeleton();
    el.dataset.id = stage.id;

    el.querySelector('.df-stage-name').value = stage.name;
    el.querySelector('.df-stage-enabled').checked = stage.enabled;
    el.querySelector('.df-stage-role').value = stage.role;
    el.querySelector('.df-stage-max-tokens').value = String(stage.maxTokens);
    el.querySelector('.df-stage-prompt').value = stage.prompt;
    el.querySelector('.df-stage-include-history').checked = stage.includeHistory;
    el.querySelector('.df-stage-history-depth').value = stage.historyDepth ?? '';
    el.querySelector('.df-stage-world-info').value = stage.includeWorldInfo === null ? '' : String(stage.includeWorldInfo);
    el.querySelector('.df-stage-include-final').checked = stage.includeInFinal;
    el.querySelector('.df-stage-tools-enabled').checked = stage.tools.enabled;
    el.querySelector('.df-stage-tools-mode').value = stage.tools.mode;

    populateProfileSelect(stContext, el.querySelector('.df-stage-profile'), stage.profileId);
    renderDependsOn(el.querySelector('.df-depends-list'), preset, stage);
    renderToolsList(stContext, el.querySelector('.df-tools-list'), stage);
    toggleToolsVisibility(el, stage);

    return el;
}

function renderStages(stContext, preset) {
    const container = document.getElementById('df_stages');
    if (!container) return;
    container.innerHTML = '';

    if (!preset || preset.stages.length === 0) {
        container.innerHTML = '<p class="df-empty-hint"><small>No stages yet. Add one to get started.</small></p>';
        return;
    }

    for (const stage of preset.stages) {
        container.appendChild(renderStageRow(stContext, preset, stage));
    }

    // @ts-ignore - jQuery UI, same pattern as quick-prompt/index.js renderCategories
    $(container).sortable({
        delay: getSortableDelay(),
        handle: '.df-handle',
        items: '> .df-stage',
        stop: () => {
            const order = [...container.querySelectorAll(':scope > .df-stage')].map(e => e.dataset.id);
            reorderStages(preset.id, order);
            renderStages(stContext, activePreset());
        },
    });
}

// ---------------------------------------------------------------- preset-level fields

function renderPresetSelect() {
    const select = document.getElementById('df_preset_select');
    if (!(select instanceof HTMLSelectElement)) return;
    select.innerHTML = '';
    for (const preset of settings().presets) {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.name;
        select.appendChild(option);
    }
    select.value = settings().activePresetId;
}

function renderPresetFields(preset) {
    if (!preset) return;
    document.getElementById('df_inject_mode').value = preset.injectMode;
    document.getElementById('df_inject_role').value = preset.injectRole;
    document.getElementById('df_inject_depth').value = String(preset.injectDepth);
    document.getElementById('df_inject_template').value = preset.injectTemplate;
    document.getElementById('df_history_depth').value = String(preset.historyDepth);
    document.getElementById('df_include_card').checked = preset.includeCard;
    document.getElementById('df_include_persona').checked = preset.includePersona;
    document.getElementById('df_include_world_info').checked = preset.includeWorldInfo;
}

function renderGlobalControls() {
    const cfg = settings();
    document.getElementById('df_enabled').checked = cfg.enabled;
    document.getElementById('df_status_bar').checked = cfg.showStatusBar;
    for (const checkbox of document.querySelectorAll('.df-run-type')) {
        checkbox.checked = cfg.runOnTypes.includes(checkbox.value);
    }
}

export function renderAll(stContext) {
    renderGlobalControls();
    renderPresetSelect();
    const preset = activePreset();
    renderPresetFields(preset);
    renderStages(stContext, preset);
}

// ---------------------------------------------------------------- last-run log

function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '';
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Renders the "Last run log" drawer from a completed runner.js result: one block per stage
 * with the profile used, the prompt actually sent, the output, and how long it took.
 * @param {{preset: object, results: Record<string, {stage: object, output: string, profileId: string, messages: {role:string,content:string}[], startedAt: number, finishedAt: number}>} | null} runResult
 */
export function renderLastRun(runResult) {
    const content = document.getElementById('df_last_run_content');
    if (!content) return;

    if (!runResult) {
        content.innerHTML = '<p class="df-empty-hint"><small>No run yet.</small></p>';
        return;
    }

    content.innerHTML = '';
    const enabledStages = runResult.preset.stages.filter(s => runResult.results[s.id]);

    for (const stage of enabledStages) {
        const entry = runResult.results[stage.id];
        const block = document.createElement('div');
        block.className = 'df-log-block';

        const header = document.createElement('div');
        header.className = 'df-log-header';
        header.textContent = `${stage.name} - ${formatDuration(entry.finishedAt - entry.startedAt)}`;
        block.appendChild(header);

        const promptText = entry.messages.map(m => `[${m.role}] ${m.content}`).join('\n\n');
        const promptPre = document.createElement('pre');
        promptPre.className = 'df-log-prompt';
        promptPre.textContent = promptText;

        const outputPre = document.createElement('pre');
        outputPre.className = 'df-log-output';
        outputPre.textContent = entry.output || '(empty)';

        const promptDetails = document.createElement('details');
        promptDetails.className = 'df-log-details';
        const promptSummary = document.createElement('summary');
        promptSummary.textContent = 'Prompt sent';
        promptDetails.append(promptSummary, promptPre);

        const outputLabel = document.createElement('div');
        outputLabel.className = 'df-log-output-label';
        outputLabel.textContent = 'Output';

        block.append(promptDetails, outputLabel, outputPre);
        content.appendChild(block);
    }

    if (runResult.finalText) {
        const finalBlock = document.createElement('div');
        finalBlock.className = 'df-log-block df-log-final';
        const header = document.createElement('div');
        header.className = 'df-log-header';
        header.textContent = 'Injected into final prompt';
        const pre = document.createElement('pre');
        pre.className = 'df-log-output';
        pre.textContent = runResult.finalText;
        finalBlock.append(header, pre);
        content.appendChild(finalBlock);
    }
}

// ---------------------------------------------------------------- event binding

function withActiveStage(preset, stageEl, fn) {
    const stage = preset?.stages.find(s => s.id === stageEl?.dataset.id);
    if (!preset || !stage) return;
    fn(stage);
}

function bindStagesEvents(stContext) {
    const container = document.getElementById('df_stages');

    container.addEventListener('input', evt => {
        const el = evt.target;
        if (!(el instanceof HTMLElement)) return;
        const stageEl = el.closest('.df-stage');
        if (!stageEl) return;
        const preset = activePreset();

        withActiveStage(preset, stageEl, stage => {
            if (el.classList.contains('df-stage-name')) {
                stage.name = el.value;
                save();
                // Stage names show up in other rows' "depends on" and "included stages" lists.
                renderStages(stContext, preset);
            } else if (el.classList.contains('df-stage-prompt')) {
                stage.prompt = el.value;
                save();
            } else if (el.classList.contains('df-stage-max-tokens')) {
                stage.maxTokens = Math.max(1, Number(el.value) || 1);
                save();
            } else if (el.classList.contains('df-stage-history-depth')) {
                stage.historyDepth = el.value === '' ? null : Math.max(0, Number(el.value) || 0);
                save();
            }
        });
    });

    container.addEventListener('change', evt => {
        const el = evt.target;
        if (!(el instanceof HTMLElement)) return;
        const stageEl = el.closest('.df-stage');
        if (!stageEl) return;
        const preset = activePreset();

        withActiveStage(preset, stageEl, stage => {
            if (el.classList.contains('df-stage-enabled')) {
                stage.enabled = el.checked;
                save();
            } else if (el.classList.contains('df-stage-profile')) {
                stage.profileId = el.value;
                save();
            } else if (el.classList.contains('df-stage-role')) {
                stage.role = el.value;
                save();
            } else if (el.classList.contains('df-stage-include-history')) {
                stage.includeHistory = el.checked;
                save();
            } else if (el.classList.contains('df-stage-world-info')) {
                stage.includeWorldInfo = el.value === '' ? null : el.value === 'true';
                save();
            } else if (el.classList.contains('df-stage-include-final')) {
                stage.includeInFinal = el.checked;
                save();
            } else if (el.classList.contains('df-depends-checkbox')) {
                const id = el.value;
                stage.dependsOn = el.checked
                    ? [...new Set([...stage.dependsOn, id])]
                    : stage.dependsOn.filter(x => x !== id);
                save();
            } else if (el.classList.contains('df-stage-tools-enabled')) {
                stage.tools.enabled = el.checked;
                save();
                toggleToolsVisibility(stageEl, stage);
            } else if (el.classList.contains('df-stage-tools-mode')) {
                stage.tools.mode = el.value;
                save();
            } else if (el.classList.contains('df-tool-checkbox')) {
                const name = el.value;
                stage.tools.names = el.checked
                    ? [...new Set([...stage.tools.names, name])]
                    : stage.tools.names.filter(x => x !== name);
                save();
            }
        });
    });

    container.addEventListener('click', async evt => {
        const button = evt.target instanceof HTMLElement ? evt.target.closest('[data-action]') : null;
        if (!button) return;
        const stageEl = button.closest('.df-stage');
        const preset = activePreset();
        if (!preset || !stageEl) return;
        const stage = preset.stages.find(s => s.id === stageEl.dataset.id);
        if (!stage) return;

        if (button.dataset.action === 'duplicate-stage') {
            duplicateStage(preset.id, stage.id);
            renderStages(stContext, activePreset());
        } else if (button.dataset.action === 'delete-stage') {
            const confirmed = await stContext.Popup.show.confirm(POPUP_TITLE, `Delete the stage "${stage.name}"?`);
            if (!confirmed) return;
            deleteStage(preset.id, stage.id);
            renderStages(stContext, activePreset());
        }
    });
}

function bindPresetBar(stContext) {
    $('#df_preset_select').on('change', function () {
        settings().activePresetId = /** @type {string} */ ($(this).val());
        save();
        renderAll(stContext);
    });

    $('#df_preset_new').on('click', async () => {
        const name = await stContext.Popup.show.input(POPUP_TITLE, 'Name for the new preset', 'New preset');
        if (name === null) return;
        addPreset(name);
        renderAll(stContext);
    });

    $('#df_preset_rename').on('click', async () => {
        const preset = activePreset();
        if (!preset) return;
        const name = await stContext.Popup.show.input(POPUP_TITLE, 'Rename preset', preset.name);
        if (name === null || name === '') return;
        renamePreset(preset.id, name);
        renderAll(stContext);
    });

    $('#df_preset_duplicate').on('click', () => {
        const preset = activePreset();
        if (!preset) return;
        duplicatePreset(preset.id);
        renderAll(stContext);
    });

    $('#df_preset_delete').on('click', async () => {
        const preset = activePreset();
        if (!preset) return;
        const confirmed = await stContext.Popup.show.confirm(POPUP_TITLE, `Delete the preset "${preset.name}"? This cannot be undone.`);
        if (!confirmed) return;
        deletePreset(preset.id);
        renderAll(stContext);
    });

    $('#df_preset_export').on('click', () => {
        const preset = activePreset();
        if (!preset) return;
        const payload = exportPreset(preset.id);
        const safeName = preset.name.replace(/[^\w\- ]+/g, '').trim() || 'preset';
        download(JSON.stringify(payload, null, 4), `directors-framework-${safeName}.json`, 'application/json');
    });

    $('#df_preset_import').on('click', () => $('#df_preset_import_file').trigger('click'));
    $('#df_preset_import_file').on('change', async evt => {
        const file = evt.target.files?.[0];
        evt.target.value = '';
        if (!file) return;

        try {
            const data = await parseJsonFile(file);
            const count = importPresets(data);
            if (count === 0) {
                toastr.warning('Nothing to import from that file.', POPUP_TITLE);
                return;
            }
            renderAll(stContext);
            toastr.success(`Imported ${count} preset(s).`, POPUP_TITLE);
        } catch (error) {
            console.error('[directors-framework] Import failed:', error);
            toastr.error('Could not read that file.', POPUP_TITLE);
        }
    });
}

function bindPresetFields(stContext) {
    const onPreset = fn => {
        const preset = activePreset();
        if (!preset) return;
        fn(preset);
        save();
    };

    $('#df_inject_mode').on('change', function () {
        onPreset(p => { p.injectMode = INJECT_MODES.includes($(this).val()) ? $(this).val() : p.injectMode; });
    });
    $('#df_inject_role').on('change', function () {
        onPreset(p => { p.injectRole = $(this).val(); });
    });
    $('#df_inject_depth').on('input', function () {
        onPreset(p => { p.injectDepth = Math.max(0, Number($(this).val()) || 0); });
    });
    $('#df_inject_template').on('input', function () {
        onPreset(p => { p.injectTemplate = String($(this).val()); });
    });
    $('#df_history_depth').on('input', function () {
        onPreset(p => { p.historyDepth = Math.max(0, Number($(this).val()) || 0); });
    });
    $('#df_include_card').on('input', function () {
        onPreset(p => { p.includeCard = $(this).prop('checked'); });
    });
    $('#df_include_persona').on('input', function () {
        onPreset(p => { p.includePersona = $(this).prop('checked'); });
    });
    $('#df_include_world_info').on('input', function () {
        onPreset(p => { p.includeWorldInfo = $(this).prop('checked'); });
    });
}

function bindGlobalControls(stContext) {
    $('#df_enabled').on('input', function () {
        settings().enabled = $(this).prop('checked');
        save();
    });
    $('#df_status_bar').on('input', function () {
        settings().showStatusBar = $(this).prop('checked');
        save();
    });
    $('.df-run-type').on('input', function () {
        const value = String($(this).val());
        const checked = $(this).prop('checked');
        const types = new Set(settings().runOnTypes);
        checked ? types.add(value) : types.delete(value);
        settings().runOnTypes = [...types];
        save();
    });
    $('#df_stage_add').on('click', () => {
        const preset = activePreset();
        if (!preset) return;
        addStage(preset.id);
        renderStages(stContext, activePreset());
    });
}

/**
 * Mounts the settings drawer into #extensions_settings2 and wires every control. Call once
 * at startup, after `loadSettings()`.
 * @param {any} stContext SillyTavern.getContext()
 */
export function bindSettingsEvents(stContext) {
    bindGlobalControls(stContext);
    bindPresetBar(stContext);
    bindPresetFields(stContext);
    bindStagesEvents(stContext);

    // One shared listener keeps every rendered profile <select> in sync with Connection
    // Manager instead of re-registering a listener per dropdown per re-render (see
    // populateProfileSelect's doc comment for why).
    stContext.eventSource.on(stContext.eventTypes.CONNECTION_PROFILE_CREATED, () => refreshAllProfileSelects(stContext));
    stContext.eventSource.on(stContext.eventTypes.CONNECTION_PROFILE_UPDATED, () => refreshAllProfileSelects(stContext));
    stContext.eventSource.on(stContext.eventTypes.CONNECTION_PROFILE_DELETED, () => refreshAllProfileSelects(stContext));
}
