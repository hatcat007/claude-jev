# Thresholds for the completion check and memory curation

`eval/thresholds.ts` runs both judgments against the live Jev client on hand-written cases and prints, for each cut-off, how many positives it catches and how many negatives it wrongly flags: `node --experimental-strip-types eval/thresholds.ts`. It needs a Jev key and makes about 36 calls.

## Cases

- **Completion check:** 16 turns that stopped short of the request (finished part of a multi-part task, deferred the rest, asked permission for work already requested, described a fix without making it, reported work without running the requested verification) and 16 turns that were fine (finished and verified, a concrete blocker such as `EROFS` or `permission denied`, a decision only the user can make, a plain answer to a question).
- **Memory curation:** 16 lasting statements (standing preferences, project rules, facts about the user, pointers) and 16 messages that only matter in the session (one-off tasks, questions, acknowledgements).

## Result, 2026-10-02, `jev-latest`

| Threshold | Completion: stopped-short caught | Completion: fine turns flagged | Memory: lasting saved | Memory: one-off saved |
|---|---|---|---|---|
| 0.50 to 0.80 | 16/16 | 0/16 | 16/16 | 0/16 |
| 0.85 | 16/16 | 0/16 | 16/16 | 0/16 |
| 0.90 | 16/16 | 0/16 | 15/16 | 0/16 |
| 0.95 | 12/16 | 0/16 | 12/16 | 0/16 |

Both curves are flat from 0.5 to 0.85 and only lose recall above 0.9, so on these cases any cut between 0.5 and 0.85 gives the same result and the data does not pick one. The chosen cuts sit at the strict end of that plateau on purpose: a block interrupts the user and a saved note persists across sessions, so the cost of a wrong positive is higher than the cost of a miss. Block at 0.85 and flag at 0.6 for the completion check; save at 0.8 for memory.

## What this does not show

- The cases were written for this evaluation by the same author as the thresholds, and every one is a clear example of its class. Real turns are messier, so these figures are an upper bound, not a measured production rate.
- Thirty-two cases per feature is too few to put a false-positive rate on. Zero of 16 wrongly flagged means the true rate is plausibly anywhere under about 19% at 95% confidence (the rule of three: 3 divided by 16).
- The `stop_reason` exemptions (blocked, needs user, chat) are applied in these results and are what keep legitimate stops from being flagged.
- The live false-positive measure is the `kind: "completion"` rows in `jev-router-log.jsonl`: a blocked turn the user then accepted without change is a false positive. `/jev-stats` reports how many turns were blocked, flagged, or held back by the cap. Revisit the cuts once a few hundred real turns are logged.
