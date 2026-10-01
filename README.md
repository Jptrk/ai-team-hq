# AI Team HQ

A self-hosted dashboard for running teams of AI "employees", one team per project. Each
project has an inbox of decisions that need you, a team list, a kanban board with Jira-style
ticket keys, and a pixel office where each agent sits at a desk. Link a project to a folder
on disk and its team can read that codebase.

Two modes:

| Mode | What runs | Needs |
| ---- | --------- | ----- |
| **sim** (default) | Fake activity on a timer. Good for looking at the UI. | nothing |
| **live** | Each desk is a real Claude agent (Claude Agent SDK) with its own workspace folder. | an API key or a Claude Code login |

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5174. The API runs on http://127.0.0.1:4747.

Production build, served from one port:

```bash
npm run build
npm start
```

Then open http://127.0.0.1:4747.

## Layout

Jira-inspired, not a copy. An olive top bar holds search, **+ Create**, the Sim/Live pill, the
theme toggle and your menu. A left sidebar holds the project switcher and the views:

| View | What it is |
| ---- | ---------- |
| Needs you | An inbox of decisions, holds and paused chat threads, with Approve / Hold / Send back / Instruct on each row |
| Chat | Thread list and the open thread side by side (one pane under 900px) |
| Board | Four columns with drag-and-drop, filters by text, assignee and "Needs me" |
| Team | A card per desk; "Add teammate" is the dashed card |
| Office | The pixel office |

Tickets and people open in a **side panel** on the right, over whatever view you are on. The URL
carries it (`#/p/gecom-apps/board?ticket=GA-12`), so reload, Back and shared links land on the
same ticket. Esc closes it.

Every view has its own URL: `#/p/<project>`, `#/p/<project>/chat`, `/board`, `/team`, `/office`,
`/chat/<threadId>`, `/settings`, `/connections`, plus `#/projects`.

Keyboard shortcuts (ignored while you type):

| Key | Does |
| --- | ---- |
| `c` | Create an instruction or a chat thread |
| `/` | Search tickets in this project; Enter opens the top hit |
| `[` | Collapse or expand the sidebar |
| `Esc` | Close the top layer only: menu, then dialog, then side panel |
| `Ctrl+Enter` | Send in any text box |

On the board, the ‹ › buttons on each card move it one column; they always show on touch screens,
where drag-and-drop is unreliable.

Screen sizes: full sidebar from 1100px, an icon rail from 720px (expand it for an overlay), and
an off-canvas sidebar with a full-screen side panel on phones.

## Dark mode

Follows your system setting until you pick one. Toggle it with the moon/sun button in the top
bar, or choose Light, Dark or Match system in your menu. The choice is saved in the browser
(`localStorage` key `hq.theme`), and `index.html` applies it before the first paint, so there is
no light flash.

Light keeps the original olive, cream, rust and green. Dark is a night version of the same
palette: olive-black surfaces, cream text, and a softer rust. Every text color is 4.5:1 or better
on its background in both themes. Colors live in `src/styles/tokens.css`; nothing else in the app
hardcodes a color.

## Reports and markdown

Agent reports, ticket descriptions and chat messages render as formatted markdown: headings,
tables, lists, task lists, code and links. A report attached to a ticket opens in the ticket's
side panel with:

- **Preview / Raw** to switch between the formatted page and the plain markdown. The choice is remembered.
- **Copy** to copy the markdown.
- **Open raw** to open the file in a new tab.
- **Expand** to read it in a wide reader.

Links in a report behave safely:

- `#section` links scroll inside the report.
- Web links open in a new tab.
- A link to another `.md` report opens it in the viewer, with a Back link.

Reports are written by agents, so raw HTML shows as plain text and images are not loaded. An
image shows as a link with its alt text instead.

## Writing: the rich text box

Every box you write in formats as you type, like Jira. That covers chat, Create, comments, the
Instruct and Send back notes, and ticket descriptions.

