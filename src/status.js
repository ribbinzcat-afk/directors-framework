/**
 * Floating status bar shown above the chat box (between #chat and #form_sheld) while a
 * pipeline is running: "Stage 2/4: Consistency check..." plus a cancel button. Built lazily
 * on first use and reused afterwards; index.js drives it from runner.js's onStatus callback.
 */

let bar = null;
let onCancel = null;

function build() {
    const el = document.createElement('div');
    el.id = 'df-status-bar';
    el.className = 'df-status-bar';
    el.innerHTML = `
        <i class="df-status-icon fa-solid fa-clapperboard"></i>
        <span class="df-status-text"></span>
        <div class="df-status-cancel interactable fa-solid fa-xmark" title="Cancel" tabindex="0" role="button"></div>
    `;

    const cancelEl = el.querySelector('.df-status-cancel');
    cancelEl.addEventListener('click', () => onCancel?.());
    cancelEl.addEventListener('keydown', evt => {
        if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault();
            onCancel?.();
        }
    });

    const formSheld = document.getElementById('form_sheld');
    if (formSheld?.parentElement) {
        formSheld.parentElement.insertBefore(el, formSheld);
    } else {
        // Shouldn't happen in a normal SillyTavern page, but don't throw if the DOM ever changes.
        document.body.appendChild(el);
    }
    return el;
}

function ensureBar() {
    if (!bar || !document.body.contains(bar)) {
        bar = build();
    }
    return bar;
}

/** @param {() => void} fn Called when the user clicks/activates the cancel button. */
export function registerCancelHandler(fn) {
    onCancel = fn;
}

/** @param {string} text */
export function showStatus(text) {
    const el = ensureBar();
    el.querySelector('.df-status-text').textContent = text;
    el.classList.add('df-status-visible');
}

/** @param {string} text */
export function updateStatus(text) {
    if (!bar) return;
    bar.querySelector('.df-status-text').textContent = text;
}

export function hideStatus() {
    bar?.classList.remove('df-status-visible');
}

/**
 * Turns a runner.js onStatus event into a short human-readable line.
 * @param {object} event
 */
export function describeStatusEvent(event) {
    switch (event.phase) {
        case 'world-info':
            return "Director's Framework: reading World Info...";
        case 'stage':
            return `Director's Framework: stage ${event.index + 1}/${event.total} - ${event.stage.name}`;
        case 'tool-call':
            return `Director's Framework: ${event.stage.name} is calling a tool...`;
        case 'delay':
            return `Director's Framework: waiting ${Math.round(event.delayMs / 1000)}s before "${event.stage.name}"...`;
        case 'rate-limited':
            return `Director's Framework: rate limited, retrying "${event.stage.name}" in ${Math.round(event.delayMs / 1000)}s (${event.attempt}/${event.maxAttempts})...`;
        case 'done':
            return "Director's Framework: done";
        case 'cancelled':
            return "Director's Framework: cancelled";
        case 'error':
            return "Director's Framework: error - see console";
        default:
            return "Director's Framework";
    }
}
