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

The API answers only to this PC's own names (`localhost`, `127.0.0.1`, `[::1]`), which blocks
DNS-rebinding pages. Changes are accepted only from HQ's own page or from tools like curl. Set
`HQ_ALLOWED_HOSTS=name1,name2` to allow other host names.

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
| Needs you | An inbox of decisions, tickets ready for sign-off, holds and paused chat threads, with Approve (or Mark done) / Hold / Send back / Instruct on each row |
| Chat | Thread list and the open thread side by side (one pane under 900px) |
| Board | To do, In progress, Needs you and Done, plus QA on dev-team projects. Drag-and-drop, filters by text, assignee and "Needs me" |
| Team | A card per desk; "Add teammate" is the dashed card |
| Office | The pixel office |

Tickets and people open in a large **modal** over whatever view you are on, like Jira's issue
view: the ticket on the left, its details (assignee, from, status, type, client, thread) on the
right. Clicking a desk's name inside it switches the modal to that person. The URL carries it
(`#/p/gecom-apps/board?ticket=GA-12`), so reload, Back and shared links land on the same ticket.
Esc, the X, or a click outside closes it, and focus goes back to the card you opened it from.

Every view has its own URL: `#/p/<project>`, `#/p/<project>/chat`, `/board`, `/team`, `/office`,
`/chat/<threadId>`, `/settings`, `/connections`, plus `#/projects`.

Keyboard shortcuts (ignored while you type):

| Key | Does |
| --- | ---- |
| `c` | Create an instruction or a chat thread |
| `/` | Search tickets in this project; Enter opens the top hit |
| `[` | Collapse or expand the sidebar |
| `Esc` | Close the top layer only: menu, then the report reader or a dialog, then the ticket |
| `Ctrl+Enter` | Send in any text box |

On the board, the ‹ › buttons on each card move it one column; they always show on touch screens,
where drag-and-drop is unreliable.

Screen sizes: full sidebar from 1100px, an icon rail from 720px (expand it for an overlay), and
an off-canvas sidebar with full-screen ticket and report views on phones.

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
tables, lists, task lists, code and links.

A ticket's reports are a **list**: each row shows the report's title (its first heading), the
file name, the desk that wrote it, when it last changed, and its size. A file that was deleted
shows as "File not found". Clicking a row opens the **reader**, full size, with:

- **The ticket's other reports** down the left side ("2 of 3"). Click one, or use Up and Down.
- **Preview / Raw** to switch between the formatted page and the plain markdown. The choice is remembered.
- **Copy** to copy the markdown.
- **Open raw** to open the file in a new tab.

Other links on the ticket (web pages) sit under **Links** below the reports.

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
- **Desks write markdown too:** every desk is told its messages, comments, briefs and decision summaries show as formatted markdown. It uses bold, lists and `code` instead of ALL CAPS. Titles, status lines and "done" summaries stay plain text.
- **Voice:** desks write to you like a sharp colleague: first person, plain words, answer first. They skip filler, emojis and grovelling apologies, and never claim feelings or work they didn't have. To give one desk its own personality, add a line to its `ROLE.md`; it's read at the start of every run, with no restart.
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
- **Desks can send you images too.** When a connected tool returns a picture during a run, for
  example a Figma screenshot, HQ keeps up to 6 recent screenshots per run in memory, and only
  the ones the desk attaches are saved. The desk attaches the latest ones with `screenshots: 1`
  on `comment_on_ticket`, `send_message` or `raise_for_decision`, or attaches an image file it
  can read with `files: ["path"]`. They show as thumbnails like yours. Only
  images from the desk's own connections count, never a file it merely read, and files must be
  in its workspace, the project folder, or this project's attachments.