| Type | Becomes |
| ---- | ------- |
| `**bold**`, `_italic_`, `~~strike~~`, `` `code` `` | the formatting itself |
| `# `, `## `, `### ` at the start of a line | a heading |
| `- ` or `1. ` | a bulleted or numbered list |
| `> ` | a quote |
| three backticks | a code block |

- **Shortcuts:** Ctrl+B, Ctrl+I and Ctrl+E (code) work, Ctrl+K adds a link (https or mailto only), and Ctrl+Enter sends. Create, comments and descriptions also have a button bar.
- **Pasting markdown:** a table, list or heading pasted from somewhere else turns into the real thing. Plain sentences stay plain.
- **Markdown underneath:** what gets saved and sent to desks is still plain markdown, so nothing else changes.
- **Loading:** the editor loads in the background after HQ opens, in its own file. Until it arrives, a plain text box works the same way.

**Editing a description.** A ticket's description can be edited only while the ticket is in **To do**.
From In progress on it is locked: the Edit button goes away and the server refuses changes, so a
desk never has the ground shift under it. If work starts while you are editing, the editor closes
and nothing is saved. Add a comment instead. Tickets you make with Create start In progress right
away, so their description stays as you first wrote it.

Ticket and thread titles are plain text, so formatting is stripped from them.

## Images and comments

Paste an image (Ctrl+V), drop it, or use the image button in any text box. That covers chat
messages, Create, the Instruct and Send back notes, and ticket comments. On a ticket, **Attach
images** beside Description adds images to the description itself.

- **Before you send,** images show as thumbnails under the text. The X removes one. Up to 6 go
  with each message, comment or note.
- **After sending,** they show under the message, comment or description. Click one to open it
  full size; the arrow keys move between images.
- **Big images are scaled down** in the browser to 1568px on the long side, the size Claude
  recommends. Screenshots stay PNG so text stays sharp.
- **Desks see your images directly.** They go into the desk's prompt with your text, up to 6 per
  run. Each image costs roughly 1,000 to 1,600 tokens of your subscription in the run that
  includes it. Older images are listed by file path, and a desk can open them with Read.

**Comments.** Every ticket has a **Comments | History** switch.

- Your comment wakes the desk that owns the ticket, and it answers with a comment. Answering
  never closes the ticket.
- Desks use `comment_on_ticket` to tell you something about a ticket. They no longer rewrite
  the description, which stays exactly as you wrote it.
- When a desk asks you to decide, that ask is a comment too. It shows in the ticket's callout and
  in Needs you.
- Your Instruct and Send back notes are kept as comments, with their images.

**Safety.** Only PNG, JPEG, WebP and GIF are accepted, checked from the file's bytes, not its name.
SVG is refused because it can carry script. Each image is at most 3.75 MB. Files are served with
`nosniff` and a strict content policy, and only HQ's own image URLs are ever shown as images.
Desks can read the attachments folder but never write to it. At startup, images nothing points at
any more are deleted once they are a day old.

## Projects

Switch projects from the picker at the top of the sidebar, like Jira. It lists every project with its
key, team, linked folder, and a badge for anything waiting on you. "View all projects" and
"Create project" live at the bottom of the same menu.

Creating a project:

- **Project folder** (optional). Paste a path. The quotes from Windows "Copy as path" are fine.
  The form checks it live: git repo, and whether a `CLAUDE.md` or `AGENTS.md` sits at the root.
  That file goes into every agent's prompt for the project.
- **Name** and **Key** fill in from the folder. The key prefixes ticket numbers: `GA-1`, `GA-2`.
- **Team**: Dev team (Tech Lead, Frontend, Backend, QA, DevOps, Code Reviewer, Docs), Business
  team (COO, EA, Pipeline, Prospecting, Inbound, Automation, Design, HR), or Blank.
- **Access**: Read only (default) or Read & write. Read only means agents read the code and put
  plans and diffs in reports. Read & write lets them edit files, but never `.git`, `node_modules`,
  `.env*` or key files. There is no shell either way: no builds, tests, git, or commits.

