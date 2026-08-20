import { extensionName, loadSettings, settings } from './src/store.js';
import { runPipeline, cancelCurrentRun } from './src/runner.js';
import {
    applyPromptInjection, clearPromptInjection,
    setPendingOutput, clearPendingOutput,
    applyPendingOutputToMessage, renderMessageIfTouched,
} from './src/inject.js';
import { showStatus, hideStatus, registerCancelHandler, describeStatusEvent } from './src/status.js';
import { recordShortTermMemory } from './src/memory.js';
import { maybeSummarize } from './src/summarize.js';
import { refreshReviseButtons, bindReviseButtonHandlers } from './src/mesbuttons.js';
import { addWandToggleButtons } from './src/wandmenu.js';
import { renderAll, renderLastRun, renderPinsList, bindSettingsEvents } from './src/ui.js';

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
    setPendingOutput(result.preset, result.finalText);

    if (settings().keepLastRun) {
        renderLastRun(result);
    }
}

function onMessageReceived(messageId) {
    const stContext = SillyTavern.getContext();

    // Captured before applyPendingOutputToMessage runs, so a "show in chat" run doesn't store
    // its own Director's Notes blockquote back into memory - only the model's actual reply.
    // Independent of the pipeline's own enabled flag: memory records every reply regardless of
    // whether a preset ran for this particular message.
    const rawText = stContext.chat?.[messageId]?.mes;
    if (settings().memory.enabled) {
        // Chained (not parallel): maybeSummarize's own guards are cheap, and running it after
        // the record call keeps the two in a predictable order without needing them to
        // coordinate on shared state. Still entirely fire-and-forget from this handler's POV.
        void recordShortTermMemory(stContext, rawText).then(() => maybeSummarize(stContext));
    }

    applyPendingOutputToMessage(stContext, messageId);
}

function onCharacterMessageRendered(messageId) {
    const stContext = SillyTavern.getContext();
    // Only re-renders and saves if applyPendingOutputToMessage actually touched this message.
    renderMessageIfTouched(stContext, messageId);
    stContext.saveChat?.();
    refreshReviseButtons(stContext);
}

/** Fires when older messages are scrolled into view, and when a chat is (re)loaded - both
 * cases put new .mes elements in the DOM that never went through CHARACTER_MESSAGE_RENDERED. */
function onMoreMessagesLoaded() {
    refreshReviseButtons(SillyTavern.getContext());
}

function onGenerationEnded() {
    const stContext = SillyTavern.getContext();
    clearPromptInjection(stContext);
    hideStatus();
}

function onGenerationStopped() {
    const stContext = SillyTavern.getContext();
    clearPromptInjection(stContext);
    clearPendingOutput();
    hideStatus();
}

function onChatChanged() {
    const stContext = SillyTavern.getContext();
    // Pins are chat-scoped (chat metadata), so the drawer's pin list needs a refresh whenever
    // the user switches chats - otherwise it keeps showing the previous chat's pins.
    renderPinsList(stContext);
    // The whole #chat DOM is replaced on a chat switch, so revise/undo buttons need reinjecting.
    refreshReviseButtons(stContext);
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
        bindReviseButtonHandlers(stContext);
        refreshReviseButtons(stContext); // inject into whatever's already on screen at load
        addWandToggleButtons(stContext);

        stContext.eventSource.on(stContext.eventTypes.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
        stContext.eventSource.on(stContext.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
        stContext.eventSource.on(stContext.eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
        stContext.eventSource.on(stContext.eventTypes.GENERATION_ENDED, onGenerationEnded);
        stContext.eventSource.on(stContext.eventTypes.GENERATION_STOPPED, onGenerationStopped);
        stContext.eventSource.on(stContext.eventTypes.CHAT_CHANGED, onChatChanged);
        stContext.eventSource.on(stContext.eventTypes.MORE_MESSAGES_LOADED, onMoreMessagesLoaded);

        console.log(`[${extensionName}] Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to load:`, error);
    }
});