- **Images from the web.** A desk can attach a public image by its address with
  `urls: ["https://…/photo.jpg"]`, for example a Pexels photo. It must be the image file itself,
  not the page it's on. HQ downloads it and adds a credit line under the post, such as
  *Image from images.pexels.com*.
  - **Safety:** only https addresses of named public sites. HQ refuses any address that turns out to
    point at this machine or the local network, at every redirect.
  - **Limits:** 10 seconds and 3.75 MB, and the file must really be a PNG, JPEG, WebP or GIF.
- **Figma screenshots that come back as a link.** Figma's online server answers `get_screenshot`
  with a short-lived image link instead of the picture. HQ downloads that link as soon as it
  arrives, so `screenshots: 1` works with it too.
  - **Limits:** only https links on Figma's own hosts are downloaded, redirects only to Figma or its
    cloud storage, within 10 seconds and 3.75 MB.
  - **Checks:** the file must really be a PNG, JPEG, WebP or GIF, the same as your uploads.
  - **Pasted links:** a link pasted as markdown `![](...)` still shows only as a link, because HQ never
    loads outside images.

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
- **Mode**: pick one per server.
  - *Ask before changes* (default): agents read freely. A tool that posts or changes something
    is refused until you approve the ticket in Needs you, and only the run after your approval
    may use it.
  - *Read only*: changes are never allowed.
  - *Auto*: agents post and change things on their own, as you. Anything that deletes or removes
    still waits for your approval, the same way as Ask. HQ asks you to confirm before turning
    Auto on. Turning a connection off puts it back on Ask.
- **Changes count at once.** A run checks your saved choice on every tool call: turn a server off,
  drop a desk, or pick a stricter mode, and a desk that is already working follows it straight
  away. A looser mode waits for its next run.
- **Deletes**: a tool counts as a delete when the server marks it destructive, or when its name
  says delete, remove, destroy, drop, purge, erase, wipe, trash, revoke, unpublish, uninstall,
  truncate, clear, rm, del, unlink, detach, disconnect, archive, discard, prune, flush, kill,
  terminate, reset, overwrite or force (`force_push`), plural too. Run-together names count
  (`deleteall`, `batchDelete`, `HTTPDelete`), but `undelete_note` and `get_removed_items` don't.
  - Close, cancel, dismiss, revert, unassign and disable are changes, not deletes: they can be
    undone. Edits that overwrite content (updating a page or a file) are changes too.
  - On Auto, HQ also looks inside a tool's input: an action like `method: "remove"` or
    `op: "delete"` (GitHub's `*_write` tools, batches), a key like `deleteContentRange` or
    `force: true`, and common deletes in code or SQL (`DELETE FROM`, `DROP TABLE`, `.remove()`).
  - Auto can't fully see inside tools that run code, scripts or batches (Figma `use_figma`, SQL
    tools, browser tools). It catches common delete patterns only. Keep those servers on Ask if
    that matters. What desks read through a connection (issues, pages, the web) can also steer
    what they do.
- **Auto changes are logged.** Each one that works goes in the activity feed, with the desk, the
  server, the tool, what it touched (an id, number, title or link from the input) and the ticket.
  If a run stops before a change's result comes back, the feed says it may have gone through.
  Desks are also told to list what they changed in their reply, comment or summary.
- **No repeats.** A run that fails after an auto change is not retried in a fresh session, since
  the retry would do the whole task again. It stops and says which servers it changed.
- **Huddles and QA checks stay read-only**, whatever the mode.
- A tool counts as a read when its name reads (`get_`, `list_`, `search_`, `..._read`) and nothing
  in the name sounds like a write or a delete. The server's own read-only hint counts, but never
  over a name like that. Unknown tools count as changes. A read-named tool is trusted as a read on
  every mode: its input is not checked.
- Everything posts **as you**, under your own GitHub, Atlassian, or other account. There are
  no bot accounts. On your own PRs, GitHub won't let the author approve or request changes, so
  agents can only leave comments there.
- Tokens are never stored in HQ. Only your choices are saved: which servers, which desks, and
  which mode, plus each server's fingerprint and last check. Each run reads the config fresh
  from Claude Code's own files.