Teams are editable on the Team tab: add a teammate with routing keywords, open one to make them
lead or remove them. A removed desk's open tickets go to the lead. The founder (you) is the same
person in every project; renaming yourself in one renames you everywhere.

Routing an instruction: `@Name` sends it straight to that desk. Otherwise the desk whose keywords
match best gets it, and the lead catches anything nobody matches.

Project settings (from the picker) edit name, key, folder, and access, or remove the project.
Removing moves its board and agent workspaces to `data/archive/`. The linked folder is never
touched.

## Connections (MCP servers per project)

Project settings has a **Connections** section. Each project gets its own list:

| Source | Where it comes from |
| ------ | ------------------- |
| your settings for this folder | `~/.claude.json`, `projects[<folder>].mcpServers` |
| repo's .mcp.json | `<folder>/.mcp.json` |
| your user settings | `~/.claude.json`, `mcpServers` |
| claude.ai | connectors on your Claude account, found by a check |

If a name appears in more than one place, the folder entry wins, then the repo, then the user
settings. That's the same order Claude Code uses.

- **Check connections** connects to every server and lists its tools. It sends no prompt and
  calls no tool. The status is one of: connected, needs login, or failed.
- **Turn a server on** and pick which desks may use it. Every desk is picked by default the
  first time.
- **Mode**: *Ask before changes* (default) lets agents read freely. A tool that posts or
  changes something is refused until you approve the ticket in Needs you, and only the run
  after your approval may use it. *Read only* never allows changes.
- A tool counts as a read when its name reads (`get_`, `list_`, `search_`, `..._read`) and nothing
  in the name sounds like a write. The server's own read-only hint counts, but never over a
  write-sounding name. Unknown tools count as changes.
- Everything posts **as you**, under your own GitHub, Atlassian, or other account. There are
  no bot accounts. On your own PRs, GitHub won't let the author approve or request changes, so
  agents can only leave comments there.
- Tokens are never stored in HQ. Only your choices are saved: which servers, which desks, and
  which mode. Each run reads the config fresh from Claude Code's own files.
- A run loads only HQ's tools plus the servers turned on for that desk (`strictMcpConfig`).
  Other claude.ai connectors stay out, which also keeps prompts smaller.

To log in to a server that needs it, open Claude Code in the project folder and run `/mcp`.
For a claude.ai connector, connect it in claude.ai under Settings, Connectors. Then check again.

## Chat (desks talking to each other)

The **Chat** tab shows threads between desks, and you. Messages do real work: each message to
a desk wakes it for a live run, which spends usage.

- **Desks message each other** with two HQ tools:
  - `send_message(to, text)` reaches up to 3 teammates, or "founder" to answer you.
  - `hand_off(to, title, brief)` gives a teammate a ticket of their own. The sender is told
    automatically when that ticket is done.
- **Threads.** A ticket gets one thread, created the first time someone discusses it.
  Threads you start from the Chat tab stand alone.
- **You can post in any thread.** `@Name` pulls a desk in. With no mention, your message goes
  to the last desk that spoke. In a new thread, the router picks a desk. Your messages never
  count toward the limit.
- **The loop limit.** Each desk that another desk wakes counts one hop. After 6 hops the
  thread pauses and holds further messages, and it shows up in Needs you and on the Chat tab.
  Reply in the thread, or press **Resume** to deliver what was held. There is also a cap of 30
  desk-to-desk wakes per project per day.
- **Messages are async.** A desk posts and stops, and the reply wakes it later. Unread
  messages for a desk batch into one run. Nothing waits in a slot, so the queue can't deadlock.
- **Ownership.** A desk woken by a message can't finish someone else's ticket, and
  `raise_for_decision` opens a new ticket rather than taking over theirs. A ticket run that
  asked a teammate stays in progress until the reply.
- **Trust.** Teammate messages are treated as colleague requests. They can't approve anything,
  and MCP writes still need a run that follows your approval.
