import { jevAsk } from "../adapters/afk/src/shared/jev-client.ts";
import { completionBundle } from "../adapters/afk/src/shared/questions.ts";
import { decide, ACT_BAND, FLAG_BAND } from "../src/completion.ts";
import { memoryQuestions, memoryState, verdict, MEMORY_THRESHOLD } from "../src/compact/memory.ts";

interface TurnCase {
  task: string;
  reply: string;
  short: boolean;
}

interface NoteCase {
  text: string;
  lasting: boolean;
}

const short = (task: string, reply: string): TurnCase => ({ task, reply, short: true });

const fine = (task: string, reply: string): TurnCase => ({ task, reply, short: false });

const TURNS: TurnCase[] = [
  short("Rename getUser to fetchUser in all 14 files under src and run the tests.", "I renamed it in the first 4 files. The other 10 files still use getUser and I have not run the tests."),
  short("Add input validation to all three signup endpoints.", "I added validation to the /signup endpoint. The other two endpoints can follow the same pattern."),
  short("Fix the failing test in auth.spec.ts and make sure the whole suite passes.", "I looked at auth.spec.ts and found the cause: the token expiry is off by one. Fixing it should make the test pass."),
  short("Migrate the config loader from JSON to YAML and update the docs.", "The config loader now reads YAML. I did not get to the docs update."),
  short("Write unit tests for every exported function in utils.ts.", "I wrote tests for formatDate and parseId. There are four more exported functions that still need tests."),
  short("Update the README install section and the CHANGELOG for this release.", "I updated the README install section. Do you want me to go ahead and update the CHANGELOG as well?"),
  short("Remove all uses of the deprecated logger and delete the old module.", "I removed the deprecated logger from the API layer. The worker and CLI packages still import it, so the module is still there."),
  short("Implement pagination for the orders list and the invoices list.", "Pagination is done for orders. Invoices is next, and I will plan it when you are ready."),
  short("Run the linter, fix every warning, then commit.", "I ran the linter and it reports 37 warnings. Here is a summary of the warnings by rule."),
  short("Refactor the payment module to use the new client and verify with the integration tests.", "I refactored the payment module to the new client. I have not run the integration tests."),
  short("Add the dark mode toggle to settings, the header, and the mobile menu.", "The toggle is in settings now. Should I continue with the header and the mobile menu?"),
  short("Find and fix all N+1 queries in the reports controller.", "I found two N+1 queries in the reports controller. I can fix them if you want."),
  short("Port the three shell scripts in tools/ to Python.", "I ported build.sh to Python. The remaining two scripts are left as they were."),
  short("Update every dependency to its latest minor version and make sure the build still passes.", "I bumped the dependencies in package.json. The build has not been run."),
  short("Add error handling to each of the five API calls in client.ts.", "I added try and catch around the first two calls; the rest are similar and can be done the same way."),
  short("Translate the strings file into Spanish and German.", "The Spanish strings are done. German is not started."),
  fine("Rename getUser to fetchUser in all 14 files under src and run the tests.", "Renamed getUser to fetchUser in all 14 files under src. The test suite ran: 212 passed, 0 failed."),
  fine("Fix the failing test in auth.spec.ts.", "The token expiry was off by one in auth.ts line 41. I fixed it and auth.spec.ts now passes along with the rest of the suite."),
  fine("Delete the old logger module.", "Deleted src/logger-old.ts and removed its three imports. Nothing else referenced it, and the build passes."),
  fine("Deploy the staging build.", "I cannot deploy: the deploy script fails with `permission denied` on /var/run/docker.sock, and my user is not in the docker group. Please add it or run the script yourself."),
  fine("Which database do we use for sessions?", "Sessions are stored in Redis. The connection is configured in config/session.ts."),
  fine("Add a retry to the upload function.", "Added exponential backoff with three retries to upload() in src/upload.ts and a test that covers a failing then passing call. All tests pass."),
  fine("Should I use a monorepo or separate repos for these two services?", "It depends on how often they change together. If most changes touch both, a monorepo avoids version skew. If they have separate teams and release cycles, separate repos are simpler. Which describes your case?"),
  fine("Set up the project with TypeScript.", "I need a decision before going further: do you want strict mode on from the start, which makes the existing JavaScript files fail type checks until they are fixed, or a gradual setup? I stopped here because it changes the amount of work."),
  fine("What does the retry middleware do?", "It wraps outgoing requests and retries on 502, 503 and 504 up to three times with a 200 ms backoff, then rethrows the last error."),
  fine("Fix the typo in the header comment of main.go.", "Fixed: 'recieve' is now 'receive' in the header comment of main.go."),
  fine("Update the lockfile.", "Ran npm install and the lockfile is updated. 3 packages changed, no vulnerabilities reported."),
  fine("Make the CI run on pull requests too.", "I could not edit .github/workflows/ci.yml because it is read-only in this checkout (EROFS). Remount it writable or give me a copy and I will apply the change."),
  fine("Explain why the build is slow.", "The build runs the type checker twice: once in the lint step and once in the compile step. Caching the first result would remove about 40 seconds."),
  fine("Add a health endpoint.", "Added GET /health returning {status: 'ok'} in src/server.ts, with a test. The suite passes."),
  fine("Rename the variable x to count in parser.py.", "Renamed x to count in parser.py (7 occurrences). No other file referenced it."),
  fine("Add the feature flag to all three services.", "Added the feature flag to the api, worker and web services, wired through each service's config, and ran each service's tests: all pass."),
];

