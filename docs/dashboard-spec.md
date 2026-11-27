# Triage dashboard: specification

## Purpose

The craft-app repos have about 25,000 open issues and PRs across about 20 active repos, and more arrive every day (about 900 PRs a day across the org). An automated pipeline classifies every item, reviews the promising PRs, fixes and merges what it can, and leaves the judgement calls to the maintainers.

**The bottleneck is human judgement, not tokens or build time.** The dashboard exists mainly so that maintainers can see what waits for an answer and answer it quickly, with enough context to decide and no walls of text. Its second job is to show progress and cost, so the maintainers can trust the process and the owner can tune it.

## Readers

| Reader | Device | Wants |
|---|---|---|
| Operator | Phone first, sometimes desktop | Answer recommendations in bursts; see whether the run is on track; adjust the whitelist, settings and access |
| Maintainers | Desktop and phone | Start and answer items in the repos they can write to; what got merged or closed and why |
| Viewers | Any | Read-only: progress, answers and their outcomes; no commands; no internal fields (see Visibility) |

Every reader signs in with GitHub. See [Accounts and access](#accounts-and-access).

## Principles

1. **Your own items come first.** Home lists the pipeline's problems and the reader's own items, and marks those with a question for the reader.
2. **One recommendation per item.** One sentence of what AutoCraft would do, its numbered parts, and one text box that takes yes or any command.
3. **Bulk work is a list of commands.** A command followed by several items starts each of them; nobody ticks boxes per finding.
4. **Counts before lists.** Every list page opens with a one-line summary ("38 items: 21 waiting for an answer; oldest 3 days").
5. **No page loads everything.** Lists page server-side (50 rows), filter by repo, area, type label, size, contributor tier and age, and keep filters in the URL so a link reproduces the view.
6. **Plain words.** Labels say what things are ("waiting for you", "merged by the pipeline"), not internal stage names.
7. **Never name the reference applications or their vendors.** Say "the reference app".

## Data

Read from the SQLite mirror (`src/schema.sql`, opened with `src/db.ts`). Mirror tables (`repos`, `items`, `comments`) are filled by `autocraft-server sync`; work tables are written by the pipeline and by the dashboard. Schema changes go in `src/schema.sql` as `CREATE ... IF NOT EXISTS` or additive `ALTER`s, and must keep existing rows.

A person's starts and answers live in the workflow tables: `item_workflows` (one live row per item: entry, weight, state, recommendation and parts, blocker, who started it and who approved the merge), `workflow_events` (every start, answer, stop and weight change, with who, where and the text as read) and `workflow_actions` (merges and closes to make as a person). See docs/pipeline.md, Starting and answering.

Stage vocabulary (`stages.stage`, latest row per item wins): `classified`, `reviewed`, `take`, `hold`, `close`, `batched`, `merged`, `closed`, `fixed-by-us`. The funnel for open items, as displayed:

| Funnel step | Rule |
|---|---|
| Open | open in the mirror |
| Classified | has a settled type label in the latest classification run (below) |
| Waiting for a second opinion / disagreement | Jev unsure and Haiku hasn't answered / Haiku gave another label |
| Reviewed | has a `reviewed` stage |
| Taken / held / to close | latest stage `take` / `hold` / `close` |
| In a batch | latest stage `batched` |
| Done | item closed or merged since tracking began, split by: merged by the pipeline, closed by the pipeline, closed by others |

The settled type label (`src/classify/settled.ts`): Jev's label when its top probability is at least 0.9; otherwise Haiku's when Haiku agrees with Jev; otherwise the item is unsettled, waiting for Haiku or in disagreement. The latest run is the one with the newest Jev verdict.

Done counts and trends start at `settings.tracking_started_at`, set when the database is first opened (the earliest repo sync, or that moment).

## Pages

### Home (`/`)

- One line says how many Task Runners are connected and how many others are available. Below it: problems, then the reader's own items (started, approved, held, answered or written about) with each conversation's last message; viewers see the recently updated items instead. With a project picked, it shows that repo only, and the repo's page (`/repo/<name>`) also shows its areas: each with its description and open items (linking to the Items list filtered to it), the open items without an area, the model's open proposals and the list's version history. Whoever runs the repo adds, renames, describes and removes areas.

- The Live board (`GET /api/live`) puts every running and queued unit of work in the project on one time axis over the last hour: a job with its model calls and build steps inside it, a model call or build task of its own, and each open integration batch with the build of its combined tree. A running lane shows how long it has run and, from earlier runs of the same step, the expected rest (dashed, the median) and a red mark where 90% of them were done. Up to six queued jobs follow; housekeeping steps show only when they fail. Jobs that ended in the last 20 minutes stay on it, faded. Lanes keep the order in which they first appeared: a lane that starts or ends stays in its place, and a lane the server stops sending stays as ended until the reader comes back to the tab or loads the page again. Model calls name their account for operators only.
- Operators and maintainers can switch the Live board from **By job** to **By worker** (`?live=workers`; viewers get no worker data). It gives one row per worker that does model calls: each person's Task Runner (with their own tokens) that has a fresh status or ran a call in the last hour, each enabled box account (operators only, as a call's account is), and Jev when it ran. A shared runner's row names its label, owner and harness, says whether it takes calls (with the reason when it does not), how many calls it runs of its slots and the models it offers; a label that is the machine's hostname shows as "Task Runner", and no hostname is ever sent. A user who turns on **Private on the Live board** (My settings) has their runners' calls shown to others on one "Private Task Runner" row, with no login, label, slots or models; they see their own runners as usual. Each track shows the calls the worker ran in the last hour on the same time axis, coloured by the step's group (review and verify, fixes, triage, security, other; the legend names the groups present) and marked with the item's number where the bar has room; a running call pulses and shows its expected rest, a failed one is red. A track is one tab stop; the arrow keys, Home and End move between its calls. Each call opens its Agents page, and its tip gives the item, model, tokens and times. Rows keep a fixed order, so a row does not move when its work starts or ends; calls on repos the reader cannot see are left out.
- Under the lanes are the latest five finished events of the Activity feed (merges, GitHub writes, answered questions, ended jobs) with a link to the full feed; what runs is on the lanes above.
- Hovering an item's number (Live board, Workable tables) shows the item in brief: title, author, labels, where it stands in the pipeline and what it closes (`GET /api/items/:repo/:n/peek`, its status text veiled as in the lists).
- The project picker (top of the rail; in the phone's navigation drawer) lists every repo the user may see with the items waiting for the user in each, and the total beside "All projects". The pick is kept in the browser. `/` opens the picked project only when the app first loads; the logo and the "Projects" link show the tiles.
- The pick narrows the list pages only: Items, the Work queue, Activity and the project page. A list page keeps its project in its URL (`?repo=`; with a pick and none in the URL it adds the pick, without a new history entry), so a copied link shows the same list; opening a link with `?repo=X` shows X's list and leaves the pick as it is. The server applies the project only on its list routes (`x-autocraft-scope`, routes marked `scoped`) and only to hide more. Pages reached by their own link (an item, a batch, a job, an agent run, a security finding), search, settings and every write show every repo the user may see.

### Stats (progress)

- Org totals at the top: open now, done by the pipeline since tracking began (merged / closed), closed by others, items closed per hour over the last 24 h, items waiting for an answer. Steps the pipeline hasn't reached yet say "not started yet".
- Funnel chart for the org, then a table with one row per repo (sortable by open count, done count, waiting for an answer).
- Breakdowns: type label, size bucket (S ≤ 50 changed lines, M ≤ 300, L ≤ 1,000, XL above), contributor tier.
- Trend: open items per repo per day since tracking began (from `items` created/closed dates).

### Repo (`/repo/<name>`)

Same blocks as Progress, filtered to one repo, plus what waits for an answer and its batches.

### Items (`/items`)

One list over every item of the visible repos, narrowed to the picked project. The server filters, sorts and pages it (`GET /api/maintain/browse`, 50 rows a page); the browser never holds more than a page.

- **Search box.** Words go to the full-text index of titles and bodies; `#123` matches the number. Qualifiers, GitHub style, with comma lists for "any of" and a leading `-` to negate (grammar in `src/core/item-query.ts`):

| Qualifier | Values |
|---|---|
| `is:` | `pr`, `issue`, `open`, `closed`, `merged`, `draft`, `outside` (author is not an owner, member or collaborator), `mine` (I started, approved, held or answered it), `asked` (its open question is mine), `approved` (approved for merge), `duplicate`, `outside-held`; operators and maintainers also `security`, `stuck` |
| `label:` `author:` `repo:` `area:` | names; `area:none` |
| `priority:` | `P0`–`P4` (the rated level) |
| `kind:` | classification: `bug`, `feature`, `perf`, `extra`, `plugin`, `infra` |
| `size:` | `S`, `M`, `L`, `XL` (pull requests, by changed lines) |
| `discord:mentioned` | mentioned in a watched Discord channel |
| `has:` / `no:` | `pr`, `label`, `priority`, `area`, `kind`, `discord`, `response` (a comment by a maintainer of the repo) |
| `ci:` | `green`, `red`, `pending` |
| `review:clean` | the model review of the current head is a sure take |
| `autocraft:` | `running`, `waiting` (for a person), `stopped` (only the automatic merge rule started it and it stopped: it asks nobody), `held`, `backlog`, `done`, `none` |
| `sort:` | `updated` (default), `created`, `comments` (comments and reactions), `priority`, `discord`; `-asc` reverses |

- **Words or Meaning.** By meaning, the words are embedded and matched by similarity (at most 100 hits, best first); the qualifiers still filter the hits and no sort applies.
- **Views** set the whole query: Open, New with no labels, Most discussed, On Discord, Bugs to fix, Ready to merge, AutoCraft working, Waiting on a person, Outside contributors waiting (oldest first), Duplicates, Mine. Each shows its count.
- **Quick filters** (Repository when no project is picked, Type, State, Label, Priority, Area, Author, AutoCraft, Discord, Sort) rewrite one qualifier of the query. On phones they open in a sheet.
- The query is the URL: `/items?q=is:open+label:bug`. A qualifier the server does not apply (unknown, a bad value, or not allowed for the reader) is listed as not applied. Older links (`filter=mine`, `show=closed`, `discord=1`, `area=`) open the matching query.
- **Rows**: kind and state icon, `repo#number` and title, the "Asks you" marker, AutoCraft's state in one word, priority, Duplicate, labels, classification, size, area, author (marked when outside), updated time (opened time when sorted by creation), CI, comment count, Discord mentions and the linked PR or issue. Arrow keys, `j`/`k`, Home and End move the focus between rows.
- People who may send commands tick rows to fill the command box with the list form.

### Item (`/items/<repo>/<n>`)

Title, link, author with tier, size, CI, mergeable state; the stage timeline; every classification side by side (classifier, type, want, reason); its workflow events; related items. This is where detail lives so cards can stay short.

Queued work about the item (a queued job whose `number` is the item, and every queued model call that names it) shows at the end of the chat, oldest first: the stage, "queued" with the time, and one line that says what holds it back. The line comes from the rule that holds the work back (`src/runner/why-queued.ts`), so it never disagrees with what happens:

- A job, in the order of the runner's start pass: the pipeline is draining or off (automatic jobs), "Waiting for another job on this item" or another job of the step (its repo named only to operators and maintainers) or a step of the same mutex, the step at its most repos at once, the taker rule ("No Task Runner takes photocraft"), and with a job of the step running, the room of the Task Runners that would take its calls. The runner's job ceiling and the slot of a job still preparing its call are known only inside the runner process, so a job held back only by them shows no line.
- A model call: the Work queue's line for it (picked, the session's runner, the user it is bound to, the people whose started work it is, "login renews at hh:mm UTC", no ready runner, every runner busy, the calls ahead).

