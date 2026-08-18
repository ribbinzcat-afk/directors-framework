import { activePreset, settings, RUNNABLE_TYPES } from './store.js';
import { scanWorldInfo, scanMemory, buildStageMessages } from './context.js';

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

const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_BASE_DELAY_MS = 5000;

/**
 * ConnectionManagerRequestService.sendRequest wraps every failure the same way, so the only
 * way to spot a provider rate limit is to pattern-match the (unwrapped) error text. Not every
 * provider phrases it the same way, but this catches the common ones (OpenAI-style
 * "rate_limit_exceeded", plain "429", "too many requests", Gemini/Anthropic "quota").
 * @param {unknown} error
 */
function isRateLimitError(error) {
    const text = describeError(error).toLowerCase();
    return /rate.?limit|too many requests|\b429\b|quota exceeded/.test(text);
}

/** @param {number} ms @param {AbortSignal} signal */
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason ?? new Error('Aborted'));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason ?? new Error('Aborted'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Retries a request up to RATE_LIMIT_MAX_RETRIES times, but only when the failure looks like
 * a provider rate limit - any other error (bad profile, invalid model, network failure)
 * fails immediately, since retrying those would just waste time before surfacing the same
 * error. Delay doubles each attempt (5s, 10s).
 * @param {() => Promise<any>} fn
 * @param {{signal: AbortSignal, onStatus?: (info: object) => void, stage: {name: string}}} opts `stage` only needs a `name` - callers outside the pipeline (e.g. revise.js) can pass any object shaped like one.
 */
export async function withRateLimitRetry(fn, { signal, onStatus, stage }) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt >= RATE_LIMIT_MAX_RETRIES || !isRateLimitError(error)) {
                throw error;
            }
            const delayMs = RATE_LIMIT_BASE_DELAY_MS * (attempt + 1);
            onStatus?.({ phase: 'rate-limited', stage, attempt: attempt + 1, maxAttempts: RATE_LIMIT_MAX_RETRIES, delayMs });
            await sleep(delayMs, signal);
        }
    }
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
        const result = await withRateLimitRetry(
            () => svc.sendRequest(profileId, initialMessages, stage.maxTokens, { stream: false, signal, extractData: true }),
            { signal, onStatus, stage },
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

        const json = await withRateLimitRetry(
            () => svc.sendRequest(profileId, messages, stage.maxTokens, { stream: false, signal, extractData: false }, overridePayload),
            { signal, onStatus, stage },
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

/**
 * ConnectionManagerRequestService.sendRequest wraps every failure - a missing API key, an
 * unset model, a 401 from the provider, a deleted profile - as the same generic
 * `new Error('API request failed', { cause: error })`. Unwrapping the cause chain here is
 * the difference between a toast that says "API request failed" (useless) and one that says
 * why (e.g. "Profile not found (ID: ...)" or the provider's actual error message).
 * @param {unknown} error
 */
/**
 * Matches the browser's own SyntaxError text for "tried to JSON.parse an HTML page"
 * (Chrome: `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`; Firefox: `JSON.parse:
 * unexpected character`). SillyTavern's own ChatCompletionService/TextCompletionService
 * (public/scripts/custom-request.js) call `response.json()` unconditionally, before checking
 * `response.ok` - so any HTML error page from the actual API endpoint (a login page, a reverse
 * proxy's 502/504 page, a CDN block page) surfaces as this cryptic parse error with none of the
 * real cause. Can't fix that in ST core from an extension, so describeError below recognizes
 * the pattern and appends a plain-language explanation instead of leaving just the raw message.
 */
function isHtmlResponseError(text) {
    return /unexpected token '<'|doctype|<html|unexpected character/i.test(text);
}

export function describeError(error) {
    const parts = [];
    let current = error;
    const seen = new Set();
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        if (current.message) parts.push(current.message);
        current = current.cause;
    }
    const joined = parts.length > 0 ? parts.join(' - ') : String(error);

    if (isHtmlResponseError(joined)) {
        return `${joined} — this means the API endpoint returned an HTML page instead of a `
            + 'response, not an actual error message from the model. Usual causes: the '
            + "Connection Profile's server URL is wrong or the server behind it is down/crashed "
            + '(common for local backends like KoboldCpp/text-generation-webui), a reverse proxy '
            + 'or gateway returned an error page (502/504), or a session/login page is being '
            + 'served instead of the API. Try that same profile in a normal (non-pipeline) reply '
            + 'first to confirm whether it works outside the pipeline.';
    }
    return joined;
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
    /** @type {import('./store.js').Stage | null} Which stage was running when/if this throws. */
    let currentStage = null;

    try {
        onStatus?.({ phase: 'world-info' });
        const worldInfo = await scanWorldInfo(preset, stContext);
        const memory = await scanMemory(preset, stContext);

        for (const [index, stage] of enabledStages.entries()) {
            abortController.signal.throwIfAborted();

            if (index > 0 && preset.stageDelaySeconds > 0) {
                onStatus?.({ phase: 'delay', stage, delayMs: preset.stageDelaySeconds * 1000 });
                await sleep(preset.stageDelaySeconds * 1000, abortController.signal);
            }

            currentStage = stage;
            onStatus?.({ phase: 'stage', index, total: enabledStages.length, stage });

            const profileId = resolveProfileId(stContext, stage.profileId);
            if (!profileId) {
                throw new Error(`Stage "${stage.name}" has no Connection Profile selected and no profile is currently active - pick one in the stage or in the Connection Manager.`);
            }
            const messages = buildStageMessages(preset, stage, stContext, worldInfo, results, memory);
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
            const reason = describeError(error);
            const label = currentStage ? `Stage "${currentStage.name}" failed` : 'Pipeline failed';
            toastr.error(reason, `Director's Framework - ${label}`, { timeOut: 8000 });
            onStatus?.({ phase: 'error', error, stage: currentStage });
        }
        return null;
    } finally {
        stContext.eventSource.removeListener(stContext.eventTypes.GENERATION_STOPPED, onStop);
        currentRun = null;
    }
}
