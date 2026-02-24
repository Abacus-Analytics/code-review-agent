# Abacus AI Code Review Agent

AI-powered code review for .NET, Blazor, and Azure projects using Claude Sonnet 4.5.

## Quick Start

### 1. Set up org secrets

Go to your GitHub org → Settings → Secrets → Actions. Add:

| Secret | Value |
|--------|-------|
| `CLAUDE_API_KEY` | Your Anthropic API key (from console.anthropic.com) |
| `JIRA_BASE_URL` | `https://yourcompany.atlassian.net` |
| `JIRA_EMAIL` | Your Jira service account email |
| `JIRA_API_TOKEN` | Jira API token (from id.atlassian.com) |

### 2. Add workflow to your repo

Copy `examples/workflow.yml` to `.github/workflows/code-review.yml` in any repo.

### 3. Add config to your repo

Copy `examples/code-review.yml` to `.code-review.yml` in the repo root. Start with:

```yaml
mode: manual
jira_enabled: false
```

### 4. Test it

Open a PR and type `/review` as a comment.

## Commands

| Command | What it does |
|---------|-------------|
| `/review` | Run a full code review |
| `/review strict` | Higher sensitivity (more flags) |
| `/review lenient` | Lower sensitivity (critical issues only) |
| `/review security-only` | Only check security |
| `/review dry-run` | Log results without posting (check Actions log) |

## Modes

| Mode | Trigger | Jira | When to use |
|------|---------|------|-------------|
| Mode 1 | `/review` only | Off | Testing phase — compare with human reviews |
| Mode 2 | `/review` only | On | Jira integration testing |
| Mode 3 | Every PR + `/review` | On | Full automation |

Change modes in `.code-review.yml`:

```yaml
# Mode 1
mode: manual
jira_enabled: false

# Mode 2
mode: manual
jira_enabled: true

# Mode 3
mode: automatic
jira_enabled: true
```

## Project Structure

```
src/index.js     — Main orchestrator
src/github.js    — GitHub API (read PRs, post comments, fetch context files)
src/claude.js    — Claude API (send code + context, parse review)
src/jira.js      — Jira API (comments, transitions)
src/config.js    — Config reader with defaults
prompts/         — Claude system prompt (the agent's "brain")
examples/        — Ready-to-copy workflow, config, and CODEBASE_CONTEXT template
```

## Giving the Agent Full Context

The agent can read your codebase's architecture and patterns before every review. This makes it much smarter — it knows your conventions, your base classes, and the common mistakes your team makes.

### CODEBASE_CONTEXT.md

Drop a `CODEBASE_CONTEXT.md` file in the root of your repo. This is a plain-English description of your architecture, patterns, and conventions. See `examples/CODEBASE_CONTEXT.md` for a ready-to-fill template.

### Reference Files

In `.code-review.yml`, you can tell the agent to always read certain files (even if they're not in the PR diff) so it understands your interfaces and models:

```yaml
files:
  always_include_for_context:
    - "src/**/Interfaces/**"
    - "src/**/Models/**"
```

## Customizing Guardrails

See `examples/code-review.yml` for the full config with comments explaining every option.

Key things you can customize:
- **Severity levels** per category (security, bugs, performance, etc.)
- **Always-block list** for checks that must always be blocking
- **Ignore list** for checks that are too noisy
- **Custom rules** in plain English
- **File ignore patterns** to skip generated files, migrations, etc.
