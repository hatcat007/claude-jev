# Thresholds for the completion check and memory curation

`eval/thresholds.ts` runs both judgments against the live Jev client on hand-written cases and prints, for each cut-off, how many positives it catches and how many negatives it wrongly flags: `node --experimental-strip-types eval/thresholds.ts`. It needs a Jev key and makes about 36 calls.

## Cases

- **Completion check:** 16 turns that stopped short of the request (finished part of a multi-part task, deferred the rest, asked permission for work already requested, described a fix without making it, reported work without running the requested verification) and 16 turns that were fine (finished and verified, a concrete blocker such as `EROFS` or `permission denied`, a decision only the user can make, a plain answer to a question).
- **Memory curation:** 16 lasting statements (standing preferences, project rules, facts about the user, pointers) and 16 messages that only matter in the session (one-off tasks, questions, acknowledgements). The eval applies the same eligibility filter as production (`candidates`: user messages of 25 to 1,200 characters), which leaves out 2 of the 16 one-off messages because they are too short, so 14 are scored. Calls use the production deadlines: 8 s for the completion check and 2.5 s for memory.

## Results, 2026-10-02, `jev-latest`, three runs

The table counts cases whose score reaches each cut-off. It does not run the save step, so it shows which cases would pass the threshold, not which notes would be written: production also keeps at most five notes per compaction, highest score first, and skips duplicates and messages the redactor would change. The sweep scores each turn by its raw probability and applies the stop-reason exemptions, so every row is measured at its own cut-off. The first run reported the 0.50 and 0.60 completion rows through the fixed 0.6 flag band, which could not see scores between 0.50 and 0.60, and it scored all 32 memory messages with an 8 s deadline. The figures below are from the third run, which fixes both; the earlier runs differ only where noted.

| Threshold | Completion: stopped-short turns at or above the cut | Completion: fine turns at or above the cut | Memory: lasting statements at or above the cut | Memory: one-off messages at or above the cut |
|---|---|---|---|---|
| 0.50 to 0.85 | 16/16 | 0/16 | 16/16 | 0/14 |
| 0.90 | 16/16 | 0/16 | 16/16 (15/16 in the first run) | 0/14 |
| 0.95 | 12/16 | 0/16 | 12/16 | 0/14 |

Memory at 0.90 is the only figure that changed between runs, so there is some run-to-run variation near the top of the range.

On these cases any cut between 0.50 and 0.85 gives the same result, and recall starts to fall at 0.90 for memory in some runs and at 0.95 otherwise, so the data does not pick one number. The block cut (0.85) and the save cut (0.8) sit at the strict end of that plateau on purpose: a block interrupts the user and a saved note persists across sessions, so a wrong positive costs more than a miss. The completion flag cut (0.6) is deliberately lenient, in the middle of the plateau, because a flag only prints one line and sends nothing to the agent.

## What this does not show

- The cases were written for this evaluation by the same author as the thresholds, and every one is a clear example of its class. Real turns are messier, so these figures are an upper bound, not a measured production rate.
- Thirty-two cases per feature is too few to put a false-positive rate on. Zero of 16 wrongly flagged means the true rate is plausibly anywhere under about 19% at 95% confidence (the rule of three: 3 divided by 16).
- The `stop_reason` exemptions (blocked, needs user, chat) are applied in these results and are what keep legitimate stops from being flagged.
- The live false-positive measure is the `kind: "completion"` rows in `jev-router-log.jsonl`: a blocked turn the user then accepted without change is a false positive. `/jev-stats` reports how many turns were blocked, flagged, or held back by the cap. Revisit the cuts once a few hundred real turns are logged.