Work no rule holds back gets no line. A line that names a person's Task Runner ("Waiting for mira's Task Runner (usage limit until 05:10 UTC)", "Held for mira's Task Runner: the work is theirs") names it for operators and maintainers; a viewer reads "Waiting for a Task Runner". The item's state line in the header follows the same rule. A quiet pull request shows a viewer no queued work. The page reads the chat every 20 seconds while work is queued, and every few seconds while a step runs. The agent's `get_item` (`queued`) and `autocraft-server workflow status <repo>` give the same lines.

Under the queued work, a maintainer with write access or an operator who has a Task Runner, and who did not start or approve the item, gets a "Run on my Task Runner" button while work about the live item is queued that one of their Task Runners could run (it offers the tier of a queued call, as it last reported). It sends `take`, so the item's work runs on their Task Runner too while the starter's Task Runners cannot take it (see Started work on its owner's Task Runner in [pipeline.md](pipeline.md)). While their take stands the button is "Release my Task Runner" and sends `release`. Operators and maintainers read "Running on <login>'s Task Runner" there for every take on the item; viewers see neither the line nor the button. The command and AutoCraft's reply show in the chat like any other command.

### Contributors

Table: login, tier (whitelisted / not / override allow / override deny), merged PRs, closed unmerged, open, merge rate, last merge, repos. Filter by repo and tier; sort by any column. Allow / deny / clear buttons with an optional note. The whitelist rule (`settings.whitelist_min_merged`, `settings.whitelist_min_merge_rate`) shown and editable at the top. Notes on overrides are private. A tier belongs to a GitHub account, not to the login string, which can pass to another account: a PR counts for the account id it was opened by, and PRs mirrored without an id count for the account the login's oldest merged or closed PR was by (looked up once; until then they count for nobody). An allow is given to the account that holds the login when it is set; a deny holds for every account under the login, in any letter case. Counts and tier are those of the account the login is bound to; an allow given to another account (or recorded before accounts were stored, with no binding to match) shows as "allow not in effect".

### Classifiers

Agreement between classifiers on the same items (for the Jev vs Haiku trial, later Sonnet as the reference): per field (`type_label`, `want`), an agreement rate and a confusion matrix, with a link to the disagreeing items.

### Access (operators)

Access list with add, remove and role change; active sessions with revoke.

### Discord (operators)

A setting; the pipeline does not depend on it. The bot's connection state, the servers and text channels it reports (names and IDs) with a switch per channel for watching (threads and forum posts follow their parent channel), the contact text for deletion requests, and a link to the public privacy page. Only operators can open the page or change anything; the writes are audited (`discord-watch`, `discord-unwatch`, `discord-contact`).

The item page shows a "Discord N" badge in its header and, in the details, a list of message links (`discord.com/channels/<server>/<channel>/<message>` with the time). Counts are visible to everyone who sees the item; the links are decrypted on the server and need the key file in the dashboard's environment, otherwise only the count shows. The Items page shows the count on each row, sorts by it (`sort:discord`) and filters by it (`discord:mentioned`).

`/privacy` and `/terms` are the pages outside sign-in: what the bot reads, what it keeps, what it never keeps, and how to ask for deletion.

### Audit (operators and maintainers)

The audit log, filterable by login and action. Maintainers get only listed actions, and none for accounts or access (access changes, session revokes, sign-ins, account changes and logins); an action nobody listed stays hidden from them.

### Cost

Per stage and model: agent runs, items handled, tokens (input, output, cache), tokens per item. Per repo: items done and tokens spent. The experiment's headline numbers: issues and PRs closed, merged, fixed by us, by size; recommendations given and answered; items still needing a human.

### Pipeline (`/pipeline`)

The stages of the pipeline with each one's state; the On/Off switch and the daily limits with use today; below the daily limits, one row per tripped circuit breaker of a push stage (fix-up, CI fix, fix issue, merge), naming its repo, or all repos for a trip on every repo, with the reason, the time and Resume for those who may resume it (a repo's trip leaves the stage running for other repos; the Stopped tab of Needs lists the same rows); the job list (live), each job's settings, progress, result, token use and the end of its log; recent sync runs. Everyone signed in sees it; operators also turn the pipeline on and off, change limits and cancel jobs. Architecture: docs/pipeline.md.

