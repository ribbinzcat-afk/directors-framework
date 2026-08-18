# Director's Framework

Run a chain of your own thinking steps — each with its own prompt, its own Connection
Profile, and optional tool calls — before SillyTavern's final reply. The combined output is
injected into the final prompt and, optionally, written into the reply's reasoning block.

## What it does

- **Stages**: each stage has its own prompt, role, max tokens, and Connection Profile
  (or "use the currently selected profile"). Stages run top to bottom.
- **Dependencies**: a stage can pull in the output of any earlier stage (`Depends on`), so
  e.g. a "Consistency check" stage can see what "Planning" produced.
- **Context per stage**: chat history (depth configurable per preset or per stage),
  character card / persona, World Info / lorebook, and three-tier memory — each toggleable.
- **Memory** *(experimental)*: every reply is embedded and stored per-chat via SillyTavern's
  own vector search (`/api/vector/*`, the free local `transformers` source - no API key
  needed). Turned off by default; enable it under the "Memory" section, then turn on "memory"
  per preset/stage to pull the most relevant past context into that stage - not just the last
  few messages.
  - **Short-term**: every reply, stored verbatim.
  - **Medium-term**: every N replies, the last N messages are compressed into a summary by an
    LLM call (its own Connection Profile) and moved out of short-term - so old detail isn't
    lost when it ages out, just condensed. Off by default even when short-term is on.
  - **Long-term (pinned)**: facts you pin by hand - never written or deleted automatically.
    Pin a stage's output straight from the Last run log, or type one in directly. Works
    independently of the other two tiers (recall even with short/medium-term off).
  - See "Memory internals" below for how the tiers actually work.
- **Tool calls per stage**: a stage can be allowed to call SillyTavern-registered tools
  (Chat Completion profiles only), in `auto` or `required` mode, restricted to a chosen
  subset of tools.
- **On-demand revise**: a <i class="fa-solid fa-wand-magic-sparkles"></i> button on every AI
  message (in "Message Actions"). Click it, pick a template (or type a free-text instruction),
  and that one message is rewritten in place - the reply SillyTavern already generated *is*
  the draft, so this edits it directly instead of running a shadow draft through the
  automatic pipeline (cheaper, and exact instead of hoping the final reply follows a draft it
  was only shown as context). Ships with 6 templates (language polish, tighten, expand, more
  dialogue, consistency check, and a free-instruction catch-all) - add/edit/reorder/delete
  your own in the Revise section. A <i class="fa-solid fa-rotate-left"></i> undo button
  appears once a message has been revised, and always restores the model's original reply
  regardless of how many times it's been revised since. See "Revise internals" below.
- **Injection**: the combined output of every stage marked "include in final" is inserted
  into the outgoing prompt at the latest message position, and — unless the preset is set
  to "prompt only" — written into the reply's reasoning block, either replacing the model's
  own reasoning or placed before it. Independently, "show in chat" also prepends it to the
  reply's *visible* text as a blockquote — useful because not every model/provider returns a
  reasoning block at all, so relying on that alone can make the pipeline's work invisible.
- **Rate-limit resilience**: a stage that fails with what looks like a provider rate limit
  (429 / "too many requests" / quota) is retried automatically, twice, with a growing wait.
  If several stages still get rate limited on the same API key, set "Delay between stages" on
  the preset to space the requests out further.
- **Presets**: a full stage pipeline is a preset. New / rename / duplicate / delete /
  export / import (JSON).
- **Status bar**: a small bar above the chat input shows which stage is currently running,
  with a cancel button.
- **Last run log**: a collapsible drawer showing, per stage, the exact prompt sent, the
  output, the profile used, and how long it took.
- **Wand-menu shortcut**: a <i class="fa-solid fa-clapperboard"></i> item in the wand
  (<i class="fa-solid fa-wand-magic-sparkles"></i>) menu next to the chat box toggles the
  whole extension on/off without opening the settings drawer - its icon (and the settings
  checkbox) always stay in sync with each other.
- **Organized settings**: Memory, Revise, and Presets & Stages each live in their own
  collapsible section, so only what you're working on is ever expanded.