- A run loads only HQ's tools plus the servers turned on for that desk (`strictMcpConfig`).
  Other claude.ai connectors stay out, which also keeps prompts smaller.

- **A changed setup stops a connection.** HQ remembers which server you turned on by a
  fingerprint: a hash of its masked command or URL plus its header and variable names, never the
  command, URL or any value. A new token keeps it. If that server's setup changes in Claude Code,
  or a same-named one takes its place, desks stop getting it. The row then says so, with a
  **Use the new setup** button, which drops the old server's tool list and checks the new one.
  When HQ adds or removes a server, every project settles at once: a connection whose server
  changed or is gone is turned off (Auto back to Ask), so it can't come back on its own.
  Connections saved before fingerprints get one when HQ starts.

### Adding, logging in and removing

The Connections page can set servers up for you. It runs Claude Code's own `claude mcp`
commands, using the CLI that ships with the Agent SDK (the same one desks run), so servers land
exactly where Claude Code keeps them. There is no terminal inside HQ.

- **Add connection** opens a form in three steps:
  1. Pick what to connect.
     - Presets: **Playwright** and **Chrome DevTools**. Both give desks a real browser: open pages,
       click, fill forms, take screenshots. The command comes from HQ, and the options only pick
       flags: no window (headless), a fresh browser each time, and for Playwright, Chrome or Edge.
     - **Custom**: any other server, either a URL (HTTP or SSE) with optional headers, or a program
       to run on this PC with arguments and environment variables.
  2. Fill in the details and pick where to save it:
     - **This project only**: Claude Code's settings for the project's folder (`local` scope).
       If the folder sits inside a git repo, Claude Code keys these by the repo's top folder.
       Git worktrees (a `.git` file instead of a folder) count as a repo top, but are untested.
     - **All my projects**: your global Claude Code settings (`user` scope). Every project and
       every Claude Code session on this PC sees it.
     Either way it stays on this PC, never in git.
  3. Review exactly what gets saved, with secrets masked, and which file it goes in. Adding
     only works with the reviewed details: if they changed, HQ asks you to review again.
- **New servers start off.** After adding, HQ checks just that server (connects, lists tools,
  calls none), then you turn it on and pick desks and a mode as usual. If the new one replaces
  a same-named server that was turned on anywhere, HQ turns that one off.
- **Local commands run on your PC** each time a desk or a check uses them. Custom ones need
  **I trust this command**. Shells (`cmd`, PowerShell, bash, `wsl`...) are refused, as are
  arguments with `"` or `%`, and variables like `PATH` or `NODE_OPTIONS`. A preset's first check
  downloads its package from npm through `npx`.
- **Secrets**: new headers and variables start as **Secret**: typed in a password box, masked
  in the preview, and blanked out of anything Claude Code prints. A row named like a secret
  (`Authorization`, `API_TOKEN`, `X-Api-Key`, `DB_PASSWORD`, `Cookie`...) counts as one even
  unticked. Claude Code saves it in its own settings file, as it does for `claude mcp add`. HQ
  never stores or logs it, and blanks a server's own values out of its error messages.
  - Tokens in arguments (`--token=...`, `-e GITHUB_TOKEN=...`, `--api-key X`, `-p X`), in URLs
    (`postgresql://user:password@...`, a key in the path or `?api_key=`) are masked too, and get
    a warning.
  - `claude mcp add-json` takes the whole config on its command line, so while Claude Code saves
    it, other programs on this PC can briefly see every value, secrets too. Arguments stay
    visible to them every time the server runs, so put tokens in a header or variable, not an
    argument. To keep a token out entirely, enter `${MY_TOKEN}` as the value (not ticked Secret)
    and set `MY_TOKEN` in your environment: Claude Code fills it in when the server starts. A
    value ticked Secret can't contain `${`.
