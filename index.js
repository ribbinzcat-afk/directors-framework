import { extensionName, loadSettings, settings } from './src/store.js';
import { runPipeline, cancelCurrentRun } from './src/runner.js';
import {
    applyPromptInjection, clearPromptInjection,
    setPendingReasoning, clearPendingReasoning,
    applyPendingReasoningToMessage, renderReasoningUI,
} from './src/inject.js';
import { showStatus, hideStatus, registerCancelHandler, describeStatusEvent } from './src/status.js';
import { renderAll, renderLastRun, bindSettingsEvents } from './src/ui.js';

const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

/** Turns runner.js's onStatus events into status-bar updates, respecting the "show status
 * bar" setting. Hides the bar on terminal phases since the real reply generation takes over
 * immediately after. */
function makeStatusHandler() {
    return event => {
        if (!settings().showStatusBar) {
            hideStatus();
            return;
        }
        if (event.phase === 'done' || event.phase === 'cancelled' || event.phase === 'error') {
            hideStatus();
            return;
        }
        showStatus(describeStatusEvent(event));
    };
}

/**
 * The only entry point into the pipeline. Awaited inside SillyTavern's own Generate(), after
 * slash commands are processed and before the outgoing prompt is built - see the "Runtime
 * flow" section of the implementation plan for why this exact event was chosen.
 * @param {string} type Generation type ('normal', 'regenerate', 'swipe', 'continue', 'quiet', 'impersonate', ...)
 * @param {object} params
 * @param {boolean} dryRun
 */
async function onGenerationAfterCommands(type, params, dryRun) {
    const stContext = SillyTavern.getContext();

    let result = null;
    try {
        result = await runPipeline(stContext, { type, dryRun }, makeStatusHandler());
    } catch (error) {
        // runPipeline already catches its own errors; this is a last-resort net so a bug here
        // can never block the real generation that SillyTavern is about to run.
        console.error(`[${extensionName}] Unexpected error running the pipeline:`, error);
    }

    if (!result) return;

    applyPromptInjection(stContext, result.preset, result.finalText);
    setPendingReasoning(result.preset.injectMode, result.finalText);

    if (settings().keepLastRun) {
        renderLastRun(result);
    }
}

function onMessageReceived(messageId) {
    const stContext = SillyTavern.getContext();
    applyPendingReasoningToMessage(stContext, messageId);
}

function onCharacterMessageRendered(messageId) {
    const stContext = SillyTavern.getContext();
    renderReasoningUI(stContext, messageId);
    stContext.saveChat?.();
}

function onGenerationEnded() {
    const stContext = SillyTavern.getContext();
    clearPromptInjection(stContext);
    hideStatus();
}

function onGenerationStopped() {
    const stContext = SillyTavern.getContext();
    clearPromptInjection(stContext);
    clearPendingReasoning();
    hideStatus();
}

jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);

    try {
        const stContext = SillyTavern.getContext();
        loadSettings();

        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);

        bindSettingsEvents(stContext);
        renderAll(stContext);
        renderLastRun(null);

        registerCancelHandler(() => cancelCurrentRun());

        stContext.eventSource.on(stContext.eventTypes.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
        stContext.eventSource.on(stContext.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        stContext.eventSource.on(stContext.eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
        stContext.eventSource.on(stContext.eventTypes.GENERATION_ENDED, onGenerationEnded);
        stContext.eventSource.on(stContext.eventTypes.GENERATION_STOPPED, onGenerationStopped);

        console.log(`[${extensionName}] Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to load:`, error);
    }
});
