## Sync

**What.** Copies every issue, pull request and comment of the tracked repos from GitHub, then prepares each title and body for similar-item search.

**When.** Every minute. CI of each default branch is read every two minutes, even when the pipeline is off.

**Model.** None.

**You see.** Fresh items on the Items page within a minute or two.

**Can go wrong.** The copy can be a few minutes behind GitHub. Every later stage checks the live state on GitHub first and skips an item that changed.

## Duplicates

**What.** Finds open items that describe the same bug or request as another open item, or one closed in the last year, and compares each group.

**When.** After Sync, for new or changed items.

**Model.** Jev first, Haiku for the unclear pairs.

**You see.** A duplicate signal on the items. It closes nothing and holds back only a pull request nobody started.

**Can go wrong.** A pair you already ruled on is not asked again.

## Classify

**What.** Gives each open item one type and two flags (security, needs decision).

**When.** For every open item, repos with the pipeline on first.

**Model.** Jev first, Haiku for a second opinion.

**You see.** The type and flags on the item. A disagreement on the type goes to a referee model; if it is unsure, the item gets the needs-decision flag and stays off the automatic path.

**Can go wrong.** When Jev is unavailable, Haiku decides alone.

## Priority

**What.** Gives each open item a level from P0 to P4, then orders the candidates of later stages by a work rank.

**When.** After Classify.

**Model.** A model rates the item; the ranking is plain arithmetic.

**You see.** The level on the item and the order of the work queue.

**Can go wrong.** Nothing a person has to fix.

## Starting and answering

**What.** A maintainer starts an item with a command (review, fix-up, implement or merge), and answers one recommendation when AutoCraft comes back.

**When.** Whenever someone picks an item. Small bug fixes that pass the merge rule start by themselves.

**Model.** None: commands are read without a model call.

**You see.** The recommendation on GitHub, Discord, the item page and in your agent.

**Can go wrong.** Text that is not fully understood runs nothing; AutoCraft answers with what it read.

## Label

**What.** Writes each settled type and flag to GitHub.

**When.** In batches, for repos with label approval.

**Model.** None.

**You see.** Labels on the GitHub item.

**Can go wrong.** Without approval, the stage only plans. A label a person set is skipped and reported.

## Review

**What.** Opus reviews every wanted pull request at its current head and gives a verdict with the full fix list.

**When.** After CI is green on the head, highest rank first. New commits or discussion bring a pull request back, at most every two hours (a setting) and three times a day; a maintainer's comment or Review again lifts the wait.

**Model.** Opus, with read-only tools in a sandboxed checkout.

**You see.** The review, its reasons and its history on the item page.

**Can go wrong.** A closed, draft or changed pull request is dropped and returns on a later pass.

## Implement

**What.** Implements a queued issue in a workspace: plans it, asks when facts or choices are open, writes the change and its tests, runs the checks and opens a pull request.

**When.** For issues a maintainer queued, in repos with the `implement` feature.

**Model.** Opus plans and writes, on the queuer's own Task Runner.

**You see.** A question to the author or a maintainer, then a new pull request, or a recommendation when the attempt is stuck.

**Can go wrong.** Checks that still fail after three rounds, a refused diff, a closed issue or a queuer without a ready Task Runner stop the attempt; it comes back with its options: try again, open as a draft, backlog or close.

## Fix-up

**What.** Applies the small fixes of a review to the contributor's branch, repairs failing format or lint checks and handles red CI on the default branch.

**When.** After a review that lists fixes, or when a check fails.

**Model.** Sonnet.

**You see.** A new commit on the branch, or one comment listing the fixes.

**Can go wrong.** If it cannot push, the contributor is asked. After two failed tries, it asks too.

## Verify

**What.** Records upstream CI as the verification of taken pull requests. Repos without CI get a build and test run.

**When.** After a take verdict.

**Model.** Sonnet plans a build when one is needed.

**You see.** The verify result on the item and in the merge queue.

**Can go wrong.** A private repo or a non-Rust repo without CI shows "not verified" and waits for an approval.

## Merge queue

**What.** Merges pull requests that meet the rules in batches, and the rest once a maintainer approves them.

**When.** Continuously, while the default branch is green.

**Model.** Opus reviews each pull request once more before it merges.

**You see.** Each pull request with one state on the Queue page, and the batch it belongs to.

**Can go wrong.** A red default branch holds every merge. A defect found in the last review becomes a fix-up or a question.

## Post-merge review

**What.** A second Opus review of a merge, reading what landed.

**When.** Once per merge that nobody approved, or whose code AutoCraft changed after the approval, oldest first. A pull request that merged as a person approved it gets none.

**Model.** Opus.

**You see.** Findings on the item, and follow-up issues for defects; or that the pull request merged as approved and needs no review.

**Can go wrong.** An invalid reply is asked again. After three tries the review is held.

## Security deep scan

**What.** Audits one repo's default branch for reachable vulnerabilities, fixes confirmed findings privately and lands each fix quietly.

**When.** Only when an operator starts a scan. It runs outside the daily pipeline.

**Model.** Opus, area by area.

**You see.** Findings on the Security page, visible to operators and maintainers.

**Can go wrong.** A scan stops at its spend cap, or when an operator stops it.

## Conversations

**What.** A conversation with Opus about one item, shown on its page.

**When.** When an operator or a maintainer with write access writes a message.

**Model.** Opus, read-only.

**You see.** The thread, with the latest tool step while Opus replies.

**Can go wrong.** A daily message limit applies.

## What needs a person

**What.** Starting an item, answering its recommendation, approving a merge, and blockers of an approved item.

**When.** As they come up. Operators and maintainers with write access on the repo answer.

**Model.** The review and the implementation plan write the recommendation.

**You see.** Home and the item page.

**Can go wrong.** Nobody answers: only that item waits. A close that could not be made is listed on Home.