- **Log in**: web servers that need a browser sign-in get a **Log in** button. HQ asks Claude
  Code for the sign-in page and shows **Open sign-in page (host)**. You sign in yourself in
  your browser, as you. Claude Code saves the token where desks and Claude Code find it, and the
  row turns connected on its own. You have 5 minutes, and one sign-in runs at a time. Cancel stops it.
  - `claude mcp login` needs a real terminal, so HQ uses the Agent SDK's session sign-in instead.
    That call isn't in the SDK's published types. If an SDK update removes it, or it gives no
    sign-in page, the row shows `claude mcp login <name>` to copy, and **Open terminal and log
    in**, which runs the `claude.exe` HQ uses, not whatever `claude` is first on PATH. Both only
    show for plain names (letters, numbers, - and _); for others, log in with `/mcp` in Claude Code.
  - Adding or removing a server for all projects is refused while any project is signing in to
    that name, and cancels those sign-ins after.
  - For a claude.ai connector, connect it in claude.ai under Settings, Connectors. Then check again.
- **Log out** clears a web server's saved sign-in (`claude mcp logout`).
- **Remove** (click twice within 5 seconds; Escape or moving away starts over) runs
  `claude mcp remove` for the place the server lives, which also clears its saved sign-in. A
  server saved for all projects is removed from every project. If a same-named one shows through
  after, it starts off. A row whose config is already gone gets **Forget** instead, and can be
  turned off but not on. Desks already running keep the server until they finish.
- **Open terminal** opens Windows Terminal in the project folder, for anything the form doesn't
  cover. It's your own terminal window, not one inside HQ.
- **Check** on a row checks just that server. A first `npx` run can take up to 90 seconds.
- Set `HQ_CLAUDE_BIN` to use a different `claude` executable. It must be the program itself
  (`claude.exe` on Windows), not a `.cmd` shim like the one npm puts on PATH: HQ runs it without
  a shell, and Windows won't start a `.cmd` that way. `CLAUDE_CONFIG_DIR` moves Claude
  Code's settings, and HQ follows it. The Open terminal button is hidden then, because a new
  terminal would not have it.

## QA (dev-team projects)

On a project made from the **Dev team** template, finished work is checked before it's Done:

1. **The owner finishes.** When a desk calls `report_done`, the ticket moves to the **QA** column
   instead of Done.
2. **The QA desk checks it.** The project's QA desk (Ivy by default) is woken. It reads the ticket,
   the files the owner changed and the owner's reports, then records a verdict with `qa_result`.
3. **Pass:** the ticket waits in QA as **sign-off** and shows in **Needs you** under "Ready for
   sign-off". **Mark done** closes it. Send back, Instruct and Hold work as usual.
4. **Fail:** the ticket goes back to the owner, tagged "QA failed", with the issues as a comment.
   The owner is woken to fix them and finishes again, which sends it back to QA.
5. **Too many fails:** after 2 fixes (`HQ_QA_MAX_FIXES`), the next fail comes to you in Needs you
   instead. **Accept as is** closes it; Send back or Instruct gives the owner another round, and the
   count starts over.

- **The QA desk only reads.** In a QA check the project folder is read-only, connections are
  read-only, and there is no shell and no web. So QA checks by reading, and says in its verdict what
  should be run (tests, a build) to confirm. Each check starts a fresh session, so the QA desk's own
  session is not filled with other tickets' code.