### Deep scans (`/security/scans`, `/security/scans/<id>`)

Operators and maintainers only (other readers get 404). The list shows every scan of the repos the reader can see, newest first, filterable by repo (`?repo=`): state badge, repo, spent of cap, areas done, findings, who started it and when. A scan page shows the scan header (state, progress bar, spent, estimate, cap; Stop for whoever may stop it while the scan is active), the threat model (summary, entry points, areas with risk, state and cost), the model calls in order (kind, area or finding, state, time, cost, a progress line for the running one; each opens to the run's prompt and output and links to its Agents page) and the findings, each linking to its finding page. Both follow the live topics, with no refresh. The nav lists "Deep scans" under Insight for staff; the repo page's Security part links to the list for its repo.

### Agents (`/agents`, `/agents/<run>`)

An agent run is one model call: one `claude -p` call or one Jev batch request, made through the prompt registry. The page has three parts.

- **Running now**: every active run, refreshed every 5 s while the tab is visible. Each shows step and stage, model, account label (Jev has no account), the items it works on as `repo#n` links with "+N more", elapsed time and tokens so far.
- **Recent runs**: newest first, filtered on the server by step, account, state and repo, and read by keyset cursor ("Load more"); the page never shows a total. A run opens a detail panel (a bottom sheet on phones) with the rendered prompt (collapsible; its registry id and version link to the Prompts page), the output, the error, token counts and a link to the job. Prompt and output are kept for ten years; after that the panel says "Prompt text removed after ten years".
- **Refused** (operators and maintainers; `?refused=1&window=24h|7d|30d`, 7 days by default): the runs a model's safety filter declined, whether the call's retry on another Task Runner or tier then succeeded or not. Above the list, the refused runs of the range are counted per prompt, repo (a run's first item), model as the harness reported it and Task Runner user, each with how many had no other Task Runner or tier to take the call, so a cause they share stands out. Each row shows what the retry came to (its state, linking to the retry's run, or "Not retried"); the detail panel says the same and shows the refusal text in the error. Refusals recorded before runs kept their remote call show no retry run.

### Build environments (`/envs`, `/envs/<task>`)

Operator navigation group; everyone signed in reads. Concept and trust rules: [pipeline.md](pipeline.md#build-environments-and-tasks).

- **Environments**: one card per environment (everyone sees enabled ones; operators also see disabled ones): label, kind, Online / Offline / Disabled, a Paused badge with the worker's reason, a Confidential badge, slots in use of total, the machine (os, arch, cpus, memory, disk, display, GPU), toolchains, worker version and last seen. Operators add an environment (id, label, kind, slots, confidential), edit label, slots, enabled and confidential, and rotate the key. Confidential (set only by an operator) means the environment takes the security lane's private tasks and no PR code (operations.md, Confidential environments). The key appears once in the response, with a Copy button, and is never listed again (`POST /api/envs`, `PUT /api/envs/:id`, `POST /api/envs/:id/rotate-key`; audited).
- **Caches** (`GET /api/envs/caches`, everyone signed in; keys of repos the viewer cannot see are left out): one tab at a time (`?caches=nodes|placement|mirror`), each with its count and a warning icon when something in it needs attention. Repositories: the published warm version (Up to date, Behind main, Old toolchain image, Not built), size, nodes holding it, warm target, coverage when not a pipeline repo, and the last warm build with its state, summary and task link. Nodes: Reporting or Stale with the status time, disk use bar, warm bytes, keys held (Older version, Not placed here), pending keys with the reason, bad blobs, agent error. Placement: per key, its nodes with holds it / older version / not yet. Crate mirror: the git allowlist, when it was read and the environments that use it. Details in operations.md (Caches report).
- **Recent tasks**: newest first, filtered on the server by state, environment and repo, read by keyset cursor (`GET /api/tasks?state=&env=&repo=&cursor=`). Tasks of repos the viewer cannot see are left out. A task opens a detail panel (a bottom sheet on phones): steps with network mode, exit code and duration, summary, the log tail (plain text, labelled as output from the build environment) and artifacts with download links (PNG shown as a thumbnail). Operators cancel a queued or active task (`POST /api/tasks/:id/cancel`; audited).
- **Summary**: queued and running tasks and free slots (`GET /api/build/summary`).

### Workspaces (`/workspaces`, `/workspaces/<id>`)

Settings navigation group; everyone signed in opens the page, for repos they can see. The list (`GET /api/workspaces?state=live|all&cursor=`, newest first, keyset-paged) shows per workspace the repo and commit, state, the item of its first session (`ItemRef`), node, how the target started (the warm version copied, or "started cold: <why>"), age and the cost of its sessions' model calls. Live is the default; All adds ended and failed ones (`?show=all`). A workspace opens `/workspaces/<id>` (`GET /api/workspaces/:id`): the header facts (commit, app, state and since when, node, warm start, error), the sessions (who they ran for, outcome, cost, the model's reply, a link to the job, the prompt on request) and the call log (`GET /api/workspaces/:id/calls?before=`, 60 per page, oldest first, "Load earlier calls"). A call row shows the tool, its short argument (the shell command, the path, the app binary), duration and a Running or Failed badge; it opens to the output as stored (text in monospace, long output cut in the middle) and a screenshot opens full size (`GET /api/workspaces/:id/calls/:call/image`, sandboxed, served from the call's stored result, never inlined in JSON). A screenshot whose bytes were not kept (past the session's 60 kept images, or 30 days after the workspace ended) shows as "Screenshot not kept (N bytes, sha256 …)" with the reason, and its image endpoint answers 404. Running calls update through the `workspaces` live topic, which is not planner input. Operators and maintainers with write on the repo see errors, prompts, replies, outcomes, costs and the call log; everyone else gets the header, the sessions' state and the item link only, and the calls and image endpoints answer 403. The page is read-only.

### Repo settings (`/repos/<name>`)

Operators and maintainers. Besides the Pipeline switch, the GitHub writes and the optional checks, a tracked repo has a **Build features** block: one switch per feature, each with one line saying what it does. It lists only the features an enabled build environment can run (`shownFeatures` in `src/build/features.ts`): Tests before push, Build batches and Implement queued issues always; Screenshots while an enabled environment reports a display; Nightly checks while one reports a nightly check's toolchain (rust-audit, rust-cross or rust-nightly). Build pull requests (CI stays in GitHub Actions) and scan tests (a confidential environment) keep their code and stored switches without a dashboard switch. An operator, or a maintainer with write permission on the repo, flips a switch; others see On or Off. The global Pipeline switch stops every feature, since each runs inside a pipeline job.

### Rates (`/rates`)

Items moved per stage per hour (last 24 hours) or per day (last 7 days), with runs and failed runs, drawn as one small chart per stage; and each account's 5-hour and weekly use over time as lines on a 0 to 100 % scale with each window's pause level marked. A table view gives the stage totals as text. The charts redraw to the container width and stay readable at 390 px.

## Behaviour

- Writes (answers, overrides, settings, access) go through POST endpoints that check the reader's permission, validate input and write one row plus one audit row; each records the signed-in reader's GitHub login.
- **Answers come from a person.** Every command runs under the act rule, whoever's surface it arrives on (GitHub, Discord, the dashboard, an agent with the person's own token), and is kept with who and where. The CLI may edit the whitelist and access list.

