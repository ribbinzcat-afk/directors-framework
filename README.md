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
  character card / persona, and World Info / lorebook — each toggleable.
- **Tool calls per stage**: a stage can be allowed to call SillyTavern-registered tools
  (Chat Completion profiles only), in `auto` or `required` mode, restricted to a chosen
  subset of tools.
- **Injection**: the combined output of every stage marked "include in final" is inserted
  into the outgoing prompt at the latest message position, and — unless the preset is set
  to "prompt only" — written into the reply's reasoning block, either replacing the model's
  own reasoning or placed before it.
- **Presets**: a full stage pipeline is a preset. New / rename / duplicate / delete /
  export / import (JSON).
- **Status bar**: a small bar above the chat input shows which stage is currently running,
  with a cancel button.
- **Last run log**: a collapsible drawer showing, per stage, the exact prompt sent, the
  output, the profile used, and how long it took.

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

## How it fits into generation

The pipeline runs during SillyTavern's `GENERATION_AFTER_COMMANDS` event — after slash
commands are processed, before the outgoing prompt is built. Each stage is sent with
`ConnectionManagerRequestService.sendRequest()` directly (not through `Generate()`), so the
pipeline can never recurse into itself. If the pipeline errors or is disabled, the real
generation proceeds exactly as if the extension weren't installed.

World Info is scanned **once per run** (not once per stage) with `isDryRun: true`, so
World Info's sticky/cooldown/delay timers are never advanced by the pipeline itself — only
by the real reply generation that follows.

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
  stages: [{
    id, name, enabled: true,
    profileId: '',        // '' = use the currently selected Connection Profile
    prompt: '', role: 'user', maxTokens: 512,
    dependsOn: [],         // ids of earlier stages whose output to include
    includeHistory: true, historyDepth: null,   // null = use the preset's value
    includeWorldInfo: null,                      // null = use the preset's value
    includeInFinal: true,  // fold this stage's output into the injection
    tools: { enabled: false, names: [], mode: 'auto' },
  }],
}
```

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
| Reasoning didn't change | Preset is set to "Prompt only" — the output still reaches the prompt, just not the reasoning block. |
| Swiping away and back loses the reasoning | Shouldn't happen — the extension rewrites `swipe_info` at the same time as `extra.reasoning`. If you see this, please report it with the console log. |
| Tool calls never fire | Tool calls require a Chat Completion connection profile; Text Completion profiles don't support them. |
