# macOS root targeting

Fork notes for `nredd/pi-computer-use`. Contracts the macOS path guarantees.

## Target contract

- A root target is `{ pid, windowId?, rootRef?, windowRef? }`. `windowId` is present only when
  positive. An unpaired root (no matching CG window) has no `windowId`, never `0`.
- `rootRef` and `windowRef` are the same native ref. Every macOS helper call (`look`,
  `focusWindow`, `axWaitFor`) goes through `normalizeTarget()` in `src/platform/macos/backend.ts`,
  which sends only `windowRef`.
- The helper treats `windowId <= 0` as absent. A request with a `windowRef` and no usable `windowId` that no longer resolves fails; it
  never falls back to the app's first window. With a positive `windowId` it still pairs by id.
- Looks remember their `windowRef`, so `act` resolves the root by ref for unpaired roots.

## Capture

- Paired root: semantic and visual observation work.
- Unpaired root: semantic works. Visual `observe_ui` fails with `root_not_capturable`; use `mode: semantic`. The `act_ui` successor capture downgrades to semantic automatically.
  No other window is ever captured in its place.

## Modality

`isModal` is true for: a sheet child, role `AXSheet`, or `AXModal == true`. When the app does not
report `AXModal` at all, a dialog-like role/subrole still counts. An explicit `AXModal == false`
wins: Fusion's BROWSER sidebar (subrole `AXDialog`, `AXModal=0`) is nonmodal.

`act_ui` acts on, and captures the successor of, the root its state belongs to; it does not retarget to
a foreground modal. If a confirmed modal is in front afterwards, the result ends with a `Note:` line
naming it. Other tools (`observe_ui` without a root, `wait_for`, `read_text`) may still prefer a
confirmed foreground modal, so they can disagree with `act_ui` about which root is current.

## Post-action outcomes

Terminal `act_ui` results always say the action was delivered, and:

- `target_closed`, `cause: replaced`, `successors: [...]`: source root gone and new window, dialog or sheet
  roots of the same pid appeared and are still live (menus and popovers do not count). Observe a successor via `find_roots`.
- `target_closed`, `cause: closed`: source root gone, nothing replaced it.
- `post_action_observation_failed` with code `root_stale`: the root is still listed but the helper answers
  `root_not_found` for its ref (matched on the error code, not the message). A failed probe stays generic. Rediscover with `find_roots`.

## Ref lifecycle

Measured, not assumed:
- The helper stores native refs (`w<epoch>-<n>` roots, `e<epoch>-<n>` elements) in dictionaries with no TTL, no
  idle exit and no eviction (look records are capped at 8). A ref dies when its AX element dies (window closed)
  or the helper process restarts. The daemon does not exit when idle.
- Refs carry a per-process epoch, so a ref from before a helper restart never resolves; it used to be possible
  for `w3` from an old helper to name a different window in a new one.
- Helper restarts happen on reinstall, protocol/binary mismatch, permission relaunch. The extension's `@rN`
  records survive them, so `@rN` can outlive its native ref: expect `root_not_found` / "stale", then rediscover
  with `find_roots`. Refs from earlier sessions, pids and state ids are stale.
- Root deltas in `act_ui` results are rewritten to the extension's `@rN` refs. Before, they showed the helper's
  native ref with an `@` prepended (`@r2`) that was a different namespace from `find_roots`' `@r3` for the same
  dialog. A delta for a root that cannot be resolved shows no ref.
- Known limitation: the helper's element ref table grows for the life of the daemon.

## Helper lifecycle

The helper daemon outlives pi, so a reinstall alone leaves old code running. Two guards:
- `scripts/setup-helper.mjs` stops the running helper (`pkill -f '<bridge> serve'`) whenever it replaces the bundle
- `ensureProtocol()` restarts a daemon whose process started before the installed binary was written (`helperPredatesBinary`)

## Whole-desktop control

Both tools exist on macOS only, serialize behind one lock, and refuse when `headless` is true or
`desktop_control` is false (`PI_COMPUTER_USE_DESKTOP_CONTROL=0`). They are on by default.

`desktop_screenshot` captures a full display (cursor included, `display` 0 is main) and states the
image-to-point mapping. `desktop_input` posts physical HID input in global points: `moveMouse`,
`click`, `scroll`, `drag`, `typeText`, `keypress`. It moves the real cursor and types into whatever has
focus, so verify with a screenshot. Input goes to the *frontmost app*: raising a window
inside a background app is not enough (`focusWindow` can report `focused` while another app is frontmost),
activate the app first. `scroll` follows macOS natural scrolling: `scrollY: -5` arrives as a positive delta. Prefer `act_ui` for controls reachable by ref. Helper commands:
`captureDisplay`, `desktopInput` (wire actions `type`/`key`). Needs Screen Recording and Accessibility.

