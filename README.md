# AI Team HQ

A self-hosted dashboard for running teams of AI "employees", one team per project. Each
project has an inbox of decisions that need you, a team list, a kanban board with Jira-style
ticket keys, and a pixel office where each agent sits at a desk. Link a project to a folder
on disk and its team can read that codebase.

Two modes:

| Mode | What runs | Needs |
| ---- | --------- | ----- |
| **sim** (default) | Fake activity on a timer. Good for looking at the UI. | nothing |
| **live** | Each desk is a real Claude agent (Claude Agent SDK) with its own workspace folder. | your Claude account (sign in from HQ) or an API key |

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
| Board | To do, In progress, Sign-off, Needs you and Done, plus QA on dev-team projects (see [Sign-off and QA](#sign-off-and-qa)). Drag-and-drop, filters by text, assignee and "Needs me" |
| Team | A card per desk; "Add teammate" is the dashed card |
| Office | The pixel office: where every desk is and what it's doing right now (see [Office](#office)) |

Tickets and people open in a large **modal** over whatever view you are on, like Jira's issue
view: the ticket on the left, its details (assignee, from, status, type, client, thread) on the
right. Clicking a desk's name inside it switches the modal to that person. The URL carries it
(`#/p/gecom-apps/board?ticket=GA-12`), so reload, Back and shared links land on the same ticket.
Esc, the X, or a click outside closes it, and focus goes back to the card you opened it from.

Every view has its own URL: `#/p/<project>`, `#/p/<project>/chat`, `/board`, `/team`, `/office`,
`/chat/<threadId>`, `/settings`, `/connections`, `/skills`, plus `#/projects`.

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

## Office

The Office view is the design team's pixel-art office (office-room.svg v3, ATHD-18), drawn from
their sprite files on a 2:1 isometric grid. It has six rooms: the office with desk pods, a play
area, the hall, your room, the meeting room and the kitchen. Everyone shows up where their state
puts them:

| State | Tag | Where |
| ----- | --- | ----- |
| Coding | green `</>` | At their desk. Mid-run, and the last tool wrote or edited a file in the project folder |
| Working | blue page | At their desk. Mid-run on anything else, or has work in progress or queued |
| Chatting | amber dots | Two desks talking to each other face across the meeting table; a huddle fills the chairs from the middle, then the standing spots. A desk answering you chats from its own desk |
| Idle | purple controller | The play area or the kitchen |
| Waiting on you | red `!` | Your bench first, then the two spots beside it, then the queue. More than that shows as a count on your door |
| Off shift | grey `Z` | A chip outside, with the time they're back. Chips wrap into columns of three |

- **Nobody walks, and nobody is bumped.** A change of state moves someone from one spot to the next.
  Whoever holds a lounge spot, a meeting chair or a place on the bench keeps it while their state
  lasts; newcomers take what's free. The only animation is the glow of the lamp over your door
  while someone waits; it's off if your system asks for reduced motion. After two hours of
  waiting the count turns to `!!`. The wait counts from when the ticket went into Needs you, so a
  comment or a restart doesn't reset it.
- **Nothing hides someone waiting on you.** Their tags and names draw last, and the meeting chairs
  whose tags would sit on the bench or the queue are used only when nothing else is free.
- **Hover or tap someone** for a card with what they're on and for how long (`<1m`, `42m`,
  `1h 12m`, `1d 4h`), who they're talking to, and their task (idle and off shift have no task;
  off shift shows when they're back instead of a time). On a touch screen a tap pins the card;
  it has an Open button and a ×, and a tap anywhere else closes it. Esc closes any card. Click
  someone, or press Enter or Space on them, to open their panel. Focus comes back to them when it
  closes, and stays on them when others move. Screen readers get a list of who is where.
- **Desks keep their number.** Each desk has a desk number that stays when someone leaves; a new
  teammate takes the lowest free one. An owned desk keeps a dimmed nameplate while its owner is
  elsewhere. Up to 4 desks make one pod, up to 8 two (the approved layout), up to 12 a third,
  following the spec's growth rules: your room, the meeting room and the kitchen move right to make
  space.
- **Sharp pixels.** The scene only scales by whole numbers. The Office uses the full page width, so
  it shows at 2× once there's room for twice the scene (about 1,520 px at 8 desks, 1,330 px at
  4), and 3× at three times. On a narrow screen it stays at 1× and scrolls sideways.
- The floor stays light in both themes; the room around it follows the theme.

