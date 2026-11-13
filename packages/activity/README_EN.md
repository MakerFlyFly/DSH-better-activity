# BetterActivity

English · [中文](README.md)

Version 0.2.0 provides a recent-activity dialog on unmodified DSH 0.2.2-rc.2. Installation requires no host patches or source build.

## Usage

The sidebar footer shows the bell and “View activity” when expanded, or the bell in the collapsed rail. Ctrl+Alt+U toggles the dialog; macOS uses Command+Option+U. Escape, the close button and the outside mask dismiss it. The current conversation and ordinary browser stay mounted. Each window retains visibility, pagination and scroll position.

Rows show titles, project names, two-line public assistant summaries and status. Priority order is pending interactions, unread failures, running work, then unread completions. Other conversations use local calendar groups. Streaming text does not reorder rows. Blank and archived conversations stay hidden; children aggregate only under a valid unarchived ordinary parent. Pending entries open the child that needs action.

Rows use native navigation and context menus. Opening a conversation closes the activity dialog. Native global search retains its existing behavior and focus; the activity dialog yields to it. This plugin adds no search field or keyword filter.

## Read state and summaries

Automatic acknowledgement requires the current foreground conversation to be visible, unobscured by an activity dialog, another modal or fullscreen right panel, and to contain the corresponding end event in the native published conversation timeline. It uses no guessed delay or running-state substitute. “Mark all as read” acknowledges only result versions already observed by the list; running and pending work remains prioritized.

The better_activity domain preserves installedAt and per-conversation read positions across upgrades, reloads and restarts. Windows on the same instance share read state; separate instances have no cloud synchronization. Historical completions from before first installation start as read. Failed writes preserve unread state, and disconnections retain rows with a retry action.

The betterActivity projection uses public assistant text, not reasoning or raw tool output. Summaries default to 240 Unicode code points and recover in bounded background batches without opening a complete conversation per Client row. Large uncached histories fill in gradually. Host options previewCodePoints, previewIntervalMs and hydrateBatchSize default to 240, 100 and 50; each accepts an integer from 1 to 100000.

## Installation and removal

Requires stock DSH 0.2.2-rc.2 and Node.js >=24.9.0. Use your runtime's CLI to install the prebuilt package; no git apply step is required:

```sh
dsh plugin --profile web add /path/to/dsh-better-activity-0.2.0.tgz
```

Desktop can use its plugin manager to install the same tgz. Refresh the interface after installation. This acceptance run covers the official Web runtime. Windows desktop UI revalidation is incomplete.

To remove it:

```sh
dsh plugin --profile web remove dsh-better-activity
```

Removal releases the launcher and dialog but retains read records. Upgrading from 0.1.3 does not migrate the read or summary formats. Existing patches in an older development checkout are not automatically reverted because other plugins may still depend on them.

BetterActivity does not depend on BetterClassifier or take its browser slot. BetterClassifier's own runtime requirements remain separate. See [compatibility.json](compatibility.json).

## Model experience and license

The plugin does not change prompts, tools, model requests, working directories, messages, model context or KV cache, and it makes no model calls to generate summaries. [MIT license](LICENSE). Generated Remote metadata ships with the package; its generator fix belongs only to the development tool environment.