## Accounts and access

The whole dashboard sits behind GitHub sign-in: every page, asset and endpoint except the sign-in routes returns a redirect to sign-in (pages) or 401 (everything else) without a valid session. Nothing about the data, not even repo names or counts, is visible before sign-in.

### Who can sign in

- Only GitHub logins on the **access list** (`access` table: `login`, `role` = `operator` | `maintainer` | `viewer`, `added_by`, `added_at`, `note`, `github_id`). A login not on the list sees a plain "not authorised" page after GitHub's redirect, and no session is created.
- Operators add and remove logins on the Access page or with `autocraft-server access add <login> [--operator|--maintainer] [--note]` / `access remove <login>`. The first operator is added with the CLI.
- Removing a login or changing its role ends its sessions at once.
- Access is bound to the numeric GitHub user id, not only the login. The id from `GET /user` is stored in `github_id` at the login's first sign-in, and every later sign-in must present the same id. A different id (a renamed or released login taken by someone else) is refused like an unlisted login and audited. Removing and re-adding a login clears the binding.

### Trust boundary

The pipeline runs Claude agents under the operator's own Claude account on the operator's machine, and the operator is responsible for what they do. So nothing a dashboard user enters may steer the pipeline unless the operator has approved it, and a compromised dashboard account must not be able to cause harm.