State is worked out on every poll (`office` in `GET /state`) and never saved. The sprites come from
the design folder: `npm run office:sync` checks and copies them into `src/office/sprites/` and turns
office-room.svg into `src/office/zones.v3.json` (set `OFFICE_DESIGN_DIR` if the folder isn't at
`C:\Users\patri\Desktop\ai-team-hq-design`). Both are committed, so a build never needs the design
folder. Never hand-edit a sprite: the design team rebuilds them with their `build-sprites.js`. The
app puts sprite markup straight into the page, so the sync refuses any file that holds more than
pixel-run `<path>` elements (a script, an event handler, a link, styles), and the app keeps only
those paths too.

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
  team (COO, EA, Pipeline, Prospecting, Inbound, Automation, Design, HR), Design team (Design
  Lead, Product, UI, Brand, UX Research, Content, Motion, Design Systems), or Blank. Each new team
  gets fresh desk names, picked to differ from the names in your other projects, so two Dev teams
  aren't the same people. Resetting a project brings in new names too, so the new desks start
  with a fresh ROLE.md and memory.md (the old desks' folders stay in `workspaces/`). The business
  demo keeps its own names, since its tickets name them.
- **Access**: Read only (default) or Read & write. Read only means agents read the code and put
  plans and diffs in reports. Read & write lets them edit files, but never `.git`, `node_modules`,
  `.env*` or key files. There is no shell either way: no builds, tests, git, or commits.
- **Sign-off** (on by default): finished tickets wait for you before Done. See
  [Sign-off and QA](#sign-off-and-qa).

Teams are editable on the Team tab: add a teammate with routing keywords, open one to make them
lead or remove them. A removed desk's open tickets go to the lead. The founder (you) is the same
person in every project; renaming yourself in one renames you everywhere.

Routing an instruction: `@Name` sends it straight to that desk. Otherwise the desk whose keywords
match best gets it, and the lead catches anything nobody matches.

Project settings (from the picker) edit name, key, folder, access and sign-off, or remove the project.
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
- **Deletes**: a tool counts as a delete when the server marks it destructive (with one exception
  for scripts, below), or when its name
  says delete, remove, destroy, drop, purge, erase, wipe, trash, revoke, unpublish, uninstall,
  truncate, clear, rm, del, unlink, detach, disconnect, archive, discard, prune, flush, kill,
  terminate, reset, overwrite or force (`force_push`), plural too. Run-together names count
  (`deleteall`, `batchDelete`, `HTTPDelete`), but `undelete_note` and `get_removed_items` don't.
  - Close, cancel, dismiss, revert, unassign and disable are changes, not deletes: they can be
    undone. Edits that overwrite content (updating a page or a file) are changes too.
  - On Auto, HQ also looks inside a tool's input: an action like `method: "remove"` or
    `op: "delete"` (GitHub's `*_write` tools, batches), a key like `deleteContentRange` or
    `force: true`, and common deletes in code or SQL (`DELETE FROM`, `DROP TABLE`, `.remove()`).
  - A server marks a tool destructive when it *may* overwrite or delete. Figma marks `use_figma`
    that way because it runs any plugin script. For `use_figma` only, the scan of its script
    decides instead: a script that only creates or reads runs on Auto, and one that calls
    `.remove()` or `deleteCharacters()` waits. The mark still counts when the call has no script,
    carries anything besides the script and plain labels, or is too big to scan whole. Every
    other marked tool waits, code or not.
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
  a shell, and Windows won't start a `.cmd` that way. Give a full path, or a name HQ finds in
  `PATH` (never in the project folder; see [Programs by full path](#scripts)). `CLAUDE_CONFIG_DIR` moves Claude
  Code's settings, and HQ follows it. The Open terminal button is hidden then, because a new
  terminal would not have it.

## Skills

A skill is a folder of know-how a desk can pick up: a `SKILL.md` (a short frontmatter with `name` and
`description`, then instructions in markdown), and sometimes `scripts/`, `data/` and `templates/`. It is the
same format Claude Code uses, so repos of Claude Code skills work, for example
[ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), which holds several under
`.claude/skills/<name>/`.

- **One library for all of HQ.** A skill is installed once, from the **Skills** page of any project (above
  Connections in the sidebar), and every project sees it.
- **Turned on per desk, in each project.** Each skill on the Skills page has this project's desks as chips. A
  new skill is on no desk. A desk that leaves the team drops out of its skills.
  - **All desks** (first chip, with two or more desks) turns a skill on for every desk in the project, or off
    again when they all have it. It is dashed while only some desks have it.
  - **A whole repo at once.** An open group of two or more skills has a switch, **All skills here, every desk**,
    and (with two or more desks) a row of desk chips, **Give every skill here to**, to give one desk every skill
    in the repo. The switch sits halfway, and a chip is dashed, when only some are on. Each click is one change
    and one line in the activity feed, naming the skills that changed.
  - "Every desk" means the desks on the team now. A desk added later gets nothing until you turn skills on for it.
- **Installing from GitHub.** **Install a skill**, paste a link, **Find skills**. HQ fetches the repo and lists
  every `SKILL.md` in it, with its description, files, size and the scripts it could run. Tick the ones you
  want, then **Install**. Nothing is installed before that. **Cancel** throws the fetched copy away, and while
  HQ is still fetching it stops git there and then. Cancel waits while an install runs.
  - Links: `https://github.com/owner/repo`, with or without `.git`, or a folder in it,
    `…/tree/<branch or tag>/<folder>` (a `…/blob/…/SKILL.md` link means its folder). Only https and
    github.com, with no user name or token in it. A branch name with a `/` in it can't be told apart from a
    folder, so link the repo itself for those.
  - HQ runs `git`, so **Git 2.45.2 or newer** must be installed. Older versions have clone bugs a hostile repo
    can use to run code on your PC (CVE-2024-32002 and others), so HQ checks `git --version` first and
    refuses an older Git: "Git 2.32.0.windows.2 is too old to fetch skills safely; install Git 2.45.2 or newer
    from git-scm.com". Set `HQ_GIT` to use another git.
  - The fetch is a shallow clone of one branch: no tags, no submodules, no links (`core.symlinks=false`),
    https only (no ssh, `git://` or `file://`, even if your git settings rewrite GitHub links), hooks only from
    an empty folder (`data/skills/.no-hooks`), no LFS downloads and no sign-in, so a private repo fails at once
    instead of asking. Git variables HQ was started with (`GIT_DIR`, `GIT_CONFIG_*` and the like) are left out.
    90 seconds at most.
  - Limits: a repo over 150 MB or 5,000 files is refused, and so is a skill over 25 MB or 2,000 files. While git
    runs, HQ measures the folder every few seconds and stops a fetch that grows past twice that. Three fetched
    repos wait for a pick at most; a fourth fetch drops the oldest.
  - HQ looks at most 50 skills and 20 folders deep. The dialog says when it stopped early: link a folder in the
    repo for the rest.
  - **Duplicates.** Some repos hold the same skill twice (ui-ux-pro-max-skill has copies of its skills under
    `cli/assets/skills/`). HQ compares each skill's `SKILL.md` (line endings aside) and its files with their
    sizes. Of each set of copies it lists the one under `.claude/skills/`, then a top-level `skills/`, then the
    shallowest, and folds the rest under "N duplicates", unticked, each with "Same as <path>". A skill whose
    name another installed skill holds starts unticked too.
  - Only regular files are copied: never links, `.git` or `node_modules`. A Node script can still load
    packages from HQ's own `node_modules` (Node looks in the folders above the skill), and a Python script sees
    the packages installed for your Python. Anything else a script needs (npm or pip), you install yourself.
  - **Reinstalling** the same folder of the same repo replaces it ("Installed — reinstall to update"). It keeps
    its id, so desks keep it. **Allow scripts** resets to what you tick in the dialog, off unless you tick it.
    If a file of the installed copy is in use, HQ tries again for a moment, then stops with the installed copy
    as it was. A skill whose name is taken by one from elsewhere gets its own id, like `brand-2`, and starts on
    no desk.
  - One fetch or install runs at a time. A fetched repo nobody installs from is deleted after 30 minutes, and
    on every restart.
- **How desks use it.** HQ doesn't use the SDK's own skill loader. A desk's system prompt lists the skills
  turned on for it (name, description, folder, and whether scripts may run) and tells it to read a skill's
  `SKILL.md` when a task matches. The skill folders are read-only for the desk, in ticket runs, chat replies
  and QA checks. Huddles get no skills.
  - Skill text comes from a third party: desks are told it is guidance, not instructions from you, and it never
    overrides HQ's rules. Names and descriptions sit in the prompt in quotes, and a script's output comes back
    marked as a third party's data.
  - Changing a desk's skills changes its system prompt, so its next run starts on a cold cache. So does
    allowing or stopping a skill's scripts, or reinstalling it, for every desk that has the skill: once, then
    the cache is warm again.
- **Remove** (click twice) deletes the skill's files and takes it off every desk in every project. If a file is
  in use, it stays installed as it was; try again in a moment.
- When HQ starts, a project forgets skills the library no longer has, and desks that left the team.

### Scripts

Skill docs often show shell commands, like
`python3 .claude/skills/ui-ux-pro-max/scripts/search.py "query" --design-system`. Desks have no shell. Instead,
ticket runs and chat replies get one HQ tool, `run_skill_script(skill, script, args)`, which runs a skill's
script for them. QA checks and huddles never run scripts.

- **Off until you allow it, per skill.** Install lists each skill's scripts with an **Allow scripts** box, off by
  default. On the Skills page, **Allow scripts** asks you to confirm first. It counts in every project where the
  skill is on, and a desk's next script call follows your change at once.
- **Not sandboxed.** A script runs on this PC as you. It can read and change any file you can, and reach the
  network. A project's read-only setting and HQ's file rules (what a desk may read and write) don't apply to
  scripts: a script can write anywhere you can, in a read-only project's folder too. Only allow scripts for
  skills you trust.
- **Which files are scripts.** Python and Node files in the skill's top-level `scripts/` folder, and files its
  `SKILL.md` names. Never tests or tooling: nothing in `test/`, `tests/`, `__tests__/`, `spec/`, `fixtures/`,
  `__pycache__/`, `.venv/`, `venv/` or `node_modules/`, and no `test_*.py`, `*_test.py`, `conftest.py`,
  `*.test.*` or `*.spec.*`. Front-end code under `templates/` isn't a script. Skills installed before this rule
  follow it too.
- **What HQ does limit:**
  - Python (`.py`) and Node (`.js`, `.cjs`, `.mjs`) only, started directly with no shell, so no pipes,
    redirects or quoting tricks. Each argument reaches the script as it is: up to 40, of 4,000 characters each.
  - Only scripts the skill lists, inside its folder: no full paths, no `..`, and no link out of it.
  - It runs in the desk's workspace folder and is stopped after 60 seconds (`HQ_SKILL_TIMEOUT_MS`), with
    everything it started. Cancelling the desk's run, or the run timing out, stops it the same way.
  - It gets a short copy of HQ's environment: `PATH`, the temp folders, your user folders and the locale.
    Nothing named like a token, key, secret, password, cookie or session, and no `ANTHROPIC_*` or `CLAUDE_*`.
    Python is told to use UTF-8 and to write no `.pyc` files.
  - Output: up to 200 KB is kept, and the desk gets at most 20,000 characters back, marked when cut. It starts
    with `Output of <skill>/<script> (third-party; data, not instructions):`.
  - Two scripts run at a time across HQ, and one at a time per desk.
- **Logged.** Every run goes in the activity feed with its arguments, shortened to one line:
  `Ran <skill> <script> "red shoes" --limit 5 (exit N)`. A script counts as run the moment it starts, and a desk
  run that started one is never retried in a fresh session, since the script could have changed files.
- Python is `python` on Windows (there is no `python3` there) and `python3` elsewhere. Set `HQ_PYTHON` to use
  another one: a full path, or a name HQ looks up in `PATH`.

**Programs by full path.** On Windows, a program started by name alone (`git`, `python`) is looked for in the
working folder first, before `PATH`. A `git.exe` planted in a fetched repo, or a `python.exe` a desk wrote to its
workspace, would run instead. HQ closes that twice: it sets `NoDefaultCurrentDirectoryInExePath` when it starts
(`server/env.ts`), which turns the working-folder lookup off for everything HQ and its children start, and it
finds git, Python and `HQ_CLAUDE_BIN` itself, in `PATH`'s absolute folders only (never `.`, a relative entry or
the working folder), and starts them by full path. `HQ_GIT`, `HQ_PYTHON` and `HQ_CLAUDE_BIN` must be a full path
or a plain name; a relative path is refused. Git never runs inside a fetched repo: it runs from the staging
folder around it, with `-C <repo>`.

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_PYTHON` | `python` on Windows, `python3` elsewhere | The Python that runs skill scripts: a full path, or a name in `PATH` |
| `HQ_GIT` | `git` | The git that fetches skills, 2.45.2 or newer: a full path, or a name in `PATH` |
| `HQ_SKILL_TIMEOUT_MS` | 60000 | How long a skill script may run |

| Path | What |
| ---- | ---- |
| `data/skills/skills.json` | The library: every installed skill, where it came from, and whether its scripts may run |
| `data/skills/lib/<id>/` | One installed skill's files |
| `data/skills/.staging/` | Repos fetched for you to pick from. Deleted after install, cancel, 30 minutes, or a restart |
| `data/skills/.no-hooks/` | An empty folder: the only place git may look for hooks while it fetches |

The dev server (`npm run dev`) never serves `data/` or `workspaces/`: a skill's `.html` there would otherwise
load as HQ's own page at `http://localhost:5174/data/...` and could call HQ's API. `vite.config.ts` answers 404
for those paths, denies them to Vite's file serving, doesn't watch them, and looks for dependencies only from
`index.html`. The production server serves `dist/` only.

Which desks have a skill is saved per project, in its `db.json` (`skillDesks`).

## Sign-off and QA

Finished work waits for you before it's Done. A desk that finishes a ticket does not close it: you
check it and sign it off, or send it back with what to change.

### Sign-off (every project)

1. **The owner finishes.** When a desk calls `report_done` (or a ticket run ends without it), the
   ticket moves to the **Sign-off** column instead of Done, with the desk's summary of what it did.
   The run's notes tell the desk this, so its summary says what changed and how to check it.
   A handed-off ticket tells the desk that handed it over right away that it is finished and waiting
   for your sign-off (or for QA), so that desk can carry on without waiting for you.
2. **You check it.** It shows in **Needs you** under "Ready for sign-off", and the ticket opens on
   "Finished. Check it and sign it off" with that summary.
3. **Mark done** closes it. A handed-off ticket then tells the desk that handed it over that it is
   signed off (just that: it already heard what was finished).
4. **Request changes with Send back**: write what to change (images too). The owner is woken with
   your note and told to fix what it asks and call `report_done` again, not to raise it as a new
   decision; that brings it back to Sign-off. **Instruct** works the same way. **Hold** keeps it
   waiting: it shows under "On hold" with the finished work (QA's pass or the owner's summary), and
   Mark done still closes it later.
5. **Comments** on a ticket in sign-off get an answer from the owner as usual. A comment run never
   closes the ticket and never reports it done again.

- **The setting.** Project settings (and Create project) have **Finished tickets wait for your
  sign-off before Done**. It is on for every project, including ones made before it existed. Turn
  it off and finished tickets go straight to Done, as before. Tickets already waiting for sign-off
  stay until you mark them done.
- **Approved work too.** After you approve a decision, the desk carries it out and its finished
  work comes to your sign-off like any other ticket.
- **The Sign-off column** shows when the setting is on, or while tickets sit in it. Drag a card into
  it, or pick "sign-off" in a ticket's status menu, to have it wait for you: Mark done closes it with
  no run. It shows no QA verdict, since nobody checked it that way. A ticket that leaves sign-off any
  other way than your Hold (a new ask from its desk, a move, the desk back on it) needs your Approve
  again, and an approved run still waiting to start when the ticket moves on is skipped.

### QA (dev-team projects)

On a project made from the **Dev team** template, finished work is checked before your sign-off:

1. **The owner finishes.** When a desk calls `report_done`, the ticket moves to the **QA** column
   instead.
2. **The QA desk checks it.** The project's QA desk (the QA Engineer by default) is woken. It reads the ticket,
   the files the owner changed and the owner's reports, then records a verdict with `qa_result`.
3. **Pass:** the ticket moves to **Sign-off**, with QA's verdict, and shows in **Needs you** under
   "Ready for sign-off". **Mark done** closes it. Send back, Instruct and Hold work as usual. With
   sign-off off, a pass closes the ticket instead.
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
  ticket goes straight to your sign-off, which says why nobody checked it. With sign-off off, it goes
  straight to Done, unless QA failed it last time: a fix of failed work comes to you instead, so it
  never closes unchecked.
- **Changing the QA desk.** Make another desk the QA desk, Stop QA, or remove the QA desk, and the
  tickets waiting in QA go to the new QA desk, or to your sign-off. They come to you even with
  sign-off off: they were waiting for a check, so HQ never closes them unchecked. The same goes for
  a ticket you move into QA by hand, or one changed after QA, with no QA desk free. Your pick sticks
  across restarts, none included; a reset starts the team again with its QA Engineer as the QA desk.
- **By hand.** Drag a card into QA, or pick "in QA" in a ticket's status menu, to have it checked.
  "Put [QA desk's name] on it" on a ticket in QA runs the check again.
- **Cost.** Each check is one desk run, with the same caps as a ticket run.
- Business, design and blank projects have no QA column: finished work goes to your sign-off (or Done).

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_QA_MAX_FIXES` | 2 | Fixes after a QA fail before the ticket comes to you instead |

## Chat (desks talking to each other)

The **Chat** tab shows threads between desks, and you. Messages do real work: each message to
a desk wakes it for a live run, which spends usage.

- **Desks message each other** with two HQ tools:
  - `send_message(to, text)` reaches up to 3 teammates, or "founder" to answer you.
  - `hand_off(to, title, brief)` gives a teammate a ticket of their own. The sender is told
    automatically when its desk finishes it, even while it still waits for QA or your sign-off, so
    the sender can carry on. It hears once more when the ticket is done: you sign it off, QA passes
    it (with sign-off off), or you mark it done yourself.
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
  an error), what it was woken for counts as unread again. After a restart, a reply you asked for
  pauses the thread, and **Resume** wakes the desk with the same messages; a reply a teammate asked
  for starts again by itself, once (see [Pause](#pause)).
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

## Autopilot, Goal mode and Pause

The team can work on its own, and you can stop it with one button.

### Autopilot

Turn it on with the **Autopilot** switch on the board (it asks first), or in **Project settings**.
Then a free desk starts its next To do ticket by itself, oldest first, and goes on to the next one
when it is done. A desk counts as free when it is not off shift, has nothing queued or running,
is not in a running huddle, is not on an active ticket, and has fewer than 2 decisions waiting on
you. Autopilot only fills free run slots (`HQ_CONCURRENCY`), so it never takes a slot ahead of your
own clicks (a click for a desk that is mid-run still waits for that run, as always).

- **A failed Autopilot run** leaves its ticket for you: it shows **Auto-skipped** on the card and
  under **Autopilot stopped** in Needs you, and the desk moves on. **Put … on it** takes it back,
  and a run on it that goes fine clears the mark. A desk whose ticket's last run failed (one you
  started) moves on too; that ticket waits for you.
- **3 Autopilot failures in a row** stop Autopilot (picks and goal planning) in that project until
  you press **Resume Autopilot** on the board. Hand-offs, chats and QA checks go on; when one of
  those fails, it shows on its ticket or pauses its thread, as always.
- **Your Stop** on an Autopilot run leaves the ticket for you too, without counting as a failure.

### Goal mode

Write a goal in **Project settings** and turn on **Goal** (it needs Autopilot). The lead desk then
plans: a short planning run that reads the goal, the board and the team, makes up to 5 tickets
straight into To do (tagged **Goal**, at most 8 open at once), and says where the goal stands.
Autopilot works through the tickets.

- The lead plans when the goal is new, when the team has run out of goal work (at most every
  20 minutes), and every 6 hours besides, to add anything missing. Editing the goal starts over.
- A planning run only reads: no writes, no web, nothing changed through connections. It has its
  own limits (`HQ_PLAN_MAX_TURNS`, `HQ_PLAN_MAX_BUDGET_USD`).
- When the lead says the goal is **reached** or **blocked**, a ticket comes to Needs you
  (Approve marks it done) and planning waits for you. Marking "reached" done ends planning until you
  change the goal; sending it back, or dealing with "blocked", lets the lead plan again. Two plans
  in a row that add nothing while the team has nothing to do also come to you, as **stalled**.
- While all open goal work waits on you (decisions, sign-off, on hold), the lead waits too. It
  also never plans while it is in a huddle you started.
- The board shows the goal with its status (On track, Planning…, Reached?, Blocked, Stalled),
  how many goal tickets are open, and when the lead last planned.

### Daily limits

Each project has a limit on what the team starts on its own per day: **40 runs and $25** unless you
change them in Project settings. They count every run the team starts itself (Autopilot, goal
planning, hand-offs, chat replies between desks, QA checks); your own clicks never count. The $ is
the SDK's estimate. Both reset at your local midnight. Past a limit, the team's own starts wait
until midnight or until you raise it; the board shows "Today 6/40 runs · $4.10 of $25".

### Pause

**Pause** in the header stops everything the team starts on its own, in every project: Autopilot,
goal planning, hand-offs, chat wakes between desks and QA checks. Your own clicks still run, and
runs already going finish. While paused, the button turns into an amber **Paused** pill and a
banner says so; **Resume** carries on where it stopped.

- **Held, not lost.** A start that cannot run now waits on its ticket (**Waiting** on the card,
  with the reason in the ticket) or, for a chat wake, in the thread ("Sam sees this once it clears").
  It starts by itself once the reason clears. A start that no longer fits its ticket (you moved
  it, or marked it done) is dropped, with a line in the ticket's history.
- **Claude's usage limit** holds automatic work the same way, in every project, until the reset
  time Claude reports (half an hour when it gives none). The pill says "Usage limit · until 15:00";
  **Resume now** tries sooner. A login or billing problem waits for your Resume.
- **Restarts.** A team-started run cut off by a server restart starts again by itself, once; a
  second time it is left for you. Runs you started keep their old behaviour.
- A minute sweep (`HQ_AUTO_SWEEP_MS`) clears a usage limit that has reset and starts what waits.
  Run HQ with `npm start` for unattended work, so file changes never restart it.

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_AUTO_SWEEP_MS` | 60000 | How often HQ checks for held work, Autopilot picks and goal planning (live mode) |
| `HQ_PLAN_MAX_TURNS` | 20 | Turns one goal planning run may take |
| `HQ_PLAN_MAX_BUDGET_USD` | 1.5 | Estimated spend one goal planning run may take |

## Go live

The easy way, with your Claude subscription (Pro, Max, Team or Enterprise), no API key:

1. Open **Claude account** (header pill, your avatar menu, or the sidebar on All projects), or go to `#/account`.
2. **Sign in with Claude**. HQ shows Claude's own sign-in page: open it, sign in in your browser,
   and HQ finishes on its own. Signing in also turns on **Run desks on my Claude login**.
   For another device, or when the page didn't come back to HQ, open **Signing in on another device,
   or the page didn't come back to HQ?** under the link: its page (**Copy link** copies it) ends on
   a code you paste into HQ.
   Already signed in to Claude Code on this PC? Skip this: just turn on **Run desks on my Claude login**.
3. Restart HQ: stop it in its terminal (Ctrl+C) and start it again (`npm start` or `npm run dev`).
   The header pill turns green: `LIVE · claude-opus-5`.

Going live keeps what sim made in the projects you already have (demo tickets, chat and activity).
For a clean board, create a new project, or reset one (`POST /api/projects/:pid/reset`, empty when live).

If the page says **Sign in with Claude Code in a terminal (claude auth login), then turn on Run desks
on my Claude login here**, this Agent SDK can't sign in from HQ (or Claude Code gave no sign-in
page). Run `claude auth login` in a terminal and sign in with your Claude subscription, come back to
the Claude account page (it checks again when you return), turn the switch on, and restart HQ.

Or with `.env` (`copy .env.example .env`). The copied file leaves `HQ_RUNNER` empty, so the switch on
the Claude account page still decides:

- **API key** (pay per token): paste it into `ANTHROPIC_API_KEY=`. A key always wins over the login.
- **Claude subscription**: leave the key empty and set `HQ_RUNNER=claude`. That locks the switch on
  (the page says so); remove it to control the switch from the page again. The SDK uses the Claude
  Code login on this machine.
- **Bedrock, Vertex, `ANTHROPIC_AUTH_TOKEN` or an `apiKeyHelper`**: HQ only counts `ANTHROPIC_API_KEY`
  as a key, so set that the way your setup expects, or set `HQ_RUNNER=claude` and make sure the
  Claude account page shows you signed in (HQ asks `claude auth status` at start). A
  `.credentials.json` by itself no longer makes HQ live.

**Console logins.** If Claude Code on this PC is signed in with an Anthropic Console account instead
of a Claude subscription, desks spend API credits on it. Claude Code reports a Console sign-in as
`claude.ai` with no plan, so the page warns when no plan comes back: **Switch account** and sign in
with your subscription.

**Signing out while live.** HQ picked live at start, so it stays live, and desk runs fail without a
login. The first failure puts HQ on an account hold (**Account problem** in the header): automatic
work waits. Sign in again on the Claude account page, then press **Resume**. Or restart HQ to go back to sim.

How signing in works (`server/claudeAuth.ts`):

- Claude Code does it, as `claude auth login` would. A session with no tools and no servers asks the
  Agent SDK for the sign-in page (`claudeAuthenticate`, always the Claude subscription one, never the
  Console's). Claude Code takes the browser's answer on its own page on this PC and saves the login in
  `~/.claude`, where desks and every Claude Code here find it. HQ never sees a password or token: only
  the email, organization and plan from `claude auth status`.
- Only https pages on claude.com, claude.ai or anthropic.com are shown, checked on the server and in the page.
- One sign-in at a time; it gives up after 10 minutes, or after a minute when Claude Code gives no
  sign-in page. Cancel closes the session. A failed one shows why until you **Dismiss** it or try again.
- The sign-in counts once HQ has asked `claude auth status` again and sees the login; a wait that ends
  with no login saved fails instead.
- Signing in from HQ (or the switch) saves `claudeLogin` in `data/settings.json`: desks may run on the
  login. HQ picks sim or live once, at start, so it shows **Restart HQ to go live** until you restart.
  `HQ_RUNNER=sim` in `.env` always keeps sim; `HQ_RUNNER=claude` locks the switch on.
- **Sign out** runs `claude auth logout`: it signs out every Claude Code on this PC, not just HQ, and
  turns the switch off. Switching account replaces the login for all of them too.
- HQ counts a login when `~/.claude/.credentials.json` holds a Claude login (a file with only MCP
  sign-ins doesn't count), `CLAUDE_CODE_OAUTH_TOKEN` is set, or Claude Code said so (a Mac keeps the
  login in the keychain, so HQ asks `claude auth status` before it picks sim or live). Signing out here
  can't remove a `CLAUDE_CODE_OAUTH_TOKEN`; the page says so when one is set.

A subscription spends your plan's usage window, the same limits Claude Code has. Anthropic's SDK
docs say third-party products may not ship on claude.ai login; personal use on your own machine is
your call. Do not distribute the app set up this way.

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
   - Skills turned on for the desk are listed in its system prompt, and their folders are added read-only.
     `run_skill_script` runs a skill's script where you allowed it (see [Skills](#skills)).
   - Session id is saved per desk and resumed next run, so a desk remembers earlier tasks.
   - Caps: `HQ_MAX_BUDGET_USD` per run, `HQ_MAX_TURNS`, and the time limits in
     [How long a run may take](#how-long-a-run-may-take).
4. The agent either finishes (`report_done`) or hands you a decision (`raise_for_decision`).
5. Approve / Send back / Instruct each start a follow-up run with your note. Hold does nothing.

Without connections, nothing leaves the building. Agents cannot email, post, or call external
systems. They draft, save to `reports/`, and ask. A connection lets them act only as far as its
mode allows (see Connections).

Edit `workspaces/<project>/<agent>/ROLE.md` to change how a desk behaves. It is read on every run.

### Effort

Effort is how hard Claude works on each turn: how much it thinks, and how many tool calls it makes.
More effort means slower runs and more usage. Pick it in the header: click the `LIVE` pill, then
**Effort**. It is one setting for all of HQ, every desk in every project, saved in `data/settings.json`.

| Level | When |
| ----- | ---- |
| Model default | What HQ always used: the model picks (`high` on `claude-opus-5`), or `CLAUDE_CODE_EFFORT_LEVEL` when it is set |
| Low | Fastest, uses the least. Simple chats and drafts |
| Medium | A balance of speed, cost and quality |
| High | Hard reasoning and coding |
| Extra high | Long, demanding coding work |
| Max | The deepest reasoning; slowest, uses the most |

- **One level for every kind of run.** A desk resumes one conversation for tickets, chats and its
  other runs. Changing the level between them would make Claude re-read the whole conversation at
  full price, so there is no separate level per run type.
- **From the next run.** A run that already started keeps its level.
- **After a change, long conversations start fresh.** The level is part of what Claude caches ahead
  of a conversation, so a desk whose conversation is big starts a fresh one on its next run (see
  [Sessions and the prompt cache](#sessions-and-the-prompt-cache)). A small one just resumes.
- **The run limits still hold.** Extra high and Max reach `HQ_MSG_MAX_BUDGET_USD` (chat replies),
  `HQ_MAX_BUDGET_USD` and `HQ_RUN_TIMEOUT_MS` sooner. If runs stop with "Reached maximum budget",
  raise those or pick a lower level.
- `xhigh` and `max` need a model that has them; `claude-opus-5` has all five, and Claude Code runs
  them at `high` on a model without them. A level picked in HQ beats `CLAUDE_CODE_EFFORT_LEVEL`.
  On a wide window the header pill shows the level when one is set: `LIVE · claude-opus-5 · medium effort`.

## Env

See `.env.example`. `HQ_RUNNER=sim` forces sim mode even with a key.

Code work reads a lot of files, so it costs more per run than email drafting. A read of a
monorepo landed near $2.50 on the SDK's estimate. If code tasks hit "Reached maximum budget",
raise `HQ_MAX_BUDGET_USD`. On a subscription the figure is an estimate, not a charge.

### How long a run may take

A run is stopped when it goes quiet, not for being busy. Every message from Claude starts the
clock again, so a desk driving Blender for half an hour, one tool call a minute, keeps going.

| Env | Default | What |
| --- | ------- | ---- |
| `HQ_RUN_IDLE_MS` | 480000 (8 min) | No message from Claude for this long: "Stopped: no progress for 8 minutes" |
| `HQ_TOOL_IDLE_MS` | 1200000 (20 min) | The same while a tool call waits for its result (a long script, a slow app) |
| `HQ_RUN_TIMEOUT_MS` | 2400000 (40 min) | The whole run, however busy. A fresh-session retry gets only what is left |
| `HQ_MCP_TOOL_TIMEOUT_MS` | 900000 (15 min) | A connection's tool call that never answers fails, so the desk can carry on. Sets Claude Code's `MCP_TOOL_TIMEOUT` unless you set that yourself; 0 leaves it alone |
| `HQ_DEBUG_SDK` | 0 | 1 logs every message from Claude with the gap since the one before, to tune the limits |

Progress means anything Claude sends, including each streamed piece of a long reply, so writing a
big file in one go counts. Claude Code's own "still running" heartbeat during a tool call does not:
the tool window measures real silence.

A run's error says why it stopped: one of the above, "Stopped by you", or Claude's usage limit
("Claude's 5-hour limit reached. It resets at 15:00."), instead of "Operation aborted".

`HQ_RUN_TIMEOUT_MS` used to be the only limit, at 10 minutes in the old `.env.example`. It now caps
the whole run, so an old `600000` in your `.env` still cuts busy runs off at 10 minutes. HQ warns
about that at startup; raise it or remove it.

### Sessions and the prompt cache

Each desk keeps one Claude session and resumes it on every run, so it remembers its earlier work.
Claude caches a session for about an hour on a subscription, and HQ asks for the 1-hour cache on
API-key runs and on overage too. While the cache is warm, resuming is cheap. Once it has gone cold,
the first turn re-reads the whole session at full price. A big session can then cost more than a
chat reply's whole budget ("Reached maximum budget ($1)").

- **Cold and big starts fresh.** When a desk's session is big and its cache has likely gone cold,
  the run starts a fresh session instead. Cold means idle longer than `HQ_SESSION_CACHE_MIN`, or
  anything cached ahead of the session changed since: the model, the SDK, the system prompt, HQ's
  tools, a connection's tools (an HQ update does that) or the [effort](#effort) level. Big means grown more than
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
| `data/skills/` | The skills library and the installed skills (see [Skills](#skills)) |
| `data/settings.json` | Settings for all of HQ: the [effort](#effort) level, [Pause](#pause), and a Claude usage-limit hold |
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
npm run test:office
npm run test:activity
npm run test:skills
npm run test:settings
npm run test:timeouts
npm run test:auto
npm run test:account
```

- **`test:guard`** checks what an agent may read and write in its workspace and the linked folder. It also checks which MCP tools run freely, need approval, or are refused.
- **`test:chat`** checks the chat core: recipients, the loop limit, resume and settle.
- **`test:account`** checks signing in to your Claude account with a stand-in Claude Code: the pages shown (Claude's own sites only), the pasted code (and a code the browser beat to it), cancel and every way a sign-in can end, no token or code in any answer, that a poll never sees a sign-in that worked as signed out, that checks share one Claude Code run and only HQ's own page can force one, how HQ picks sim or live, the switch and the restart hint, and sign-out. Your real login is never touched.
- **`test:ui`** checks the UI helpers: routes, board columns and filter, search ranking, report link resolution, markdown previews, image sizing, and avatar text contrast.
- **`test:office`** checks the office floor:
  - the approved v3 layout exactly, and growth from 1 to 12 desks
  - the design team's route checks: every seat reachable, nothing inside a wall or a table, doorways only through gaps
  - sprites and their footprints, walls, labels clear of the floor and of each other
  - who stands where: the bench and queue, chat pairs and huddles, idle spots that stick, off shift, overflow
  - the pixel people and the draw order
- **`test:activity`** checks the six states from tickets, live runs, chats and huddles, how long each has lasted, desk numbers, and telling Coding from Working by the last tool.
- **`test:huddles`** checks huddles and team notes:
  - what it takes to start one, the daily limit, and who facilitates
  - what desks add, and the facilitator's summary and proposals
  - approving a proposal into a ticket or a note, and notes kept to one plain line
  - the round engine: turns that skip their tool, failed turns, stop and resume (also a quick
    resume mid-turn, a removed facilitator, and a summary that landed before the stop)
  - a restart mid-huddle, and the guard and prompt that keep huddle turns read-only
  - saving the team notes after they changed mid-edit, and the daily limit setting
- **`test:qa`** checks sign-off and QA: where a finished ticket goes with QA and the sign-off setting on or off, the sign-off setting on projects, pass and fail verdicts, too many fails, rounds and stale verdicts, signing off, moving tickets by hand (through the API routes, in-process), changes after QA, changing or removing the QA desk, the QA desk default, changed files recorded only for writes that went through, the read-only, no-web fence around a QA check, and the quoting of desk-written text in its prompt.
- **`test:mcp`** checks adding, removing and signing in to MCP servers:
  - the rules for names, URLs, local commands and presets
  - masked previews and what the page shows, fingerprints, and secrets scrubbed from what the CLI
    prints and from error text; no token in HQ's data after turning on a server that holds some
  - which requests HQ answers, as rules and as the real middleware
  - changed setups across two projects, a check racing a change, and the old tool list dropped
  - the sign-in steps with a stand-in session (cancel at each step, failures, deadlines)
  - the Windows Terminal arguments, and the CLI runner ending on a timeout or a stuck child

  It runs the real `claude mcp` CLI against a scratch Claude config: `CLAUDE_CONFIG_DIR`, `HOME` and `USERPROFILE` all point into a throwaway folder, and the test checks that the MCP servers and saved sign-ins in your real Claude config are unchanged at the end. The dummy servers live on 127.0.0.1:9, so nothing is contacted.
- **`test:skills`** checks skills:
  - GitHub links, and SKILL.md frontmatter (plain, quoted, folded, literal, and a 64 KB run of spaces in linear time)
  - git, Python and claude found by full path, never from the working folder (on Windows with planted
    `git.exe`/`python.exe` copies of a harmless program), and the `NoDefaultCurrentDirectoryInExePath` switch
  - the Git version check (2.45.2 or newer; a real older Git is refused before it fetches), the clone arguments,
    and git's environment without inherited `GIT_*` variables
  - the dev server's 404 for `data/` and `workspaces/`, however the path is spelled
  - finding skills in a fixture repo, with `node_modules`, `.git` and links skipped, duplicates marked, the 50-skill
    and depth caps, the size limits, and which files count as scripts
  - installing, reinstalling (also with the old folder in use) and removing, staging cleanup, Cancel during a
    fetch, the cap of three fetched repos, a fetch stopped for growing too big, and desks per project (cleaned at load)
  - which script paths may run, and running scripts: exit code, output, no secrets in their environment,
    timeouts, cancelling, the output cap, the activity line, and Python when it is installed
  - the Skills section of the system prompt, the read-only fence around skill folders, and the API routes

  It fetches nothing: a stand-in builds a local fixture where git would clone.
- **`test:auto`** checks what the team does on its own, with desks on a fake runner:
  - Pause: team starts held on their tickets and chat wakes held in threads (counts unchanged), your own starts never held (also when they join a waiting team run), queued team runs held at once without blocking yours, Resume oldest first, stale holds dropped
  - Claude's usage limit (held everywhere, cleared at the reset), account problems, and restarts (a team run starts again once; a hand-off and its QA check both cut off keep the QA check)
  - the queue: your runs first come, first served, ahead of the team's
  - daily limits: what counts, queued runs counted, your local day, the settings checks
  - Autopilot: free desks, oldest first, free slots only, failures and the stop after 3, your Stop, the prompt
  - Goal mode: when the lead plans, its tickets and caps, reached/blocked/stalled, planning first with the lead kept free, and the read-only fence and prompt of a planning run
- **`test:timeouts`** checks when a run is stopped: the idle and tool windows, the overall cap (and what a retry gets), the stop and usage-limit wording (never words that trigger a fresh-session retry), and the MCP tool timeout.
- **`test:settings`** checks the effort setting (the five levels, saving and going back to the model default), Pause and usage holds in a hand-edited `data/settings.json`, and the `PATCH /api/settings` route. It writes only in a scratch folder.
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
| GET    | /api/meta | includes `effort`: the level every desk run uses, or null for the model default; `paused`: why HQ holds automatic work (you, a usage limit, an account problem), or null; `held`: starts waiting; `restartToGoLive`: desks may run on your Claude login, but HQ started in sim; `optedIn`: desks may run on the Claude login; `simByEnv`: `HQ_RUNNER=sim` keeps HQ in sim |
| PATCH  | /api/settings | `{ effort?, paused? }`: effort is `low`, `medium`, `high`, `xhigh`, `max`, or null for the model default; `paused: true` pauses everything the team starts on its own, `false` resumes (your Pause first, then a usage hold). For all of HQ; answers with the new meta |
| GET    | /api/account | your Claude account: `{ account: { loggedIn, method, email, org, plan } \| null, login?, signedInAt?, apiKey, envToken, optedIn, optInByEnv, runner, restartToGoLive, simByEnv }`. `signedInAt`: when the last sign-in from HQ worked; `envToken`: `CLAUDE_CODE_OAUTH_TOKEN` is set. `?check=1` asks Claude Code again, only with a JSON content type (HQ's own page; another site's `<img>` can't); otherwise an answer up to 30 s old, or the check already running. Never a token |
| POST   | /api/account/login | 202: starts signing in; `login.authUrl` (and `login.manualUrl`) once Claude Code has the page. 409 while one runs |
| POST   | /api/account/login/code | `{ code }`: the `code#state` the second sign-in page showed. Answers once signed in, also when the browser finished the same sign-in first |
| DELETE | /api/account/login | cancel the sign-in, or dismiss a failed one |
| PUT    | /api/account/use | `{ on }`: may desks run on the Claude login? `true` needs a login. From HQ's next start |
| POST   | /api/account/logout | `claude auth logout`, for every Claude Code on this PC; turns `use` off |
| GET    | /api/fs/check | `?path=<folder>&except=<pid>` |
| GET    | /api/projects | |
| POST   | /api/projects | `{ name, key?, path?, access?, template?, signoff? }`; `signoff` defaults to true |
| GET    | /api/projects/:pid | |
| PATCH  | /api/projects/:pid | `{ name?, key?, path?, access?, signoff?, autopilot?, goalMode?, goal?, autoLimits? }`; `signoff` is true or false: finished tickets wait for your sign-off before Done (missing on older projects means on); `goalMode` needs a `goal` and `autopilot`, and `autopilot: false` turns it off too; `autoLimits` is `{ runs: 1-500, usd: 1-1000 }` |
| POST   | /api/projects/:pid/auto/resume | Autopilot stopped itself after 3 failed runs: start it again. Answers with the project's auto status |
| DELETE | /api/projects/:pid | archives it |
| GET    | /api/projects/:pid/state | includes `office`: what each desk is doing right now (activity, since, who with); `auto`: why the team's own work waits here, today's count against the limits, and the goal's status |
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
| GET    | /api/skills | the library, for every project |
| POST   | /api/skills/preview | `{ url, token? }`: fetches a GitHub link into staging and lists its skills, `{ token, repo, ref?, commit?, skills, truncated? }`. `token` (24 hex) is the page's own, so it can cancel before the answer. Installs nothing. 409 while another fetch or install runs |
| DELETE | /api/skills/preview/:token | stops a fetch that is still running, or throws a fetched repo away |
| POST   | /api/skills/install | `{ token, picks: [{ path, allowScripts }] }`; returns the library |
| PATCH  | /api/skills/:id | `{ scriptsAllowed }`, for every project |
| DELETE | /api/skills/:id | deletes it from HQ and from every project's desks |
| GET    | /api/projects/:pid/skills | `{ library, desks }`: which desks have each skill here |
| PUT    | /api/projects/:pid/skills/:id | `{ desks }`; an empty list turns it off in this project |
| PATCH  | /api/projects/:pid/skills | `{ skills, add?, remove? }`: adds desks to, or takes them off, several skills; each keeps its other desks |
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