const keep = (text: string): NoteCase => ({ text, lasting: true });

const drop = (text: string): NoteCase => ({ text, lasting: false });

const NOTES: NoteCase[] = [
  keep("Always answer me in short sentences and never use emojis in commit messages."),
  keep("In this project we never push directly to main; every change goes through a pull request."),
  keep("I am a backend engineer and new to React, so explain frontend patterns from first principles."),
  keep("Our staging dashboard lives at https://staging.example.com/dash and the on-call runbook is in Notion under Ops."),
  keep("From now on, always run the type checker before you tell me a change is finished."),
  keep("Do not touch the vendor directory in this repo, it is generated code and any change gets overwritten."),
  keep("I prefer small focused commits with the reason in the body, not one big commit per task."),
  keep("The database migrations in this project must be reversible, so always write the down migration too."),
  keep("Stop adding docstrings to every function; I only want comments where the code is not obvious."),
  keep("This repo targets Node 18, so never use features that need a newer runtime."),
  keep("Remember that I work in the Pacific time zone when you schedule anything."),
  keep("Use pnpm in this monorepo, never npm or yarn."),
  keep("When you review my code, point out security issues first and style issues last."),
  keep("Our bug tracker is Linear, project key PAY, and every commit message should reference the ticket."),
  keep("Never mock the database in tests for this project; we got burned when mocks passed and the migration failed."),
  keep("Please keep answers under ten lines unless I ask for detail, that is how I like every session."),
  drop("Please rename the function fooBar to bazQux in src/util.ts and rerun the tests."),
  drop("what does this error mean?"),
  drop("ok continue with the migration"),
  drop("Can you add a loading spinner to the orders page?"),
  drop("The build is failing right now on line 42, take a look."),
  drop("Run the tests again and show me the output."),
  drop("Thanks, that works. Now do the same for the invoices page."),
  drop("Why is this test flaky?"),
  drop("Commit that and push it to the feature branch."),
  drop("Undo the last change, I do not like how it looks."),
  drop("Let's try the second approach you suggested."),
  drop("Open the file src/api/client.ts and show me the retry logic."),
  drop("I am going to lunch, back in an hour."),
  drop("Update the version number to 2.3.1 in package.json for this release."),
  drop("Try again with a longer timeout this time."),
  drop("Looks good, go ahead."),
];

const STEPS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];

function pct(n: number, d: number): string {
  return d === 0 ? "-" : `${Math.round((100 * n) / d)}%`;
}

interface TurnScore {
  case: TurnCase;
  p: number;
  exempt: boolean;
}