## Installation

Copy the whole `directors-framework` folder into your user extensions directory:

```
<SillyTavern>/data/<your-user>/extensions/directors-framework/
```

The folder must be named exactly `directors-framework` — that has to match
`extensionName` in `src/store.js`.

Reload SillyTavern, then open **Extensions → Director's Framework**.

## Quick start

1. Tick **Enable Director's Framework**.
2. A starter preset ("Plan then check") is created automatically with two stages:
   - **Planning** — thinks through the scene.
   - **Consistency check** — depends on Planning, checks it against the character card
     and history.
3. Give each stage a Connection Profile (leave blank to reuse whichever profile is
   currently selected).
4. Send a message. A status bar appears above the chat box while the stages run; once
   done, the combined output is folded into the final prompt and the reply's reasoning
   block (see **Reasoning injection** in the preset settings to change that behavior).
5. Open **Last run log** to see exactly what was sent to each stage and what came back.
6. Independently of all that: every AI message has a <i class="fa-solid fa-wand-magic-sparkles"></i>
   button in its "Message Actions" menu. Click it, pick a template, and that one reply is
   rewritten in place - no pipeline involved. Give it its own Connection Profile in the
   **Revise** section first (or leave it blank to reuse whichever's currently selected).

## How it fits into generation

The pipeline runs during SillyTavern's `GENERATION_AFTER_COMMANDS` event — after slash
commands are processed, before the outgoing prompt is built. Each stage is sent with
`ConnectionManagerRequestService.sendRequest()` directly (not through `Generate()`), so the
pipeline can never recurse into itself. If the pipeline errors or is disabled, the real
generation proceeds exactly as if the extension weren't installed.

World Info is scanned **once per run** (not once per stage) with `isDryRun: true`, so
World Info's sticky/cooldown/delay timers are never advanced by the pipeline itself — only
by the real reply generation that follows.

Revise is a separate code path entirely — it doesn't hook `GENERATION_AFTER_COMMANDS` at
all, since it isn't part of generating a reply. It only runs when its button is clicked, once,
against whichever message it was clicked on.

## Data

Everything lives in `extension_settings['directors-framework']`. Each preset:

```js
{
  id, name,
  injectMode: 'before-reasoning' | 'replace-reasoning' | 'prompt-only',
  injectRole: 'system' | 'user' | 'assistant',
  injectDepth: 0,
  injectTemplate: '<director_notes>\n{{output}}\n</director_notes>',
  historyDepth: 10,
  includeCard: true,
  includePersona: true,
  includeWorldInfo: true,
  showInChat: false,     // also prepend the combined output to the visible reply text
  stageDelaySeconds: 0,  // wait this long before each stage after the first (rate-limit mitigation)
  includeMemory: false,  // fold short-term memory into stage context (also needs Memory > Enable)
  stages: [{
    id, name, enabled: true,
    profileId: '',        // '' = use the currently selected Connection Profile
    prompt: '', role: 'user', maxTokens: 512,
    dependsOn: [],         // ids of earlier stages whose output to include
    includeHistory: true, historyDepth: null,   // null = use the preset's value
    includeWorldInfo: null,                      // null = use the preset's value
    includeMemory: null,                         // null = use the preset's value
    includeInFinal: true,  // fold this stage's output into the injection
    tools: { enabled: false, names: [], mode: 'auto' },
  }],
}
```

Memory itself is a separate top-level setting, not part of any preset — recording happens on
every reply regardless of which preset (if any) ran for that message:

```js
memory: {
  enabled: false,   // short-term recording, gates the whole memory feature
  topK: 3,          // short-term results to recall
  medium: {
    enabled: false,        // needs memory.enabled too - medium is short-term's overflow tier
    everyNReplies: 10,      // summarize the last N messages after every Nth reply
    topK: 3,                // medium-term results to recall
    summaryProfileId: '',   // '' = use the currently selected Connection Profile
    summaryPrompt: '...',   // must contain {{chunk}}
  },
  long: {
    enabled: false,   // recall only - pinning itself always works regardless of this
    topK: 3,          // long-term (pinned) results to recall
  },
}
```

Pins themselves aren't stored here — they're chat-scoped (see "Memory internals" below), same
place as the medium-term reply counter.

Revise is also top-level, not per-preset — the button appears on every AI message regardless
of which preset (if any) produced it:

```js
revise: {
  enabled: true,
  showButton: true,
  profileId: '',        // '' = use the currently selected Connection Profile
  maxTokens: 1800,       // must be large enough for a full reply - the stage default (512) cuts it off
  templates: [{ id, name, prompt }],  // must contain {{draft}}; {{instruction}} is optional
  defaultTemplateId: '', // pre-selected template in the revise popup
  includeHistory: true, historyDepth: 10,
  includeCard: true,
  includePersona: true,
  includeWorldInfo: false, // off by default - revise is mostly a language pass
  includeMemory: false,
}
```

### Memory internals

Short-term memory stores each reply as a vector item in a per-chat collection
(`directors_framework_short_<chatId>`) via `/api/vector/insert`, and pulls the `topK` most
relevant ones back via `/api/vector/query` — the exact same server endpoints the built-in
**Vectors** extension uses, called directly, so this works with or without that extension
enabled. It's hardcoded to the `transformers` embedding source (free, runs in the SillyTavern
server process, no API key, downloads its model once on first use) rather than following
whatever the Vectors extension is configured to, so it works out of the box for everyone.