- **Message runs are cheap by design.** They're capped at 12 turns and $1 estimated. A small
  ask-and-answer came to about $0.05 to $0.08 per run.

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_CHAT_HOP_LIMIT` | 6 | Desk-to-desk wakes per thread before it pauses |
| `HQ_CHAT_DAILY_RUNS` | 30 | Desk-to-desk wakes per project per day |
| `HQ_MSG_MAX_TURNS` | 12 | Turn cap for a message run |
| `HQ_MSG_MAX_BUDGET_USD` | 1 | Estimated-cost cap for a message run |

In sim mode, desks answer with canned replies, so the tab works without spending usage.

## Go live

1. `copy .env.example .env`. It already says `HQ_RUNNER=claude`.
2. Credentials, one of:
   - **API key** (pay per token): paste it into `ANTHROPIC_API_KEY=`.
   - **Claude subscription**: leave the key empty. The SDK uses the Claude Code login on this
     machine (`~/.claude/.credentials.json`). Spends your plan's usage window. Anthropic's SDK
     docs say third-party products may not ship on claude.ai login; personal use on your own
     machine is your call. Do not distribute the app set up this way.
3. Restart `npm run dev`. The header pill turns green: `LIVE · claude-opus-5`, and the hint
   under the panel says which credential is in use.

On a subscription, Opus burns the usage window fastest. `HQ_MODEL=claude-sonnet-5` stretches it.

What happens on an instruction:

1. The router in `server/agents.ts` picks the desk.
2. `server/runner/index.ts` queues a run. One run per desk at a time, `HQ_CONCURRENCY` desks in
   parallel across all projects.
3. `server/runner/claude.ts` starts an Agent SDK `query()`:
   - `cwd` = `workspaces/<project>/<agent>/`, created on first run with `ROLE.md`, `memory.md`, `reports/`.
   - The linked folder is passed as `additionalDirectories`.
   - Tools: Read / Write / Edit / Glob / Grep, fenced by a `canUseTool` guard (see
     `server/guard.test.ts`). No Bash, no subagents. `HQ_WEB=1` adds WebSearch and WebFetch.
   - Three HQ tools (in-process MCP server): `post_update`, `raise_for_decision`, `report_done`.
     They write straight into the project's board, so the UI updates as the agent works.
     Report files written during the run are linked on the ticket automatically.
   - Session id is saved per desk and resumed next run, so a desk remembers earlier tasks.
   - Caps: `HQ_MAX_BUDGET_USD` per run, `HQ_MAX_TURNS`, `HQ_RUN_TIMEOUT_MS`.
4. The agent either finishes (`report_done`) or hands you a decision (`raise_for_decision`).
5. Approve / Send back / Instruct each start a follow-up run with your note. Hold does nothing.

Nothing leaves the building. Agents cannot email, post, or call external systems. They draft,
save to `reports/`, and ask.

Edit `workspaces/<project>/<agent>/ROLE.md` to change how a desk behaves. It is read on every run.

## Env

See `.env.example`. `HQ_RUNNER=sim` forces sim mode even with a key.

Code work reads a lot of files, so it costs more per run than email drafting. A read of a
monorepo landed near $2.50 on the SDK's estimate. If code tasks hit "Reached maximum budget",
raise `HQ_MAX_BUDGET_USD`. On a subscription the figure is an estimate, not a charge.

## Data

| Path | What |
| ---- | ---- |
| `data/projects.json` | Registry: the founder's name and every project |
| `data/projects/<id>/db.json` | One project's team, tickets, runs, and activity |
| `data/projects/<id>/attachments/` | Images you pasted, named by the server |
| `workspaces/<id>/<agent>/` | One desk's `ROLE.md`, `memory.md`, `reports/` |
| `data/archive/` | Removed projects |
| `data/backup/` | The single-project `db.json` from before projects existed |

The first boot after upgrading moves the old `data/db.json` and `workspaces/<agent>/` into a
project with key `HQ`. Old sessions are dropped because their folders moved; `memory.md` carries over.

## Tests

```bash
npm run test:guard
npm run test:chat
npm run test:ui
npm run test:attachments
```

- **`test:guard`** checks what an agent may read and write in its workspace and the linked folder. It also checks which MCP tools run freely, need approval, or are refused.
- **`test:chat`** checks the chat core: recipients, the loop limit, resume and settle.
- **`test:ui`** checks the UI helpers: routes, board filter, search ranking, report link resolution, markdown previews, image sizing, and avatar text contrast.
- **`test:attachments`** checks image uploads: type sniffing, file names, picking ids, the startup sweep, and the image blocks sent to desks.

To try the UI against a copy of your data, run the API from another folder and point Vite at it.
The API reads `data/` and `workspaces/` from its working directory.

```bash
HQ_RUNNER=sim PORT=4757 node <repo>/node_modules/tsx/dist/cli.mjs <repo>/server/index.ts
HQ_API_URL=http://127.0.0.1:4757 npx vite --port 5175
```

## Notes

- `npm run dev` restarts the API with `node --watch --import tsx`, not `tsx watch`. Importing
  `@anthropic-ai/claude-agent-sdk` inside a `tsx watch` child hangs before the first line runs
  (tsx 4.20 / SDK 0.3.282 on Windows). Plain `tsx` and `node --watch` are fine.
- Delete `workspaces/<project>/<agent>/` to give a desk a fresh start. A stale session id just
  falls back to a new session.

## API

Everything project-specific lives under `/api/projects/:pid`.

| Method | Path | Body / query |
| ------ | ---- | ------------ |
| GET    | /api/meta | |
| GET    | /api/fs/check | `?path=<folder>&except=<pid>` |
| GET    | /api/projects | |
| POST   | /api/projects | `{ name, key?, path?, access?, template? }` |
| GET    | /api/projects/:pid | |
| PATCH  | /api/projects/:pid | `{ name?, key?, path?, access? }` |
| DELETE | /api/projects/:pid | archives it |
| GET    | /api/projects/:pid/state | |
| POST   | /api/projects/:pid/instructions | `{ text, attachments? }` |
| POST   | /api/projects/:pid/items/:id/decision | `{ decision, note?, attachments? }` |
| POST   | /api/projects/:pid/items/:id/comments | `{ text, attachments? }`; wakes the owner |
| POST   | /api/projects/:pid/items/:id/attachments | `{ attachments }`; adds to the description |
| POST   | /api/projects/:pid/attachments | raw image body; returns the attachment |
| GET    | /api/projects/:pid/attachments/:file | the image |
| PATCH  | /api/projects/:pid/items/:id | `{ status?, summary? }`; summary only while To do |
| POST   | /api/projects/:pid/items/:id/run | live only |
| POST   | /api/projects/:pid/runs/:id/cancel | |
| GET    | /api/projects/:pid/agents/:id | |
| POST   | /api/projects/:pid/agents | `{ name, role, skills?, lead? }` |
| PATCH  | /api/projects/:pid/agents/:id | `{ name?, role?, skills?, lead? }` |
| DELETE | /api/projects/:pid/agents/:id | |
| GET    | /api/projects/:pid/connections | |
| POST   | /api/projects/:pid/connections/check | no prompt, no tool calls |
| PUT    | /api/projects/:pid/connections/:name | `{ enabled?, desks?, mode? }` |
| GET    | /api/projects/:pid/threads/:tid | thread + messages; marks read |
| POST   | /api/projects/:pid/threads | `{ text, title?, itemId?, attachments? }` |
| POST   | /api/projects/:pid/threads/:tid/messages | `{ text, attachments? }` |
| POST   | /api/projects/:pid/threads/:tid/resume | delivers held messages |
| POST   | /api/projects/:pid/threads/:tid/close | |
| GET    | /api/projects/:pid/workspaces/:agent/report | `?file=<path under reports/>` |
| POST   | /api/projects/:pid/reset | `?empty=1` |
