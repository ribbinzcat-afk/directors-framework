import { activePreset, settings, RUNNABLE_TYPES } from './store.js';
import { scanWorldInfo, buildStageMessages } from './context.js';

/**
 * Module-level run state. Only one pipeline can be in flight at a time - SillyTavern itself
 * only ever has one generation running, and GENERATION_AFTER_COMMANDS is awaited before the
 * real request is built, so overlap should never happen in practice. The guard is here purely
 * as a safety net.
 * @type {{ abortController: AbortController } | null}
 */
let currentRun = null;

export function isRunning() {
    return !!currentRun;
}

/** Aborts the in-flight pipeline, if any. Used by the status bar's cancel button. */
export function cancelCurrentRun() {
    currentRun?.abortController.abort(new Error('Cancelled by user'));
}

function resolveProfileId(stContext, profileId) {
    if (profileId) return profileId;
    return stContext.extensionSettings?.connectionManager?.selectedProfile || '';
}

/**
 * Builds the OpenAI-style tool definitions for a stage, respecting its name allowlist
 * (empty allowlist = every registered tool) and each tool's own shouldRegister() gate.
 * @param {any} stContext
 * @param {import('./store.js').Stage} stage
 */
async function buildToolsPayload(stContext, stage) {
    const manager = stContext.ToolManager;
    if (!manager) return [];

    const selected = [];
    for (const tool of manager.tools) {
        const definition = tool.toFunctionOpenAI();
        const name = definition.function.name;
        if (stage.tools.names.length > 0 && !stage.tools.names.includes(name)) continue;
        try {
            if (!(await tool.shouldRegister())) continue;
        } catch (error) {
            console.error(`[directors-framework] shouldRegister() failed for tool "${name}":`, error);
            continue;
        }
        selected.push(definition);
    }
    return selected;
}

/**
 * Runs one stage, looping on tool calls (up to the same recursion limit SillyTavern itself
 * uses) when the stage has tools enabled. Returns the stage's final text output.
 * @param {any} stContext
 * @param {import('./store.js').Stage} stage
 * @param {{role: string, content: string}[]} initialMessages
 * @param {string} profileId
 * @param {AbortSignal} signal
 * @param {(info: object) => void} onStatus
 * @returns {Promise<string>}
 */
async function runStage(stContext, stage, initialMessages, profileId, signal, onStatus) {
    const svc = stContext.ConnectionManagerRequestService;

    const wantsTools = !!stage.tools?.enabled;
    let useTools = wantsTools;
    if (wantsTools) {
        const profile = svc.getProfile(profileId);
        const apiMap = svc.validateProfile(profile);
        if (apiMap.selected !== 'openai') {
            console.warn(`[directors-framework] Stage "${stage.name}" has tools enabled but its connection profile is Text Completion; tool calls require Chat Completion. Running without tools.`);
            useTools = false;
        }
    }

    if (!useTools) {
        const result = await svc.sendRequest(
            profileId,
            initialMessages,
            stage.maxTokens,
            { stream: false, signal, extractData: true },
        );
        return typeof result === 'string' ? result : (result?.content ?? '');
    }

    const messages = [...initialMessages];
    const recurseLimit = stContext.ToolManager?.RECURSE_LIMIT ?? 5;
    let lastContent = '';

    for (let i = 0; i < recurseLimit; i++) {
        signal.throwIfAborted();

        const tools = await buildToolsPayload(stContext, stage);
        const overridePayload = tools.length > 0
            ? { tools, tool_choice: stage.tools.mode === 'required' ? 'required' : 'auto' }
            : {};

        const json = await svc.sendRequest(
            profileId,
            messages,
            stage.maxTokens,
            { stream: false, signal, extractData: false },
            overridePayload,
        );

        lastContent = stContext.extractMessageFromData(json, 'openai');

        if (!stContext.ToolManager.hasToolCalls(json)) {
            break;
        }

        onStatus?.({ phase: 'tool-call', stage });
        const { invocations } = await stContext.ToolManager.invokeFunctionTools(json);

        if (invocations.length === 0) {
            break;
        }

        if (lastContent) {
            messages.push({ role: 'assistant', content: lastContent });
        }
        const toolSummary = invocations
            .map(inv => `Tool call: ${inv.name}(${inv.parameters}) -> ${inv.error ? `Error: ${inv.result}` : inv.result}`)
            .join('\n');
        messages.push({ role: 'system', content: toolSummary });
    }

    return lastContent;
}

function composeFinalOutput(stages, results) {
    const parts = [];
    for (const stage of stages) {
        if (!stage.includeInFinal) continue;
        const entry = results[stage.id];
        if (!entry || !entry.output) continue;
        parts.push(`[${stage.name}]\n${String(entry.output).trim()}`);
    }
    return parts.join('\n\n');
}

/**
 * Runs the active preset's pipeline: World Info scan once, then every enabled stage in order,
 * each with its own connection profile and (optionally) its own tool-call loop. Returns null
 * if the pipeline didn't run (disabled, wrong generation type, dry run, no stages, etc.) or if
 * it was cancelled/failed - in both cases the real generation proceeds unaffected.
 * @param {any} stContext SillyTavern.getContext()
 * @param {{type: string, dryRun: boolean}} genInfo
 * @param {(info: object) => void} [onStatus]
 * @returns {Promise<{preset: import('./store.js').Preset, results: Record<string, {stage: import('./store.js').Stage, output: string}>, finalText: string} | null>}
 */
export async function runPipeline(stContext, { type, dryRun }, onStatus) {
    if (dryRun) return null;

    const cfg = settings();
    if (!cfg.enabled) return null;
    if (!RUNNABLE_TYPES.includes(type) || !cfg.runOnTypes.includes(type)) return null;
    if (currentRun) return null;

    const preset = activePreset();
    if (!preset) return null;

    const enabledStages = preset.stages.filter(s => s.enabled);
    if (enabledStages.length === 0) return null;

    const abortController = new AbortController();
    currentRun = { abortController };

    const onStop = () => abortController.abort(new Error('Generation stopped'));
    stContext.eventSource.on(stContext.eventTypes.GENERATION_STOPPED, onStop);

    /** @type {Record<string, {stage: import('./store.js').Stage, output: string}>} */
    const results = {};

    try {
        onStatus?.({ phase: 'world-info' });
        const worldInfo = await scanWorldInfo(preset, stContext);

        for (const [index, stage] of enabledStages.entries()) {
            abortController.signal.throwIfAborted();
            onStatus?.({ phase: 'stage', index, total: enabledStages.length, stage });

            const profileId = resolveProfileId(stContext, stage.profileId);
            const messages = buildStageMessages(preset, stage, stContext, worldInfo, results);
            const startedAt = Date.now();
            const output = await runStage(stContext, stage, messages, profileId, abortController.signal, onStatus);
            results[stage.id] = { stage, output, profileId, messages, startedAt, finishedAt: Date.now() };
        }

        const finalText = composeFinalOutput(enabledStages, results);
        onStatus?.({ phase: 'done', results, finalText });
        return { preset, results, finalText };
    } catch (error) {
        if (abortController.signal.aborted) {
            console.log('[directors-framework] Pipeline cancelled.');
            onStatus?.({ phase: 'cancelled' });
        } else {
            console.error('[directors-framework] Pipeline failed:', error);
            toastr.error(String(error?.message || error), "Director's Framework");
            onStatus?.({ phase: 'error', error });
        }
        return null;
    } finally {
        stContext.eventSource.removeListener(stContext.eventTypes.GENERATION_STOPPED, onStop);
        currentRun = null;
    }
}
