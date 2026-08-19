# `new-lynx` two-snapshot Lab campaign

This campaign creates the Lab entries `octane-new1` / `Octane (new1)` and
`octane-new2` / `Octane (new2)` from two independently resolved heads of
`Huxpro/octane:new-lynx`, separated by at least two elapsed hours. A checkpoint, completed Web
run, completed Native run, draft PR, or unchanged remote head is not the end of the campaign.

## Preconditions

1. Resolve and merge the user-identified Image #1 only after its exact PR/change identity is
   known and its merge gate is green. Do not infer the target from a screenshot that is absent.
2. Update this benchmark branch onto the resulting benchmark base without discarding unrelated
   work. Do not merge any benchmark result PR.
3. Confirm no other campaign owns the intended Sandbox serial or lease. Each snapshot gets its own
   official lease acquisition identity; a serial from another campaign is never reused.

## Freeze and run `new1`

1. Start the window exactly when freezing the first remote head:

   ```sh
   node scripts/new-lynx-snapshot-window.mjs start results/campaigns/octane-new/window.json
   ```

   The tool itself executes `git ls-remote --exit-code` for
   `refs/heads/new-lynx`, writes the full `new1Commit`, UTC/epoch start, and an exact +7,200,000 ms
   deadline using exclusive creation. Preserve this source file. Do not rerun or edit it.
2. Fetch the recorded full SHA into a clean, detached checkout. Verify detached `HEAD` equals
   `window.json.new1Commit`; never build a moving branch name.
3. Build all auto-row bundles with `scripts/build-octane-upstream.mjs`. Vendor only the frozen
   entry:

   ```sh
   VENDOR_ONLY=octane-new1 OCTANE_NEW1_BUILD=<clean-checkout> \
     node scripts/vendor-entries.mjs
   node scripts/verify-entries.mjs
   ```

   The resulting manifest must say `ref: new-lynx`, the exact frozen commit, no patch, eight
   checksums (Web + Lynx at 0/1k/10k/30k), and
   `nativeLab: { enabled: true, contract: native-lab-entry-v1 }` plus
   `webLab: { enabled: true, contract: web-lab-entry-v1 }`.
4. Run the complete Web matrix for only `octane-new1` with
   `pnpm bench run --harness web --lab-web --entry octane-new1`. Preserve the immutable source run and
   verify `meta.entryCommits.octane-new1` equals the manifest commit.
5. Acquire and clean up a new official Sandbox lease through the audited wrapper. Give each run a
   brand-new evidence directory; existing directories are rejected. The wrapper POSTs with the
   traceable issuer/issue ID, connects only the returned serial, writes a structured receipt,
   passes both legacy and strict-runner receipt environment variables, and in `finally` always
   DELETEs that exact URL-encoded serial before disconnecting it:

   ```sh
   SANDBOX_ISSUER=<owner> SANDBOX_ISSUE_ID=<unique-new1-issue> \
     node scripts/run-sandbox-lab.mjs octane-new1 \
       results/local-evidence/octane-new/new1-sandbox
   ```

   Do not add matrix or repetition overrides. The command checkpoints after each cell but succeeds
   only with the exact 35-cell contract. DNF cells remain valid evidenced observations; missing
   cells do not. Preserve the wrapper's acquisition, receipt, runner, DELETE, disconnect, and
   outcome artifacts. This raw-serial evidence root is gitignored and must not be committed or
   pasted into a PR. A runner success with DELETE/disconnect failure is still a failed campaign.
   If the strict lease-safety floor stops before all 35 cells, the wrapper fails closed after
   cleanup and records the checkpoint path. Acquire another official lease with a new issue ID and
   resume that exact file (the runner will reject a different physical serial):

   ```sh
   SANDBOX_ISSUER=<owner> SANDBOX_ISSUE_ID=<unique-next-lease> \
   SANDBOX_RESUME_CHECKPOINT=<absolute-checkpoint.json> \
     node scripts/run-sandbox-lab.mjs octane-new1 \
       results/local-evidence/octane-new/new1-sandbox-lease-02
   ```

## Deadline monitor and `new2`

Arm an external, inspectable timer/monitor for `window.json.deadlineUtc`; do not implement the wait
with `sleep`. Keep working or poll the timer while it is pending. At or after the deadline, run:
On SG1, use a named user transient timer so its next trigger and result remain queryable, for
example `systemd-run --user --unit octane-new2-head --on-calendar <deadlineSystemdCalendar> --working-directory
<benchmark-root> node scripts/new-lynx-snapshot-window.mjs check <window.json> <receipt.json>`, then
audit with `systemctl --user list-timers octane-new2-head.timer` and
`systemctl --user status octane-new2-head.service`. Use absolute paths in the real invocation.

```sh
node scripts/new-lynx-snapshot-window.mjs check \
  results/campaigns/octane-new/window.json \
  results/campaigns/octane-new/new2-head-receipt.json
```

The check rejects early execution, re-runs `git ls-remote` itself, and exclusively writes observed
epoch/UTC, elapsed milliseconds, the second full SHA, and whether the head changed. An unchanged
SHA is a legitimate second observation, not permission to skip `new2`. Repeat the clean detached
build, vendor, full Web run, and independent official Native lease/campaign for `octane-new2`.

## Prompt-to-artifact completion audit

Before claiming completion, verify every item directly from artifacts:

- Image #1 exact target was merged and the benchmark base contains it;
- window start and new2 receipt exist, `elapsedMs >= 7200000`, and both SHA values came from the
  tool's own remote reads;
- both manifests identify their exact commit and all eight bundle checksums verify;
- both complete `web-lab-entry-v1` Web source runs match their manifest commit and required cells;
- both Native source runs match commit + `native-lab-entry-v1` hash and contain exactly 35 cells,
  with DNF evidence retained where applicable;
- both local lease acquisitions, DELETE responses, and exact-serial disconnects are recorded but
  not committed; publish only runner metadata that has already replaced the raw serial with a hash;
- collector exposes both Web Lab entries plus separate `nativeLabRuns/nativeLabRecords`, and no
  Native Lab record appears in featured comparisons/rankings;
- tests, entry verification, derived-cache equality, and production site build pass;
- draft stacked PRs are published in the requested order and none is merged.
