# Git

EZTest uses the `git` program itself (spawned without a shell, with argument
arrays, never prompting) and the hosting services' REST APIs through its own
small clients. There is no git library and no hosting SDK. Your existing git
credentials (credential helper, SSH keys) are used as they are; EZTest never
asks for them and never stores them.

- [Studio Source Control](#studio-source-control)
- [Branch-aware results](#branch-aware-results)
- [Pull requests on any host](#pull-requests-on-any-host)
- [CODEOWNERS](#codeowners)
- [Hooks](#hooks)
- [Bisect](#bisect)
- [Limits](#limits)

## Studio Source Control

`eztest studio` > **Source Control** (`#/scm/<path>`):

- **Status** of the project's files, grouped into *Journeys*, *Queries* and
  *Config* (and other files), split into Conflicts, Staged and Changes. Secrets
  (`.env*`, keys) and EZTest state (`.eztest/`) are listed but never diffed,
  blamed or staged from the Studio.
- **Word-level diffs** of `.ez` files (a changed quoted target or value shows
  as one replaced word, marked with `<ins>`/`<del>` and `+`/`−`/`±`, not by
  colour alone).
- **Stage, unstage, discard, commit** (your `user.name` / `user.email`).
- **Branches**: create and switch (refused by git when local changes would be
  overwritten), **pull** (merge) and **push** (sets the upstream the first
  time). When git needs credentials it has not got, the page says to set up a
  credential helper or SSH key.
- **History and blame per journey**: each line with the step id it belongs to,
  who changed it and when ("who changed this step").
- **Conflicts**: a banner and a status bar indicator; a journey with conflict
  markers opens in a resolver showing ours, theirs and the common base for
  each hunk. Keep ours, keep theirs, both, or edit; the preview shows whether
  the result parses as a journey, and only a valid journey can be saved (it is
  then staged).
- **Quality Center branch filter**: runs, history and flaky scores of one
  branch only.
- **Pull request proposals** (see below).

The routes are `/api/scm/*` (`GET /api/routes` lists them); every write needs
the session token, and paths are confined to the project.

## Branch-aware results

Every run records the code it tested in `run.json` → `environment`:
`gitCommit`, `gitBranch`, `gitAuthor` (of the commit), `gitDirty` and
`gitRemote` (credentials stripped). In CI, where checkouts are detached, the
branch comes from the CI variables (pull request source branch first). Set
`EZTEST_GIT=off` to record nothing.

```yaml
vcs:
  branchScope:
    history: true       # flaky scores from this branch's runs only
    baselines: true     # visual baselines per branch
    defaultBranch: main
```

- **History**: every history entry carries its branch; with `history: true`
  flaky scoring (and so triage and readiness) uses the current branch's runs.
- **Visual baselines**: on a branch other than the default one, comparisons
  use `.eztest/baselines/branches/<branch>/`, seeded from the shared baselines
  the first time; approving a baseline in Studio writes there too (once a run
  on that branch has created the directory).
- **Promote on merge**: `eztest git promote` finds branches already merged into
  the default branch and copies their changed baselines into the shared
  directory and relabels their history runs (`--branch x` promotes one branch
  now). Run it after merges, e.g. in the main branch pipeline.
- **Quality Center**: the branch filter on the Source Control page (and
  `POST /api/scm/branch-filter`) scopes every Quality page.

## Pull requests on any host

One provider interface (`src/vcs`) covers Azure Repos, GitHub (and GitHub
Enterprise Server), GitLab (and self-managed) and Bitbucket Cloud. The
provider is detected from `vcs.provider`, the CI system (Azure Pipelines,
GitHub Actions, GitLab CI, Bitbucket Pipelines) or the remote URL (https,
ssh, scp-like; `vcs.hosts` maps self-hosted domains).

```bash
npx eztest pr report eztest-results/<run> [--mapping impact.yaml] [--on-risks failure]
```

| | Status | Line annotations on the failing journey steps | Summary comment (updated in place) |
|---|---|---|---|
| Azure Repos | PR status `EZTest` (commit status outside a PR) | PR threads on the line, resolved when fixed | One thread, resolved when GO |
| GitHub | Check run `EZTest` (falls back to a commit status when the token cannot create checks) | Check run annotations (50 per request, all sent) | One issue comment |
| GitLab | Commit status `EZTest` | MR diff discussions on the line, reused on re-runs; `--gitlab-codequality <file>` also writes a Code Quality report | One MR note |
| Bitbucket | Build status `EZTEST` | Code Insights report with annotations (replaced on re-runs) | One PR comment |

The comment carries a hidden marker so re-runs edit it instead of adding new
ones. It lists the failures (journey file and line, step, error, triage), the
heals awaiting review, the impacted journeys (with an impact mapping; impacted
journeys that did not run are flagged) and the readiness gates that did not
pass.

Credentials: `GITHUB_TOKEN` (Actions: `permissions: checks: write,
pull-requests: write`), `GITLAB_TOKEN` (a project access token with `api`
scope; `CI_JOB_TOKEN` can post statuses only), `BITBUCKET_TOKEN` (repository
access token) or `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`, Azure
DevOps as in [azure-devops.md](azure-devops.md#credentials); or `vcs.token:
secret://...`. Tokens are sent only to the API origin, never over plain HTTP,
and redacted from every error.

### Pull requests from Studio

Accepting a heal, approving visual baselines or changing the quarantine adds a
proposal on the Source Control page. **Open pull request** (or automatically,
with `vcs.pullRequests.onHealAccept`, `onBaselineApprove`, `onQuarantine`)
creates a branch with one commit of exactly those files, pushes it with your
credentials and opens a pull request with reviewers from CODEOWNERS. From the
command line: `eztest pr propose <files> --title "…" [--kind heal]`.

The commit is built without touching your checkout: a private index
(`GIT_INDEX_FILE`) is filled from the target branch (`origin/<target>` after a
fetch), the files are hashed in from the working tree, and `commit-tree` +
`update-ref` create the branch. Your current branch, index and working tree
stay exactly as they were. Files under `.eztest/` (quarantine, baselines) are
included even when a `.gitignore` ignores that folder. The `.gitignore` that
`eztest init` writes ignores only the caches and local state under `.eztest/`
and keeps the team decisions committable: `quarantine.json`,
`heal-decisions.json`, `triage-overrides.json`, `baselines/`, `aria/` and
`approvals/`.

```yaml
vcs:
  pullRequests: { onHealAccept: true, target: main, draft: false }
```

## CODEOWNERS

Journey owners come from the first of `.github/CODEOWNERS`,
`.gitlab/CODEOWNERS`, `.azuredevops/CODEOWNERS`, `CODEOWNERS`,
`docs/CODEOWNERS`:

- GitHub rules: the last matching line wins; gitignore-style patterns.
- GitLab sections (`[Section]`, `^[Optional]`, `[Section][2]`, default owners
  on the section line): the last match in each section, owners of all sections
  combined.
- Owners: `@user`, `@org/team`, e-mail addresses, and Azure DevOps groups
  (`[Project]\Team`, quoted when the name has spaces).

They are used for triage routing (each failing journey on the triage board
shows its owner), bug assignment (Assigned To = an e-mail owner, or a
`vcs.owners` mapping such as `"@alice": alice@contoso.com`) and PR reviewers.
`eztest git owners <paths>` shows them.

## Hooks

```bash
npx eztest hooks install              # pre-commit
npx eztest hooks install --pre-push --mapping impact.yaml
npx eztest hooks uninstall
```

- **pre-commit** validates and lints the *staged* version of each staged
  journey (`.ez` anywhere, YAML/JSON under the journeys directory): parse
  errors with line numbers and suggestions, conflict markers, unconverted
  `# TODO` lines, and clicks with no expectation (a heal of them could not be
  verified). Errors block the commit; warnings block it with `--strict`.
- **pre-push** runs the journeys the push changes, plus those an impact
  mapping selects for the other changed files (base: the upstream, else
  `origin/<default branch>`).

The hooks are small `sh` scripts (git runs hooks through `sh` on every
platform, Git for Windows included) that call `eztest hooks run <hook>`; a hook
that was there before is kept as `<hook>.pre-eztest` and still runs first.
`core.hooksPath` is honoured. Skip once with `--no-verify`.

## Bisect

```bash
npx eztest bisect journeys/checkout.ez --good v1.4.0 --bad HEAD --setup "npm ci" --setup "npm run build"
```

For repositories where the application and its journeys live together. In a
separate `git worktree` (your checkout is untouched) each candidate commit is
checked out, the setup commands run, and the journey runs (`eztest run`
there, or `--cmd`). Exit 0 = good, 125 = skip, anything else = bad, as with
`git bisect run`. The journey comes from your current checkout by default (the
test stays fixed while the app changes); `--journey-from candidate` uses each
commit's own version. The result names the first bad commit, its author and
date, and how many of the commits were tested.

Limits: the search follows the first-parent line (a merged branch counts as
one step); commits whose setup fails are skipped, and when skipped commits hide
the answer the result lists the candidates; state outside the worktree
(databases, external services, ports) is not reset between commits, so start
and stop the application in the setup or test command; each step installs
and builds from scratch unless your setup caches.

## Limits

- The GitHub, GitLab and Bitbucket providers are tested against mock servers
  that implement the documented endpoints, auth headers, paging and error
  shapes, not against the live services. Bitbucket Server / Data Center
  (`/rest/api/1.0`) is not supported, only Bitbucket Cloud.
- GitLab line discussions need the MR's diff refs; when the line is not part
  of the diff GitLab refuses the position and the status and comment are still
  posted (with a warning).
- Studio pull is a merge (`git pull --no-rebase`); rebase from a terminal.
- The conflict resolver handles text conflicts in one file at a time; renames
  and binary conflicts need git itself.
