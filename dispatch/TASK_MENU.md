# Task menus: a project's own task modules

Mission Control's **New task** dialog lists task modules. You pick one, answer two or three questions, and
the page writes a complete issue in the shape the agents expect (`Problem`, `Acceptance criteria`, `Files`,
`Out of scope`, `How to check`, `Owner decisions needed: none`) with the `ready` and size labels already set.
Tasks that arrive in the same shape come back in the same shape, and sized tasks skip the administrator's
sizing pass.

Every task says exactly how to check it: a numbered list of steps, each naming a command or a page and the
result that counts as done, followed by "Put each command and the last lines of its output in the PR under
Verification:". The commands come from the project's `checks` block, so even the general modules name the
project's real test command.

Every project gets the general modules (fix a bug, small change, new feature, make it faster, add tests,
write docs, fix review findings, visual polish, big goal, something else). A project adds its own by
committing `.github/task-menu.json` to its default branch. The file stays in that repo, so a private
project's menu stays private. Mission Control reads it with your token (Contents: Read).

## The file

```json
{
  "version": 1,
  "checks": {
    "test": "npm test",
    "pass": "the last line reads '0 failing' and the exit code is 0",
    "open": "npm run dev, then http://localhost:5173"
  },
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
        "{TEST} passes: {PASS}"
      ],
      "files": "content/questions.json",
      "outOfScope": "Other topics; the quiz screens",
      "check": [
        "python3 tools/count.py --topic '{topic}' prints {count} more than on the default branch",
        "{OPEN}, filter by {topic}: the new questions show with their explanations",
        "Run {TEST}: {PASS}"
      ]
    }
  ]
}
```

| Key | Meaning |
|---|---|
| `checks.test` | the full test command, exactly as it is typed |
| `checks.pass` | what a passing run looks like: its last line, a count, the exit code |
| `checks.open` | how to start or open the app to look at a page |
| `id` | `a-z`, `0-9` and `-`, unique in the file |
| `name` | the button text, at most 48 characters |
| `hint` | one short line under the name (optional) |
| `size` | `S`, `M` or `L`: the default size (you can change it in the dialog). S and M go to a Sonnet agent, L to an Opus agent |
| `route` | `build` (default), `plan` (the administrator splits it into tasks), `ui` (Antigravity checks it in a browser) or `codex` |
| `fields` | at most 6 questions. `type` is `text` (default), `long` (several lines), `number` or `select` (with `options`). `required: true` makes an answer compulsory; `default` and `placeholder` are optional. No field may be called `TEST`, `PASS` or `OPEN` |
| `title` | the issue title |
| `problem`, `files`, `outOfScope` | one line each |
| `criteria` | the acceptance criteria, one per entry |
| `check` | the "How to check" steps, one per entry (a single string also works) |

## Templates

- `{topic}` is replaced by the answer to the field with the id `topic`.
- `{TEST}`, `{PASS}` and `{OPEN}` are replaced by the `checks` values (`{TEST}` is shown as code).
- `[[ … ]]` is kept only when every field named inside it was answered: `"Fix it[[ in {where}]]"`.
- A criterion or check step that names an unanswered field is left out. An answer with several lines becomes one criterion per line.
- Every answered field is also listed under "Details from the owner", so nothing typed is lost.

## Writing a good menu

- 4 to 8 modules for the tasks this project gets most often. Look at the last 30 closed issues and pull requests.
- Ask only what the owner has to decide (which topic, which page, how many). Put everything an agent can find
  out for itself, such as file paths and commands, into `criteria`, `files` and `check`.
- Each check step names a command or a page and the result that counts as done: "`npm test`: 0 failing",
  "the count goes up by {count}", "page X shows Y at 390 px". Never a bare "run the tests".
- Keep it valid JSON: `python3 -m json.tool .github/task-menu.json`.

When a repo has no menu, the dialog offers **Ask an agent to write them**, which opens a `ready` task for this
file; when a menu has no `checks` block, **Ask an agent to add them** asks for just that. You merge the agent's
pull request like any other.
