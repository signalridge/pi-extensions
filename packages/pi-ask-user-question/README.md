# @signalridge/pi-ask-user-question

A stable Pi extension that registers a structured `ask_user_question` tool. It lets an LLM pause for focused user decisions and receives a bounded, structured JSON answer.

## Install

```bash
pi install npm:@signalridge/pi-ask-user-question
```

The package is opt-in. Its Pi manifest loads `src/index.ts`, which registers the tool when the package is enabled.

## Tool contract

The tool accepts one to four questions. Every question has a prompt and two to four options. `id`, `header`, `value`, `description`, `multiSelect`, and `allowOther` are optional; `multiSelect` defaults to `false` and `allowOther` defaults to `true`.

```json
{
  "questions": [
    {
      "id": "storage",
      "header": "Storage",
      "question": "Which storage should the feature use?",
      "options": [
        { "label": "SQLite", "value": "sqlite", "description": "Local and transactional." },
        { "label": "JSON", "value": "json", "description": "Simple and portable." }
      ],
      "allowOther": true
    }
  ]
}
```

Results have the same JSON payload in `content[0].text` and typed `details`. Successful answers contain ordered `answers` with the question identity plus selected option label/value/index or free text. Cancellations contain `cancelled`, a reason, and any answers collected before cancellation.

## Interaction

In TUI mode the tool opens a centered overlay with a visible top and bottom Pi border and a consistent side frame. Its outer border uses the theme's `borderAccent` color (purple in the Signalridge themes). It presents one question at a time, shows `[n/total]` progress for batches, displays option descriptions, supports single select, checkbox-like multi-select with an explicit Done row, Other free text, Back to revise an earlier answer, and Escape cancellation. Free-text editor input remains inside the same border and forwards focus to Pi's `Editor` for correct cursor and IME placement.

RPC mode uses Pi's sequential `select` and `editor` requests instead of `custom`, including multi-select and Back where the RPC UI supports repeated selections. Print mode and contexts without UI return a structured cancellation without opening a dialog.

The tool is registered with `executionMode: "sequential"`, so two question dialogs cannot overlap.

## Development

```bash
bun run check
```