Medium-term memory (`src/summarize.js`) tracks a per-chat reply counter in SillyTavern's chat
metadata (not `extension_settings`, since it needs to travel with the chat, not the user). Once
the counter reaches `everyNReplies`, it sends the last N chat messages to the configured
Connection Profile with `summaryPrompt`, stores the result as one item in a separate
`directors_framework_medium_<chatId>` collection, and deletes those same N messages from the
short-term collection by content hash (`/api/vector/delete`) — so that window of conversation
ends up compressed in medium-term instead of sitting verbatim in short-term *and* summarized in
medium-term at once. If summarization fails for any reason (no profile configured, request
error, empty response), the counter is deliberately **not** reset, so the very next reply
retries instead of silently losing that window forever.

Long-term memory (`src/pins.js`) is manually curated - never auto-written, never
auto-deleted. Pin a stage's output from the Last run log, or type a fact directly into the
Memory section, and it's stored in a `directors_framework_long_<chatId>` collection. The
vector API alone can't answer "what's pinned right now" (`/api/vector/list` only returns
hashes, not text, and `/query` needs a search string), so pins are *also* tracked as a small
local index in the same chat-metadata bag the reply counter lives in (`memory.js`'s
`getChatMeta`) - purely so the settings UI can list and remove individual pins. Removing one
deletes it from both places by content hash, same mechanism medium-term uses to clean up
short-term.

Both the World Info scan and the memory query (all three tiers, in parallel) happen once per
pipeline run (not once per stage), fed into every stage that wants them via `src/context.js`'s
`buildStageMessages`, in this order: `<memory_pinned>` (long-term, permanent/curated) →
`<memory_summary>` (medium-term, older/general background) → `<memory_recent>` (short-term,
specific/immediate) - general and permanent context before specific and recent detail, same
ordering principle as World Info's before/depth/after.

