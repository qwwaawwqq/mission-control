# Task menus: a project's own task modules

Mission Control's **New task** dialog lists task modules. You pick one, answer two or three questions, and
the page writes a complete issue in the shape the agents expect (`Problem`, `Acceptance criteria`, `Files`,
`Out of scope`, `How to check`, `Owner decisions needed: none`) with the `ready` and size labels already set.
Tasks that arrive in the same shape come back in the same shape, and sized tasks skip the administrator's
sizing pass.

Every project gets the general modules (fix a bug, small change, new feature, make it faster, add tests,
write docs, fix review findings, visual polish, big goal, something else). A project adds its own by
committing `.github/task-menu.json` to its default branch. The file stays in that repo, so a private
project's menu stays private. Mission Control reads it with your token (Contents: Read).

## The file

```json
{
  "version": 1,
  "modules": [
    {
      "id": "add-questions",
      "name": "Add quiz questions",
      "hint": "New questions for one topic",
      "size": "M",
      "route": "build",
      "fields": [
        { "id": "topic", "label": "Topic", "type": "select", "options": ["Topic A", "Topic B"], "required": true },
        { "id": "count", "label": "How many", "type": "number", "default": "20" },
        { "id": "notes", "label": "Anything else", "type": "long" }
      ],
      "title": "Add {count} questions on {topic}",
      "problem": "The question bank needs more {topic} questions[[ ({notes})]].",
      "criteria": [
        "{count} new {topic} questions in content/questions.json",
        "Each has an explanation and a source",
        "The tests pass: npm test"
      ],
      "files": "content/questions.json",
      "outOfScope": "Other topics; the quiz screens",
      "check": "npm test; open the site, filter by {topic} and count the new questions"
    }
  ]
}
```

| Key | Meaning |
|---|---|
| `id` | `a-z`, `0-9` and `-`, unique in the file |
| `name` | the button text, at most 48 characters |
| `hint` | one short line under the name (optional) |
| `size` | `S`, `M` or `L`: the default size (you can change it in the dialog). S and M go to a Sonnet agent, L to an Opus agent |
| `route` | `build` (default), `plan` (the administrator splits it into tasks), `ui` (Antigravity checks it in a browser) or `codex` |
| `fields` | at most 6 questions. `type` is `text` (default), `long` (several lines), `number` or `select` (with `options`). `required: true` makes an answer compulsory; `default` and `placeholder` are optional |
| `title` | the issue title |
| `problem`, `files`, `outOfScope`, `check` | one line each; `check` becomes "How to check" |
| `criteria` | the acceptance criteria, one per entry |

## Templates

- `{topic}` is replaced by the answer to the field with the id `topic`.
- `[[ … ]]` is kept only when every field named inside it was answered: `"Fix it[[ in {where}]]"`.
- A criterion that names an unanswered field is left out. An answer with several lines becomes one criterion per line.
- Every answered field is also listed under "Details from the owner", so nothing typed is lost.

## Writing a good menu

- 4 to 8 modules for the tasks this project gets most often. Look at the last 30 closed issues and pull requests.
- Ask only what the owner has to decide (which topic, which page, how many). Put everything an agent can find
  out for itself, such as file paths and the test command, into `criteria`, `files` and `check`.
- Each criterion must be checkable, and `check` must say how: a command, a page to open, a number to compare.
- Keep it valid JSON: `python3 -m json.tool .github/task-menu.json`.

When a repo has no menu, the dialog offers **Ask an agent to write them**, which opens a `ready` task for this
file. You merge the agent's pull request like any other.
