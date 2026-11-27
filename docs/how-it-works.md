# How AutoCraft works

AutoCraft reads every issue and pull request in the tracked repos, sorts them, reviews the pull requests worth taking and merges the safe ones. Models do the reading. People answer the questions that need judgement.

## Sync

Copies every issue, pull request and comment from GitHub once a minute. It also reads CI on each default branch every two minutes and prepares the text for similar-item search. Nothing here needs a person.

## Duplicates

Finds items that report the same bug or request as another item. It compares each group and shows the result on the items. A duplicate closes nothing by itself. A pull request nobody started waits for a maintainer while another open or merged one duplicates it, unless the comparison keeps it.

## Classify

Gives each item one type (bugfix, performance, missing feature, small extra, plugin candidate or infra) and two flags: security and needs decision. Jev answers first. Haiku gives a second opinion when Jev is unsure. A referee settles what they disagree on.

## Priority

Rates each item from P0 (critical) to P4 and orders the work, highest first. Security items rank one level higher. Nothing to do here.

## Starting and answering

A maintainer starts an item with a command: review, fix-up, implement or merge. Small bug fixes from whitelisted authors start by themselves. When the steps are done, AutoCraft comes back with one recommendation; yes runs it, and any other command runs instead. Once the merge is approved, the item comes back only at a blocker.

## Label

Writes each settled type and flag to GitHub as a label. A label a person set is never changed. It runs only in repos where an operator approved labels.

## Review

Opus reads every wanted pull request at its current head, with read access to the repo. It gives a verdict and the complete list of fixes. It runs once CI is green. New commits or discussion bring it back for another review, at most every two hours and three times a day per pull request. The item page shows the review and its reasons.

## Implement

Implements an issue a maintainer queued: Opus plans it in a workspace on the queuer's Task Runner, asks the author or a maintainer when the issue leaves something open, writes the change and its tests, and opens a pull request after AutoCraft's own checks pass. A stuck attempt comes back with its options. It needs the repo's `implement` feature.

## Fix-up

Applies the small fixes from a review to the contributor's branch. It also repairs failing format or lint checks and reruns failures caused by infrastructure. If it cannot push to the branch, it comments with the list of fixes.

## Verify

Uses the repo's own CI as the check when the repo has CI. A repo without CI gets a build and test run in a sandbox. A model summarises any failure.

## Merge queue

Lists every taken pull request with one state, such as ready, waiting for CI or conflict. Pull requests that follow the merge rules go into batches of up to 50, which CI checks together. Opus reviews each one a last time, independently, before it merges. A pull request outside the rules waits for a maintainer's approval.

## Post-merge review

Opus reviews what actually landed when a pull request merged without a person's approval, or when AutoCraft changed its code after the approval. A pull request that merged as a person approved it gets no such review. Each defect that no open item covers becomes a follow-up issue. Minor findings are only shown.

## Security deep scan

An operator starts a scan of one repo's default branch. Opus looks for vulnerabilities an outsider can reach, checks each one and fixes it privately. Each fix lands as a pull request that does not say what it protects against. An operator starts every later step: Land, Advisory and Publish.

## Conversations

Each item can have a conversation with Opus on its page. Everyone with access to the repo can read it. Operators write, and so do maintainers with write access to the repo; a maintainer's messages are answered on their own Task Runner. Opus answers with read-only access to the repo.

## What needs a person

Nothing runs on an item nobody picked, except the small bug fixes above. These wait for a person:

- **Starting an item**, or leaving it.
- **The recommendation** of a started item that is not approved for merge.
- **A blocker** of an approved item: a major finding, someone else's commits that the review finds beyond what was approved, a step that failed twice, a fix larger than agreed. Someone else's commits are reviewed first; the approval stays.
- **A merge** outside the merge rules.
- **A close** that could not be made.

Operators and maintainers with write access on the repo answer, on GitHub, Discord, the dashboard or with their own agent. Viewers only read. When nobody answers, only that item waits.