## Tests

`npm run test:macos-target`, `test:macos-native` (compiles the `PURE` region of `bridge.swift`),
`test:act-outcomes`, `test:desktop`. Swift glue outside the `PURE` region (`windowElement`, `look`,
`act`, `desktopInput` parsing) has no automated test; it was only exercised live.

## Real GUI validation

Run 2026-10-07 against existing Fusion (pid 32012) and Bambu Studio (pid 65354), fork `v0.5.1-nredd.1`
(`2c3dd8b`). Gotcha: the helper process started before the rebuilt binary was installed kept running
the old code; the sidebar still showed `modal` until the helper was killed and respawned.

Worked:
- Fusion BROWSER sidebar (`AXDialog`, `AXModal=0`, pairing low/10): `modal` on 0.5.1, nonmodal on the fork.
  Semantic observe of it works.
- `act_ui` press on the main window while the sidebar was up: delivered to the main window and the
  returned state was the main window (`@r2`), not the sidebar. Used the already selected Py radio, no
  design change.
- Bambu Cmd+O raised an "unsaved changes" prompt (`dialog`, modal, exact pairing). Escape cancelled it.
  `act_ui` reported the source root closed with no successor (`cause: closed`) and no fabricated state.
- Stale and bogus refs (`@r16` after the dialog closed, `@r99`) fail with a clear "stale" / "not available
  in this session, call find_roots" error.

Observed, not fixed:
- observe on a root ref can return a different `@r` (`@r16` -> `@r17`); refs are not stable across a dialog's life.

Not validated:
- An unpaired dialog (no `windowId`): none was available, every dialog seen paired. The `windowRef`
  forwarding and `root_not_capturable` paths are covered by unit tests only.
- `root_stale` and `cause: replaced` on a live app; ref expiry after long gaps (no TTL measured).
- Fusion batch (Py via SPACE, click console, type, RETURN) was not re-run.
- Bambu Cmd+I/Cmd+N dialogs.

### Whole-desktop tools (live, 2026-10-07, two displays, unreleased build)

Worked:
- `captureDisplay` on both displays (main 2560x1080 at 0,0; second 1920x1080 at 341,-1080, i.e. negative y); bad display index -> `display_not_found`
- `desktopInput` `moveMouse` lands exactly, including negative y on the second display; the returned `mouse` is read back in the same top-left global space
- In a scratch TextEdit document: click, unicode typing, `return`, `cmd+a`, `delete`, triple-click, drag-select (selected text confirmed via AX), scroll
- Invalid actions and arguments fail with `invalid_args`

Bugs found by the live run and fixed:
- Returned `mouse` came from `NSEvent.mouseLocation` (bottom-left origin) and was read before the move settled; now `CGEvent(source: nil).location` after a short settle
- Drags posted one event per waypoint; they now interpolate (<=12pt steps) with click state set



### Later live results (2026-10-07, final helper)

- Second display (global origin 341,-1080), via a probe window that logs the events it receives (`scripts/fixtures/event-probe.swift`): left,
  right and middle clicks, double click, unicode typing, `cmd+k` (command flag set) and scroll all arrive at the exact global
  coordinates sent, including negative y.
- Multi-waypoint drag selects text in TextEdit; a rejected drag leaves no button held.
- Real modal `NSAlert` (`scripts/fixtures/alert-app.swift`): ref-only observe works, visual gives `root_not_capturable`,
  `act` press by ref dismisses it; the `act_ui` dismissal reports `target_closed`. Opt-in script: `PI_COMPUTER_USE_LIVE=1 npm run test:macos-live`.
  It fails when `windowElement` is mutated to always fall back to the first window (checked).
- Fusion with the sidebar up: Py radio via SPACE, then click console field + `print(1)` + RETURN in one batch; the console shows `1`.
- Bambu Cmd+I: `act_ui` reports `New root: dialog "Open" (modal)` and a `Note:` that a foreground modal is in front. Background-delivered Escape
  returned outcome `unknown` and did not dismiss the panel; physical Escape via `desktop_input` did, once Bambu was frontmost.
- No natural unpaired dialog was found (the alert and Open panel pair with `low`/`exact`). The unpaired path is covered by the ref-only live
  runs above and by `scripts/check-unpaired-act.mjs` (stubbed backend).
