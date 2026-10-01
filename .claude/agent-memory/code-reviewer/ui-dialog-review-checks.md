---
name: ui-dialog-review-checks
description: Recurring failure modes to check when reviewing native <dialog>/modal UI in ai-team-hq (top layer, inert, nested dialogs, CSS layers, close requests)
metadata:
  type: reference
---

Checks that found real bugs in the 2026-10-01 ticket-modal review (PanelModal, ReportReader):

- Anything outside an open modal `<dialog>` is inert and below the top layer: bottom-left Flags (the only error channel for ticket actions) become unclickable and unannounced. Check where feedback renders when a modal is open.
- Inner Modals (ReportReader, ImageViewer) are DOM-nested inside ticket sections, so descendant selectors in `@layer views` (e.g. `.ticket-section p`) apply inside them and beat `@layer markdown` (layer order in src/styles/tokens.css). Verify against the built CSS in dist/assets.
- Dialogs only `preventDefault` on `cancel`; Android back is a close request that can close the dialog natively without React knowing. Look for a `close` listener that syncs state.
- Props computed only while a panel is open (e.g. returnFocus) are already gone on the closing render; keep last values in a ref.
- Module-level fetch caches keyed by URL (ReportViewer) go stale when desks rewrite the same report file.

Related: [[review-conventions]].