This is still an early pass: three tiers now, but no automatic promotion from medium-term into
long-term (pinning is manual only, deliberately - see the project's memory notes for why), and
no decay/pruning policy beyond the manual "Forget this chat's ... memory" buttons and what
summarization itself removes.

### Revise internals

The revise button (`src/mesbuttons.js`) lives in `.extraMesButtons` — the same slot the
built-in Translate/Narrate buttons occupy — via a **delegated** click handler bound once on
`document`, not per-button listeners, since SillyTavern re-renders message DOM constantly
(swipe, edit, scroll-load) and per-button listeners would silently stop firing. Clicking it
opens a popup built from a plain `<select>` + `<textarea>` (not `Popup.show.input()`, which
can only return a single string) listing every template plus a free-text instruction box.

`src/revise.js` does the actual work (`runRevise`), reusing the pipeline's own building
blocks — `withRateLimitRetry`/`describeError` from `runner.js`, `safeCardFields`/
`scanWorldInfo`/`scanMemory` from `context.js` — since `settings().revise` is shaped to match
what those already expect from a preset-like object. Unlike the pipeline, it edits the message
directly: `message.mes` is overwritten, `SillyTavern`'s own `syncMesToSwipe()` copies the
change into the current swipe slot (skip this and swiping away and back would silently lose
the edit), then `updateMessageBlock()` re-renders it (this also refreshes the reasoning block,
so nothing else needs to touch `extra.reasoning`).

The very first pre-revise text is kept in `message.extra.df_revise_original` - set once and
never overwritten, so revising the same message a second or third time still lets undo
(`undoRevise`) reach the model's true original reply, not an intermediate revised draft.
Blocked from running while the automatic pipeline is mid-flight (`runner.isRunning()`) or
another revise is already in progress, so the two never write to the same message at once.

History sent to the model is scoped to messages **before** the one being revised
(`getRecentHistory`'s optional `beforeIndex` parameter) — the revise button can sit on any
past message, not just the latest one, and showing the model chat lines that come after the
message it's revising would be actively confusing.

Exports are `{ version: 1, presets: [...] }`. Importing always re-issues every id (both
preset and stage), so importing a file you previously exported — or someone else's export —
can never collide with what's already stored, and `dependsOn` references are remapped to
the new ids.

## Troubleshooting

Open the browser console (F12) and look for lines prefixed with `[directors-framework]`.

| Symptom | Likely cause |
| --- | --- |
| Nothing happens on send | Extension not enabled, active preset has no enabled stages, or the generation type (regenerate/swipe/continue) isn't ticked under "Run before". |
| A stage's output is empty | Check the profile assigned to it is valid (Last run log shows the exact prompt/response); a stage with tools enabled on a Text Completion profile silently runs without tools. |
| Reasoning didn't change | Preset is set to "Prompt only" — the output still reaches the prompt, just not the reasoning block. Some models/providers don't return a reasoning block at all; turn on "show in chat" to guarantee visibility regardless. |
| A stage keeps failing with a rate-limit message | It already retries twice automatically; if it still fails, set "Delay between stages" on the preset, or spread stages across different API keys/providers. |
| Swiping away and back loses the reasoning | Shouldn't happen — the extension rewrites `swipe_info` at the same time as `extra.reasoning`. If you see this, please report it with the console log. |
| Tool calls never fire | Tool calls require a Chat Completion connection profile; Text Completion profiles don't support them. |
| Memory never recalls anything | Check Memory > Enable is on (both the global setting *and* the preset/stage's own memory toggle), and that there's actually something stored yet - a fresh chat has nothing to recall. |
| Medium-term summaries never appear | Needs `memory.enabled` **and** `memory.medium.enabled` both on, plus a valid Summarizer Connection Profile. Console logs "Medium-term summarization failed, will retry next reply" on any failure - the counter isn't reset, so it keeps retrying every reply until fixed. |
| Pinned facts never recall | `memory.long.enabled` needs to be on for *recall* (pinning itself always works regardless). Check the pin actually exists in the Memory section's pin list - it's per-chat, so switching chats shows a different list. |
| No revise button on messages | Check `revise.enabled` and `revise.showButton` are both on in the Revise section. It only appears on AI messages, never on your own. |
| Revise says no Connection Profile | Set one in the Revise section's "Connection Profile" dropdown, or select one in the Connection Manager - `revise.profileId` falls back to whatever's currently selected there, same as a stage with no profile of its own. |
| Revise cut off mid-sentence | `revise.maxTokens` is too low for a full reply - raise it (default 1800; the same trap as a stage left at its 512 default). |
| Revise silently does nothing | It's blocked while the automatic pipeline is running, or another revise is already in progress - wait for the current one to finish and try again. |
| Undo doesn't restore the real original after several revises | Shouldn't happen - `extra.df_revise_original` is only ever set once, on the first revise. If you see this, please report it with the console log. |
