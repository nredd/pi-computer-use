# macOS root targeting

Fork notes for `nredd/pi-computer-use`. Contracts the macOS path guarantees.

## Target contract

- A root target is `{ pid, windowId?, rootRef?, windowRef? }`. `windowId` is present only when
  positive. An unpaired root (no matching CG window) has no `windowId`, never `0`.
- `rootRef` and `windowRef` are the same native ref. Every macOS helper call (`look`,
  `focusWindow`, `axWaitFor`) goes through `normalizeTarget()` in `src/platform/macos/backend.ts`,
  which sends only `windowRef`.
- The helper treats `windowId <= 0` as absent. A `windowRef` that no longer resolves fails; it
  never falls back to the app's first window.
- Looks remember their `windowRef`, so `act` resolves the root by ref for unpaired roots.

## Capture

- Paired root: semantic and visual observation work.
- Unpaired root: semantic works. Visual fails with `root_not_capturable`; use `image: never`.
  No other window is ever captured in its place.

## Modality

`isModal` is true for: a sheet child, role `AXSheet`, or `AXModal == true`. When the app does not
report `AXModal` at all, a dialog-like role/subrole still counts. An explicit `AXModal == false`
wins: Fusion's BROWSER sidebar (subrole `AXDialog`, `AXModal=0`) is nonmodal.

`act_ui` no longer redirects to a foreground modal. Actions and the successor capture stay on the
root the state belongs to; a modal that appears afterwards shows up in `rootDelta` as `appeared`.
`observe_ui` without a root may still prefer a confirmed foreground modal.

## Post-action outcomes

Terminal `act_ui` results always say the action was delivered, and:

- `target_closed`, `cause: replaced`, `successors: [...]`: source root gone and new roots of the
  same pid appeared. Observe a successor via `find_roots`.
- `target_closed`, `cause: closed`: source root gone, nothing replaced it.
- `post_action_observation_failed` with code `root_stale`: root still listed or unknown but the ref
  no longer resolves. Rediscover with `find_roots`.

## Ref lifecycle

Native refs live in the helper's `refStore` and are only valid while the helper process and the AX
element live. Refs from earlier sessions, pids and state ids are stale: rediscover with `find_roots`.

## Helper lifecycle

The helper daemon outlives pi, so a reinstall alone leaves old code running. Two guards:
- `scripts/setup-helper.mjs` stops the running helper (`pkill -f '<bridge> serve'`) whenever it replaces the bundle
- `ensureProtocol()` restarts a daemon whose process started before the installed binary was written (`helperPredatesBinary`)

## Whole-desktop control

`desktop_screenshot` captures a full display (cursor included, `display` 0 is main) and states the
image-to-point mapping. `desktop_input` posts physical HID input in global points: `moveMouse`,
`click`, `scroll`, `drag`, `typeText`, `keypress`. It moves the real cursor and types into whatever has
focus, so verify with a screenshot. Prefer `act_ui` for controls reachable by ref. Helper commands:
`captureDisplay`, `desktopInput` (wire actions `type`/`key`). Needs Screen Recording and Accessibility.

## Tests

`npm run test:macos-target`, `test:macos-native` (compiles the `PURE` region of `bridge.swift`),
`test:act-outcomes`.

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

Not tested live: clicking or typing on the second display, right/middle buttons, `drag` with more than two waypoints, scroll effect.
