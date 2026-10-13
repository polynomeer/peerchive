# History reconstruction record

[한국어](HISTORY_RECONSTRUCTION.md) | **English**

This reconstruction was performed at the user's request on October 13, 2026. Both author and committer dates for the 2019 milestones were assigned in Asia/Seoul (`+09:00`).

**The 2019 history is a retrospective reconstruction, not recovered development logs.** The assigned dates and ordering do not establish actual development dates, sequence, or intermediate implementations. Every reconstructed commit explicitly identifies itself as retrospective.
Each milestone adds a group of final original files for preservation; it is not an independently runnable development stage.

## Original history and preservation scope

- Original HEAD: `97b5a9c363dee2a6441231c83bcb88e9a4319d05`.
- Original development snapshot: `92f14ceee51236286300e1cfc10e3b98dc8d201d`, the final cleanup of the May 2, 2020 bulk upload.
- Backup branch: [`backup/pre-reconstruction-20261013`](https://github.com/polynomeer/proofu-univ/tree/backup/pre-reconstruction-20261013). Both local and remote branches preserve the original HEAD.
- Additional backup created during reconstruction: `/private/tmp/proofu-before-reconstruction-20261013.bundle`. This temporary path is not durable storage; copy it elsewhere if long-term retention is needed.
- Reconstructed development history branch: `codex/reconstructed-2019` (local).
- The reconstructed history was applied to local and [remote master](https://github.com/polynomeer/proofu-univ/tree/master) on October 13, 2026. The remote backup branch was published first, then master was updated using `--force-with-lease` with the expected original remote HEAD.
- Immediately after publication, master was verified as `90a597d015d848e2b178345f591bdd8af8c20706` and the backup as `97b5a9c363dee2a6441231c83bcb88e9a4319d05`. Subsequent documentation commits are appended to master.
- The 103 existing subsequent commits, including 55 merges, were attached after the reconstructed milestones with their original parent topology and order. All trees, authors, author/committer dates, and messages were preserved. Commit hashes changed because parent references changed.
- The 11 original bulk-upload commits were mapped to the final reconstructed milestone. Existing application code, lockfiles, binaries, and distribution artifacts remain unchanged.
- Codex working instructions and analysis documents were added after the merge history in a separate commit dated October 13, 2026.

## Archive milestones

| Assigned date | Commit | Task | File count |
|---|---|---|---|
| 2019-06-03 | `54a6bf6` | chore: archive project manifests and build configuration | 8 |
| 2019-06-14 | `c299ec2` | feat: archive relational collaboration models | 1 |
| 2019-06-27 | `86c1c1b` | feat: archive JWT authentication service | 2 |
| 2019-07-05 | `bd29039` | feat: archive application shell and visual assets | 27 |
| 2019-07-16 | `da27b35` | feat: archive client API and Vuex state management | 6 |
| 2019-07-26 | `7136e35` | feat: archive authentication and profile screens | 5 |
| 2019-08-06 | `4f92fb4` | feat: archive team membership and join APIs | 3 |
| 2019-08-16 | `1b26cf5` | feat: archive team workspace screens | 3 |
| 2019-08-27 | `1c9e37a` | feat: archive board list and card APIs | 3 |
| 2019-09-06 | `50ffa55` | feat: archive Kanban board and list interactions | 6 |
| 2019-09-17 | `e038b2a` | feat: archive card editing and shared modals | 5 |
| 2019-09-27 | `dc08c03` | feat: archive navigation search and project dashboard | 8 |
| 2019-10-08 | `454ae9c` | feat: archive team chat and message persistence | 2 |
| 2019-10-18 | `be71b15` | feat: archive file uploads and code attachment screens | 4 |
| 2019-10-29 | `13b55e2` | feat: archive university notice integration | 2 |
| 2019-11-08 | `7dc8ccc` | feat: archive calendar interface and local state | 2 |
| 2019-11-18 | `c42017f` | chore: archive server wiring and demonstration data | 7 |
| 2019-11-29 | `6a9a2f5` | chore: archive distribution bundles and prototype variants | 6 |

Per-file milestone assignments and the full original-to-reconstructed commit mapping are recorded in [history-map.json](history-map.json).

## Verification and recovery

Run from the repository root:

```sh
python3 scripts/check_archive.py
```

The script checks original application file blobs, the reconstructed development snapshot tree, milestone dates, commit mappings, and all remapped parent connections and metadata. The root README is allowed to change as documentation. Passing these checks does not mean that the application runs successfully.

To inspect the original history locally:

```sh
git log backup/pre-reconstruction-20261013
```

To switch to the original snapshot, save any current working changes first, then run:

```sh
git switch backup/pre-reconstruction-20261013
```

This switches the checkout to the backup branch; it does not overwrite master or change the remote repository. The original history can also be browsed on the [remote backup branch](https://github.com/polynomeer/proofu-univ/tree/backup/pre-reconstruction-20261013). Publication of the reconstructed history is complete, and the backup branch is retained.

See the [English project analysis](PROJECT_ANALYSIS.en.md) for architecture, runtime limitations, and the original file inventory.

## Comment and example cleanup on October 13, 2026

Unused external links, commented imports, demo setup, and generic frontend instructions were cleaned up. Executable code, dependencies, required license notices, existing Git history, and backups were retained. The cleanup is appended as a subsequent commit and does not rewrite the reconstructed 2019 history.

[archive-cleanup.json](archive-cleanup.json) records the original and cleaned blob hashes for the seven changed files. The verification script checks the preserved original archive tree and history, then compares current working-tree files against the explicitly recorded cleanup hashes. Changes to other original files still fail verification. The root README is excluded as maintained project documentation.