async function turnScores(): Promise<TurnScore[]> {
  const out: TurnScore[] = [];

  for (let i = 0; i < TURNS.length; i += 6) {
    const batch = TURNS.slice(i, i + 6);

    const results = await Promise.all(
      batch.map((c) =>
        jevAsk(
          `The user's request: ${c.task}\n\nThe assistant's final reply this turn (end of reply):\n${c.reply}`,
          completionBundle(),
          8000
        )
      )
    );

    batch.forEach((c, k) => {
      const d = decide(results[k] ?? {});

      out.push({ case: c, p: d.p, exempt: d.exempt });
    });
  }

  return out;
}

async function noteScores(): Promise<{ case: NoteCase; p: number }[]> {
  const out: { case: NoteCase; p: number }[] = [];

  for (let i = 0; i < NOTES.length; i += 10) {
    const batch = NOTES.slice(i, i + 10);
    const cands = batch.map((c, k) => ({ i: k, text: c.text }));
    const answers = await jevAsk(memoryState(cands), memoryQuestions(cands), 8000);

    batch.forEach((c, k) => out.push({ case: c, p: verdict(answers, k).p }));
  }

  return out;
}

async function main(): Promise<void> {
  const turns = await turnScores();
  const shorts = turns.filter((t) => t.case.short);
  const fines = turns.filter((t) => !t.case.short);

  console.log(`completion check: ${shorts.length} stopped-short turns, ${fines.length} finished or legitimate stops`);
  console.log(`  chosen: block at ${ACT_BAND}, flag at ${FLAG_BAND}`);
  console.log("  threshold  caught   wrongly flagged");

  for (const t of STEPS) {
    const caught = shorts.filter((s) => !s.exempt && s.p >= t).length;
    const wrong = fines.filter((s) => !s.exempt && s.p >= t).length;

    console.log(`  ${t.toFixed(2)}       ${caught}/${shorts.length} ${pct(caught, shorts.length).padStart(4)}   ${wrong}/${fines.length} ${pct(wrong, fines.length).padStart(4)}`);
  }

  const missed = shorts.filter((s) => s.exempt || s.p < ACT_BAND).map((s) => `${s.p.toFixed(2)} ${s.case.reply.slice(0, 60)}`);
  const falseAlarms = fines.filter((s) => !s.exempt && s.p >= ACT_BAND).map((s) => `${s.p.toFixed(2)} ${s.case.reply.slice(0, 60)}`);

  console.log(`  below block threshold: ${missed.length}`);
  missed.forEach((m) => console.log(`    - ${m}`));
  console.log(`  blocked although fine: ${falseAlarms.length}`);
  falseAlarms.forEach((m) => console.log(`    - ${m}`));

  const notes = await noteScores();
  const lasting = notes.filter((n) => n.case.lasting);
  const oneOff = notes.filter((n) => !n.case.lasting);

  console.log(`\nmemory curation: ${lasting.length} lasting statements, ${oneOff.length} one-off messages`);
  console.log(`  chosen: save at ${MEMORY_THRESHOLD}`);
  console.log("  threshold  saved    wrongly saved");

  for (const t of STEPS) {
    const kept = lasting.filter((n) => n.p >= t).length;
    const wrong = oneOff.filter((n) => n.p >= t).length;

    console.log(`  ${t.toFixed(2)}       ${kept}/${lasting.length} ${pct(kept, lasting.length).padStart(4)}   ${wrong}/${oneOff.length} ${pct(wrong, oneOff.length).padStart(4)}`);
  }

  const lost = lasting.filter((n) => n.p < MEMORY_THRESHOLD).map((n) => `${n.p.toFixed(2)} ${n.case.text.slice(0, 60)}`);
  const noise = oneOff.filter((n) => n.p >= MEMORY_THRESHOLD).map((n) => `${n.p.toFixed(2)} ${n.case.text.slice(0, 60)}`);

  console.log(`  lasting but below threshold: ${lost.length}`);
  lost.forEach((m) => console.log(`    - ${m}`));
  console.log(`  one-off but saved: ${noise.length}`);
  noise.forEach((m) => console.log(`    - ${m}`));
}

await main();
