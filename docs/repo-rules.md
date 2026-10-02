# Repo rules

Put rules that belong to one repository in `.claude/rules/jev-rules.md`. The rule hook reads everything under `.claude/rules/`, so the file needs no registration and loads next to `CLAUDE.md` and `AGENTS.md`. When the 40-rule cap applies, scoped rules are asked before unscoped ones, and inside each of those groups repository rules come before the global `~/.claude/CLAUDE.md` rules.

## Format

One rule per bullet or paragraph, at least 20 characters. Headings, tables and fenced code are skipped.

```markdown
- **no-console-log**: Never leave console.log calls in committed source files.
- **tests-for-new-functions**: Every new exported function needs a unit test in the same change. (scope: src/**)
```

- `**name**:` sets the rule id; without it the id is a slug of the text.
- A trailing `(scope: glob, glob)` limits the rule to matching files.
- Front matter `paths:` scopes every rule in the file.
- Jev classifies each rule once per file hash: whether it is a rule, whether it applies per edit or per turn, forbid or require, and its subject.

Check that a file loads by editing a matching file and looking for `.claude/rules/jev-rules.md` in the `rule_hashes` map of the newest `kind: "rules"` row of `~/.claude/jev-router-log.jsonl`. `rule_hashes` is keyed by rule file; `n_rules` is only the total count.