- **Files changed.** HQ records each project file a desk changes for a ticket, once the write went
  through (never the desk's own workspace). The QA check gets that list, and the ticket shows it
  under "Files changed".
- **Changed after QA.** If the owner changes project files on a ticket that is in QA or waiting for
  your sign-off (answering a comment, say), it goes back to QA for a fresh check.
- **Rounds.** Every trip into QA is a new round with no verdict yet. A check counts only for the
  round it started in: if the ticket changed while QA was reading, that verdict is refused and the
  new round gets its own check. A sign-off nobody checked this round says so, with the owner's
  summary instead of an old verdict.
- **Pick the QA desk** in the desk's panel (click its card in the Team tab): **Make QA desk** or
  **Stop QA**. With no QA desk, or when the QA desk is off shift or did the work itself, a finished
  ticket goes straight to your sign-off.
- **Changing the QA desk.** Make another desk the QA desk, Stop QA, or remove the QA desk, and the
  tickets waiting in QA go to the new QA desk, or to your sign-off. Your pick sticks across restarts,
  none included; a reset starts the team again with Ivy as the QA desk.
- **By hand.** Drag a card into QA, or pick "in QA" in a ticket's status menu, to have it checked.
  "Put Ivy on it" on a ticket in QA runs the check again. A ticket you move to sign-off through the
  API closes on **Mark done**, like one QA passed. A ticket that leaves sign-off any other way than
  your Hold (a new ask from its desk, a move, the desk back on it) needs your Approve again.
- **Cost.** Each check is one desk run, with the same caps as a ticket run.
- Business and blank projects have no QA column and work as before.

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_QA_MAX_FIXES` | 2 | Fixes after a QA fail before the ticket comes to you instead |

## Chat (desks talking to each other)

The **Chat** tab shows threads between desks, and you. Messages do real work: each message to
a desk wakes it for a live run, which spends usage.

- **Desks message each other** with two HQ tools:
  - `send_message(to, text)` reaches up to 3 teammates, or "founder" to answer you.
  - `hand_off(to, title, brief)` gives a teammate a ticket of their own. The sender is told
    automatically when that ticket is done: when its desk finishes it, when you sign it off, or
    when you mark it done yourself.
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
- **A cut-off reply is asked again.** If a desk's run dies before it replies (a server restart,
  an error), what it was woken for counts as unread again. After a restart the thread pauses;
  **Resume** wakes the desk with the same messages.
- **Ownership.** A desk woken by a message can't finish someone else's ticket, and
  `raise_for_decision` opens a new ticket rather than taking over theirs. A ticket run that
  asked a teammate stays in progress until the reply.
- **Trust.** Teammate messages are treated as colleague requests. They can't approve anything.
  On Ask, MCP writes need a run that follows your approval; on Auto, only deletes do.
- **Message runs are cheap by design.** They're capped at 12 turns and $1 estimated. A small
  ask-and-answer came to about $0.05 to $0.08 per run.

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_CHAT_HOP_LIMIT` | 6 | Desk-to-desk wakes per thread before it pauses |
| `HQ_CHAT_DAILY_RUNS` | 30 | Desk-to-desk wakes per project per day |
| `HQ_MSG_MAX_TURNS` | 12 | Turn cap for a message run |
| `HQ_MSG_MAX_BUDGET_USD` | 1 | Estimated-cost cap for a message run |

In sim mode, desks answer with canned replies, so the tab works without spending usage.

## Huddles (retro, brainstorm, planning)

A huddle gets 2 to 6 desks thinking about one topic together. You start every huddle, and
nothing it proposes happens until you approve it. Start one from the **Huddles** tab.

- **Three kinds.** Each kind fills its own board:
  - **Retro**: Went well, Did not go well, and Try next columns.
  - **Brainstorm**: idea cards. The facilitator picks the strongest idea and says why.
  - **Planning**: a task list. Each task has a desk to own it.
- **Rounds.** Pick 1 to 3 rounds. In each round, every desk adds its part at the same time,
  through the normal desk queue. Then the facilitator sums up the round. Desks in later rounds
  react to the summary.
- **The facilitator** is the project lead when the lead is in the huddle. Otherwise it's the
  first desk you picked.
- **The cost shows before you start.** The setup form shows how many desk runs the huddle will
  take: desks × rounds, plus one summary per round. Each turn is a short run, capped like a
  message run (12 turns, $1 estimated). A turn starts a fresh session, so it never mixes into
  the desk's ticket session.
- **Talk, not work.** During a huddle, desks can only read: their workspace, the project folder
  and read-only connection tools. They can't write files, use the web, or change anything
  through a connection. Each turn has a single HQ tool: `huddle_contribute`, or
  `huddle_summarize` for the facilitator.
- **Only you give instructions.** Each turn sees what teammates said quoted under their names,
  as colleague input. Only your steer notes speak for you.
- **Proposals wait for you** on the huddle page and in **Needs you**. The last summary can
  propose two things:
  - **Tickets.** They land in **To do**, owned by the desk named. You start them yourself.
  - **Team notes.** They're added to the notes as one plain line of up to 300 characters, with
    no headings or sections. You see the whole line before you approve it.
- **Steer, stop, resume.** Your note in the steer box reaches the desks on their next turn,
  and it wakes nobody. **Stop** cancels the desks mid-turn. **Resume** runs only the turns
  still owed: desks that haven't added anything this round, including ones whose run failed
  or was stopped. A summary that already landed doesn't run again. A desk that left the team
  drops out, and if it was the facilitator, the lead (or the first desk left) takes over.
  After a server restart, a running huddle comes back stopped, ready to resume.
- **Limits.** Only one huddle runs at a time per project, and a project can start a set number
  of huddles each day (see the table below). HQ keeps the 30 newest huddles, plus older ones
  with proposals still waiting, up to 50 in all.
- **Sim mode** answers with canned turns, so you can try it without spending usage.

## Team notes

**Team notes** is a short markdown page of what the team has learned, up to 8,000 characters.
Retro lessons you approve are added to it, and you can edit it yourself.

The notes cost tokens on every run that reads them, so desks only see them when you ask. Each of
these has an **Include team notes** box, off by default:

- a new instruction
- a ticket comment
- an Instruct or Send back note
- a new huddle

The box shows about how many tokens the notes add. To send the notes with every desk run, chat
replies included, turn on **Include in every desk run** on the Team notes page.

If a huddle note gets approved while you're editing the notes, the editor warns you and Save is
refused, so the new note isn't lost. Copy your text, press **Cancel**, and edit again.

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_HUDDLES_PER_DAY` | 5 | Huddles a project can start per day. `0` turns huddles off |
| `HQ_SIM_HUDDLE_MS` | 900 | Sim mode: about how long a canned huddle turn takes |

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

Without connections, nothing leaves the building. Agents cannot email, post, or call external
systems. They draft, save to `reports/`, and ask. A connection lets them act only as far as its
mode allows (see Connections).

Edit `workspaces/<project>/<agent>/ROLE.md` to change how a desk behaves. It is read on every run.

## Env

See `.env.example`. `HQ_RUNNER=sim` forces sim mode even with a key.

Code work reads a lot of files, so it costs more per run than email drafting. A read of a
monorepo landed near $2.50 on the SDK's estimate. If code tasks hit "Reached maximum budget",
raise `HQ_MAX_BUDGET_USD`. On a subscription the figure is an estimate, not a charge.

### Sessions and the prompt cache

Each desk keeps one Claude session and resumes it on every run, so it remembers its earlier work.
Claude caches a session for about an hour on a subscription, and HQ asks for the 1-hour cache on
API-key runs and on overage too. While the cache is warm, resuming is cheap. Once it has gone cold,
the first turn re-reads the whole session at full price. A big session can then cost more than a
chat reply's whole budget ("Reached maximum budget ($1)").

- **Cold and big starts fresh.** When a desk's session is big and its cache has likely gone cold,
  the run starts a fresh session instead. Cold means idle longer than `HQ_SESSION_CACHE_MIN`, or
  anything cached ahead of the session changed since: the model, the SDK, the system prompt, HQ's
  tools or a connection's tools (an HQ update does that). Big means grown more than
  `HQ_FRESH_SESSION_TOKENS` past the session's base, the size of its first turn (system prompt,
  tools, first prompt), which any fresh session starts with anyway. Sessions from before HQ kept
  the base count their whole size. `memory.md`, reports and the ticket carry what matters, and a
  fresh session's prompt says so: its earlier conversation is not loaded, so read `memory.md` first.
- **One system prompt per desk.** A desk gets the same system prompt and tools for ticket runs and
  chat replies; what differs per run (why it was woken, an approval, team notes ticked for one task)
  goes in a "For this run" section at the very end of the prompt. Switching between chat and ticket
  work keeps the cache warm. The system prompt says only that last section counts, so a copy of it
  in a message or comment never passes for HQ's.
- **Safety net.** If a resumed run still runs out of budget in its first two turns and its first
  turn missed the cache, it is retried once in a fresh session (the log shows the first turn's cache
  numbers). A run that grew too large or lost its session is retried the same way. A retry only
  happens when the first attempt did nothing yet: no comment, message, decision, project file or
  auto change. The run's cost counts both attempts.

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_SESSION_CACHE_MIN` | 55 | Minutes a session's cache counts as warm |
| `HQ_FRESH_SESSION_TOKENS` | 40000 | Growth past the session's base above which a cold session starts fresh |

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
npm run test:huddles
npm run test:qa
npm run test:mcp
```

- **`test:guard`** checks what an agent may read and write in its workspace and the linked folder. It also checks which MCP tools run freely, need approval, or are refused.
- **`test:chat`** checks the chat core: recipients, the loop limit, resume and settle.
- **`test:ui`** checks the UI helpers: routes, board filter, search ranking, report link resolution, markdown previews, image sizing, and avatar text contrast.
- **`test:huddles`** checks huddles and team notes:
  - what it takes to start one, the daily limit, and who facilitates
  - what desks add, and the facilitator's summary and proposals
  - approving a proposal into a ticket or a note, and notes kept to one plain line
  - the round engine: turns that skip their tool, failed turns, stop and resume (also a quick
    resume mid-turn, a removed facilitator, and a summary that landed before the stop)
  - a restart mid-huddle, and the guard and prompt that keep huddle turns read-only
  - saving the team notes after they changed mid-edit, and the daily limit setting
- **`test:qa`** checks QA on dev-team projects: where a finished ticket goes, pass and fail verdicts, too many fails, rounds and stale verdicts, signing off, moving tickets by hand (through the API routes, in-process), changes after QA, changing or removing the QA desk, the QA desk default, changed files recorded only for writes that went through, the read-only, no-web fence around a QA check, and the quoting of desk-written text in its prompt.
- **`test:mcp`** checks adding, removing and signing in to MCP servers:
  - the rules for names, URLs, local commands and presets
  - masked previews and what the page shows, fingerprints, and secrets scrubbed from what the CLI
    prints and from error text; no token in HQ's data after turning on a server that holds some
  - which requests HQ answers, as rules and as the real middleware
  - changed setups across two projects, a check racing a change, and the old tool list dropped
  - the sign-in steps with a stand-in session (cancel at each step, failures, deadlines)
  - the Windows Terminal arguments, and the CLI runner ending on a timeout or a stuck child

  It runs the real `claude mcp` CLI against a scratch Claude config: `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` all point into a throwaway folder, and the test checks that the MCP servers and saved sign-ins in your real Claude config are unchanged at the end. The dummy servers live on 127.0.0.1:9, so nothing is contacted.
- **`test:attachments`** checks image uploads: type sniffing, file names, picking ids, the startup sweep, and the image blocks sent to desks. It also checks desk images: screenshot capture from connected tools (held in memory, saved only when attached) and attaching image files by path, links included.

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
| POST   | /api/projects/:pid/instructions | `{ text, attachments?, includeNotes? }` |
| POST   | /api/projects/:pid/items/:id/decision | `{ decision, note?, attachments?, includeNotes? }` |
| POST   | /api/projects/:pid/items/:id/comments | `{ text, attachments?, includeNotes? }`; wakes the owner |
| POST   | /api/projects/:pid/items/:id/attachments | `{ attachments }`; adds to the description |
| POST   | /api/projects/:pid/attachments | raw image body; returns the attachment |
| GET    | /api/projects/:pid/attachments/:file | the image |
| PATCH  | /api/projects/:pid/items/:id | `{ status?, summary? }`; summary only while To do; status `qa` starts a QA check; `signoff` waits for your sign-off (Approve closes it); `done` tells the desk that handed it over |
| POST   | /api/projects/:pid/items/:id/run | live only |
| POST   | /api/projects/:pid/runs/:id/cancel | |
| GET    | /api/projects/:pid/agents/:id | |
| POST   | /api/projects/:pid/agents | `{ name, role, skills?, lead? }` |
| PATCH  | /api/projects/:pid/agents/:id | `{ name?, role?, skills?, lead?, qa? }`; `qa` only on dev-team projects; tickets in QA follow the change |
| DELETE | /api/projects/:pid/agents/:id | |
| GET    | /api/projects/:pid/connections | |
| POST   | /api/projects/:pid/connections/check | `{ names? }`: all servers plus claude.ai connectors, or just these. No prompt, no tool calls |
| POST   | /api/projects/:pid/connections/preview | add request: what would be saved, masked, and where. Changes nothing |
| POST   | /api/projects/:pid/connections | add request plus `confirm` (the preview string): saves it with `claude mcp add-json`; starts off |
| DELETE | /api/projects/:pid/connections/:name | `?source=folder\|user\|repo`: `claude mcp remove` for that place; also clears its sign-in |
| POST   | /api/projects/:pid/connections/:name/login | 202: starts a browser sign-in; the row shows the page to open |
| DELETE | /api/projects/:pid/connections/:name/login | cancel the sign-in |
| POST   | /api/projects/:pid/connections/:name/logout | `claude mcp logout` |
| POST   | /api/projects/:pid/terminal | `{ login? }`: Windows Terminal in the project folder, optionally running `claude mcp login <login>` |
| PUT    | /api/projects/:pid/connections/:name | `{ enabled?, desks?, mode? }`; mode is `ask`, `read` or `auto` |
| GET    | /api/projects/:pid/threads/:tid | thread + messages; marks read |
| POST   | /api/projects/:pid/threads | `{ text, title?, itemId?, attachments? }` |
| POST   | /api/projects/:pid/threads/:tid/messages | `{ text, attachments? }` |
| POST   | /api/projects/:pid/threads/:tid/resume | delivers held messages |
| POST   | /api/projects/:pid/threads/:tid/close | |
| GET    | /api/projects/:pid/huddles/:hid | board, transcript and proposals |
| POST   | /api/projects/:pid/huddles | `{ kind, topic, participants, rounds, includeNotes }`; 409 while one runs, 429 at the daily limit |
| POST   | /api/projects/:pid/huddles/:hid/steer | `{ text }`; seen from the next turn |
| POST   | /api/projects/:pid/huddles/:hid/stop | |
| POST   | /api/projects/:pid/huddles/:hid/resume | |
| POST   | /api/projects/:pid/huddles/:hid/proposals/:prid | `{ decision: "approve" \| "decline" }` |
| PUT    | /api/projects/:pid/team-notes | `{ teamNotes?, notesEveryRun?, base? }`; 409 when `base` (the notes your edit started from) is no longer the current notes |
| GET    | /api/projects/:pid/items/:id/reports | the ticket's reports: title, desk, size, last change |
| GET    | /api/projects/:pid/workspaces/:agent/report | `?file=<path under reports/>` |
| POST   | /api/projects/:pid/reset | `?empty=1` |