- **Operator**: one or more logins with role `operator`. Operators manage the instance (access, settings, limits, prompts, environments, the GitHub identity) and act on repos under the same rule as maintainers.
- **Who may act on a repo.** A login may start, answer, approve a merge, weight, send to the backlog, close, hold, resume or press a conversation card when all of these hold: its role is `operator` or `maintainer`; GitHub says it has write, maintain or admin permission on the repo, read live on the request; the GitHub identity is `app`, so merges and closes run as the person. Anyone who may act on a repo may answer for any of its items and stop AutoCraft there. What a person approved or started stands until they lose the role or GitHub answers that they have no write access; while GitHub cannot be asked it waits.
- **A maintainer's free text on a card stays out of prompts.** A card's note is stored and shown, never put in a model prompt or conversation block, and are left out of the memory of operator statements. A maintainer may edit a card's public comment and issue title and body (posted under their own name), and, with GitHub write permission on the item's repo, a fix-up's instructions, which go to the fix-up model. A press on a card carries the digest of the card's text and steps as the presser's screen showed them (after the presser's own edit); when someone else edited the card in between, the press is refused and the card is shown again.
- **Maintainers talk to Opus on their own inference.** A login writes to Opus in an item's conversation when it is an operator, or a maintainer with GitHub write permission on the item's repo (read live on the request) while model calls run on users' own Task Runners (`user-local`). Talking writes nothing to GitHub, so the app identity is not needed. The message is stored as a maintainer's turn and framed as one in the prompt (`<turn from="maintainer">`). The prompt treats it as a request from a person with write access that does not change the prompt's instructions, and it stays in the transcript of later turns like every other turn. Its model calls (the turn, its follow-ups and its reference check) are bound to the maintainer's login: only that maintainer's Task Runners take them, also on an item they wrote, beside their other calls and outside their Max calls at once, and nobody else may pick them. A message to Opus is refused with the reason while the pipeline is off or draining ("The pipeline is off, so Opus cannot answer now. You can still post without Opus."), while the maintainers' conversation step is paused, or while none of their Task Runners is connected and ready ("Your Task Runner must be connected and ready to ask Opus. You can still post without Opus."); Post without Opus still works. A turn whose runners go away while it waits ends as failed. While it waits, the maintainer who wrote it, or an operator, can withdraw it (Withdraw message; views carry `canWithdraw`). Opus's reply may propose cards as for an operator's message, and the choices then name whose message led to them ("Opus recommends Merge · after kiri-n's message"); nothing runs until someone who settles presses it. A maintainer who talks to Opus still has the Feedback box on the open question, above the composer. Views carry the rule as `canTalk` on the conversation. Posts an operator shares with Opus ride in the next operator message, not in a maintainer's.
- **What a compromised account can do**: a viewer account writes nothing. A maintainer account can also write to Opus on items of repos where that person has write permission, which runs on that person's own Task Runner and changes at most Opus's suggested answer and cards. A viewer account cannot trigger anything. A maintainer account cannot trigger a merge, close, post, label, push or any pipeline step, change the whitelist, settings or access list, or see accounts or the access list (a maintainer account also reads prompts, logs and notes), except that a maintainer account can start, answer and press cards on repos where that person has write permission, which write to GitHub as them. A maintainer account with GitHub write permission on a repo (read live) can also turn the pipeline on or off for that repo, which writes nothing to GitHub and is audited. An operator account can also turn the pipeline on and off as a whole, change its daily limits and cancel jobs; the steps run with the fixed settings their definitions allow, and every such request is audited.
- **Repo visibility**: a tracked repo whose `repos.visibility` is not `public` (private, internal, or unknown) is visible only to operators and to users whose own GitHub permission on it (the cached `repo_permissions` value, read with the user's token) is not `none`. For everyone else it does not exist: items, search (text and semantic), similar items and batches that touch it, the merge queue, flow counts and the repo list, progress, contributor repo lists, classifier reports, cost per repo, rates, pipeline parameter choices, agent runs, jobs and images that occur only in its text are all left out, and a direct request for one of them answers 404. Repos that are no longer tracked are left out the same way for everyone but operators. Text the planner stores once for every reader (waits, plan reasons) does not name an item of a hidden repo: a review held by hidden items waits for "another item, which blocks its review", and other such text is left out. An agent run recorded without items (an area proposal) is bound to no repo, so only operators see it; a duplicate comparison is bound to the items it compares. Per-repo counts add up visible repos only. Contributor tiers still count merged and closed pull requests in every tracked repo, because the tier is a pipeline policy.
- **Agent texts**: the prompt and output of an agent run hold item and comment text verbatim, so only operators and maintainers receive them (viewers get `null`). They are passed through the credential scrubber when stored. Viewers get no job logs. Maintainers get a job's log without the lines that name a repo hidden from them, and a job's summary, progress and error, and a sync's error, without text that names one (an error left out reads "failed"); a job without a repo works across repos, so this matters most there. Viewers read "failed" for a job or sync error.
- **What viewers can see**: public GitHub data and the pipeline's public-safe outputs. Private fields (override notes, answer notes, anything naming why a contributor gets extra scrutiny) are seen by operators and maintainers only and are never in the export. The item page shows viewers fix-up and verification states and the review verdict without job errors, model reasons or fix lists, and the merge queue, the Needs page and the item's trace header give them the same: no review reason, verification text, plan note or refusal text, and the plan's reasons without their quoted part. On a quiet pull request viewers get none of the staff text, Needs feedback included. Maintainers also see job logs, disabled build environments and every GitHub activity row, untracked repos included. Accounts (disabled accounts and sign-in logins), the access list, sessions and the access audit are operator-only.
- **Pipeline hygiene**: agents treat all GitHub content and all dashboard text as untrusted data. Briefs quote it as data and never as instructions.
- **Contributors' agents** (the MCP Connector, `POST /mcp`, see [docs/operations.md](operations.md#mcp-connector)) act with an MCP Connector token their user made, under that user's current role: they read what the user may read and, when the token may send commands, send the same commands the user could, under the act rule at the time of the call.

### What each person can do

| Action | Who |
|---|---|
| Read every page | anyone on the access list |
| Start, answer, approve a merge, weight, backlog, close, stop; press a conversation card | operator or maintainer, with write, maintain or admin permission on the repo on GitHub, under the app identity |
| Write to Opus in an item's conversation, Post without Opus | operator, or a maintainer with write permission on the item's repo; a maintainer's message to Opus runs on their own Task Runner (see Maintainers talk to Opus) |
| Make an MCP Connector token | operator or maintainer (audited); anyone lists and revokes their own |
| Make an MCP Connector token that may send commands | operator or maintainer (audited); lasts 7 days |
| Approve or deny a Task Runner's login; remove your own Task Runner | operator or maintainer (audited; operator-only audit rows) |
| Run on my Task Runner (pick a queued model call), Manual only | operator or maintainer; only on a call whose repos they have write permission on; operators clear anyone's pick |
| Whitelist overrides, whitelist rule, settings | operator |
| Access list, sessions, access-management audit rows | operator |
| Repo settings and the audit log (without access rows), read-only | operator or maintainer |
| Turn the pipeline on or off, change limits, start a job, cancel a job without a repo | operator; everyone signed in sees the Pipeline page |
| Per repo (the rule is `mayRunRepo`: an operator, or a maintainer with GitHub write permission on the repo, read live): approve labels, merging, CI runs, comments, pushes, issue fixes and red-main fixes; add or remove optional checks; switch the pipeline; switch its build features; cancel a job or build task of the repo; select its nightly checks and open the issue of a failing one; set up its screenshots; start or continue a deep scan with a spend cap (any positive amount), stop a deep scan and act on its findings (dismiss, backlog, fix, land, advisory) | operator or maintainer with write on the repo; others get 403 (a viewer gets 404 on security routes). The API returns `canManage`, `canSwitch`, `canAct`, `canStart` (security overview), `canContinue` (scan), `canCancel`, `canSelect`, `canOpenIssue` and `manageable` per repo or row, and the web reads them |
| Start or continue a deep scan without a spend cap | operator |
| Per repo and per item, on a repo the person runs: edit a fix-up's instructions, review, verify, fix or batch an item again, stop a fix, cancel or retry a pre-approval, remove a PR from a batch, stop a batch, release one held outside item, edit an area list, start area steps, accept or dismiss area proposals | operator, or maintainer with GitHub write permission on the repo (read live; a batch spanning repos needs write on each). `mayRunRepo` in `src/dash/repo-access.ts`; `GET /api/me` lists the repos in `runRepos`, and the interface reads it instead of the role |
| Backlog in bulk without a repo, release all items held for an outside author | operator |
| Resume a push-breaker trip (fix-up, CI fix, fix issue, merge) | a repo's trip (`<stage>:<repo>`): operator, or a maintainer with GitHub write permission (read live) on that repo; a trip on every repo (`<stage>`) and the outside-surge breaker: operator only (audited, the resume records the login) |

Roles on the access list: `operator`, `maintainer`, `viewer`. A `viewer` is read-only: every write returns 403 and the interface shows no write controls. A `maintainer` acts on the repos GitHub gives them write permission on, as an operator does.

GitHub permissions: after sign-in, read the user's permission on each repo with the user's own token (`GET /repos/storytold/<repo>` returns `permissions` for the authenticated user), cache it per user and repo for 10 minutes, and re-check at the moment of any write if the cached value is older than one minute. A user without any write permission still signs in and reads. The page says in one line why a person may not act.

### Sign-in flow

- A GitHub OAuth App with the authorization-code flow, `state` and PKCE. Request no scopes beyond what reading public repo permissions needs; if a private repo's permission can't be read, treat it as no write access.
- The OAuth callback URL, client id and public base URL are configuration, not code.
- Store the user's GitHub token only server-side (encrypted at rest with the session key) for permission checks; never send it to the browser or log it.

### Sessions and request safety

- Session id: 32 random bytes; cookie `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`; stored in SQLite as a hash with login, created, last seen, expiry (14 days, sliding, and at most 30 days after sign-in, 7 days for operators), user agent.
- Sign-out ends the session. Operators can see and revoke sessions on the Access page.
- Every POST carries a CSRF token tied to the session; reject a missing or wrong token.
- Rate-limit sign-in attempts and writes per session and per IP.
- `return_to` is resolved against the dashboard's own origin; a value that leaves it, holds a control character, a backslash or an encoded one, or resolves to a protocol-relative path becomes `/`. Only path, query and fragment are used.
- Security headers: a strict Content-Security-Policy (self only, no inline script without a nonce), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.

### Audit log

`audit` table: `at`, `login`, `action` (`override`, `rule`, `access-add`, `access-remove`, `session-revoke`, `mcp-token-create`, `mcp-token-revoke`, `sign-in`, `sign-in-refused` (anyone with a GitHub account can cause one, so there is at most one row per login per hour and `details.refused` counts the rest), `job-request`, `job-cancel`, `pipeline-switch`, `stage-limit`), `target`, `details` (JSON). Shown on the item page (that item's entries) and on the Access page (everything, filterable).

### Secrets and configuration

- The OAuth client secret and the session key are never in the repo, in logs or in error pages. The server reads them from a file named by `AUTOCRAFT_SECRETS_FILE` (mode 0600, JSON) and refuses to start if it's missing, readable by others, or incomplete.
- The GitHub App's keys (id, slug, private key, client id and secret, webhook secret, owner) are stored in the database (table `github_app`, one row), sealed with the token box derived from `session_key`, so every dashboard replica and the runner read the same keys without sharing a filesystem. Registering the app stores them; Remove clears them. A secrets file that still holds `github_app_*` keys is imported once, while no row exists; after that the file's app keys are ignored, except a non-empty `github_app_webhook_secret` for the same app id, which replaces the stored one at start. Each process reads the row again at most every 10 seconds, so registering or removing the app needs no restart; `AUTOCRAFT_GITHUB_APP_NAME` sets the suggested app name.
- Other configuration (base URL, listen address, port, database path) comes from environment variables, documented in the README with no values specific to one machine.

### Hosting for now

The server listens on 127.0.0.1 only; a private network proxy in front of it provides HTTPS. GitHub sign-in applies there too, so moving to a public host later changes only the configuration.

### Testing without GitHub

A fake OAuth provider for tests and local development, enabled only when `AUTOCRAFT_DEV_AUTH=1` **and** the server listens on a loopback address; it signs in as a login given in the test and serves configurable repo permissions. The server refuses to start with dev auth on any other address, or with `AUTOCRAFT_BASE_URL` set to anything but an `http://localhost` or `http://127.0.0.1` URL. In dev mode it also answers 403 to any request that carries `X-Forwarded-For` or a `Host` that is not a loopback name, and its default port (8994) differs from the real dashboard's (8993).

## Technology

- Server: TypeScript on Node 24, run directly with type stripping (no build step); `node:http` and `node:sqlite`. It serves the JSON API under `/api/`, the sign-in routes under `/auth/`, and the frontend.
- Frontend: a React app in `web/` (Vite, Tailwind, Radix primitives), described in `docs/ui-design.md`. `pnpm -C web build` writes it to `web/dist`, which the server serves behind sign-in: hashed files under `/assets/` with a year's cache, and `index.html`, uncached, for every other path, so the app routes on the client. It talks to the server only through the JSON API.
- Content-Security-Policy: the app gets `script-src 'self'` and `style-src 'self'` plus the hash of the one fixed `<style>` the Radix dialog's scroll lock injects; the sign-in and error pages use a per-response nonce. `img-src` is `'self' data:`. No CDNs or external requests from the browser: all CSS, JS, fonts and charts are served by the app, and GitHub-hosted images in bodies and comments come through the server's image proxy, `GET /img?u=<url>`. The proxy needs a session and fetches only an allow-list of GitHub image hosts and path shapes (redirects re-checked, IP addresses never fetched), and only URLs that occur in a mirrored body or comment of a tracked repo (a cached image is served only while its URL still does). It sends the token only to `github.com` attachment URLs, serves only raster image types (no SVG) up to 5 MB, within a timeout, with at most 4 upstream fetches at once and per-session and per-address rate limits, under `default-src 'none'` and `nosniff`. Expensive GETs (queue, contributors, semantic search) share a per-session token bucket (429 with `Retry-After`), embeddings run two at a time, and the contributors aggregate is cached for a minute; the README lists the rules and the token source setting (`AUTOCRAFT_IMAGE_TOKEN_FILE`).
- Light and dark themes via `prefers-color-scheme`; readable at 360 px wide without horizontal scrolling; touch targets at least 44 px.
- Performance at the real size (about 100,000 mirror rows including closed history, 25,000 open): every page renders in under 300 ms. Add the indexes the queries need.
- Nothing in the repo names a person other than as a GitHub login from the data, a machine, a hostname or a home directory: the repo may become public.

## Acceptance

1. A fixture generator writes data at the real scale (25,000 open items over 20 repos, 75,000 closed, 500 workflows, 2,000 stage rows, 40 overrides, token rows), and every page meets the 300 ms target on it.
2. Screenshots of every page at 390 px and 1,280 px, light and dark, reviewed by eye for crowding and overflow.
3. A recommendation answered on the page, and the item stopped and started again.
4. Private fields (override notes, answer notes) appear in no response to a viewer (grep for a marker placed in each private field of the fixture).
5. Access, with the fake provider: every route without a session redirects or returns 401; a login not on the access list gets no session; a viewer can read but every write returns 403; a maintainer can act only on repos where the fake provider grants write; a batch spanning a repo without write is refused; a POST without the CSRF token is refused; removing a login ends its session; the server refuses to start with dev auth on a non-loopback address or with a world-readable secrets file.
6. Tests for the funnel rules, whitelist tier precedence, and the access checks in item 5.
