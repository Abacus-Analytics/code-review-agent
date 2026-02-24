/**
 * index.js — Main entry point for the Abacus Code Review Agent.
 *
 * This is the orchestrator that ties everything together:
 *   1. Detects whether this was triggered by a /review comment or a PR event
 *   2. Loads the config
 *   3. Fetches PR context from GitHub
 *   4. Filters files based on ignore patterns
 *   5. Sends code to Claude for review
 *   6. Posts results on the PR
 *   7. (If enabled) Updates Jira
 *
 * The mode setting controls behavior:
 *   - manual:    Only runs on /review comments
 *   - automatic: Runs on /review comments AND on PR open/sync events
 */

const github = require('./github');
const claude = require('./claude');
const jira = require('./jira');
const config = require('./config');

// ─── GitHub Actions provides these environment variables ───
function getActionInputs() {
  return {
    githubToken: process.env.INPUT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '',
    claudeApiKey: process.env.INPUT_CLAUDE_API_KEY || process.env.CLAUDE_API_KEY || '',
    jiraBaseUrl: process.env.INPUT_JIRA_BASE_URL || process.env.JIRA_BASE_URL || '',
    jiraEmail: process.env.INPUT_JIRA_EMAIL || process.env.JIRA_EMAIL || '',
    jiraApiToken: process.env.INPUT_JIRA_API_TOKEN || process.env.JIRA_API_TOKEN || '',
    configPath: process.env.INPUT_CONFIG_PATH || '.code-review.yml',
  };
}

/**
 * Reads the GitHub Actions event payload.
 * This tells us what triggered the action (comment, PR open, PR push, etc.)
 */
function getEventPayload() {
  const fs = require('fs');
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH not set. Are you running inside GitHub Actions?');
  }

  return JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
}

/**
 * Extracts the PR number from the event payload.
 * Works for both issue_comment events and pull_request events.
 */
function getPrNumber(eventName, payload) {
  if (eventName === 'issue_comment') {
    // The PR number is nested under issue for comment events
    return payload.issue?.number;
  }
  if (eventName === 'pull_request') {
    return payload.pull_request?.number;
  }
  return null;
}

/**
 * Gets the repo owner and name from the GITHUB_REPOSITORY env var.
 * Format: "owner/repo"
 */
function getRepoInfo() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  const [owner, name] = repo.split('/');
  return { owner, repo: name };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log('🔍 Abacus Code Review Agent starting...\n');

  try {
    // ─── 1. Read inputs and event data ───
    const inputs = getActionInputs();
    const eventName = process.env.GITHUB_EVENT_NAME;
    const payload = getEventPayload();
    const { owner, repo } = getRepoInfo();

    console.log(`Event: ${eventName}`);
    console.log(`Repo: ${owner}/${repo}`);

    // ─── 2. Determine trigger type ───
    let reviewCommand = { run: true, variant: 'default', dryRun: false };

    if (eventName === 'issue_comment') {
      // This was triggered by a comment — check if it's a /review command
      reviewCommand = config.parseReviewCommand(payload.comment?.body);

      if (!reviewCommand.run) {
        console.log('Comment is not a /review command. Exiting.');
        return;
      }

      // Make sure the comment is on a PR (not a regular issue)
      if (!payload.issue?.pull_request) {
        console.log('Comment is on an issue, not a PR. Exiting.');
        return;
      }

      console.log(`/review command detected. Variant: ${reviewCommand.variant}, Dry run: ${reviewCommand.dryRun}`);
    }

    // ─── 3. Get PR number ───
    const prNumber = getPrNumber(eventName, payload);
    if (!prNumber) {
      console.error('Could not determine PR number from event payload.');
      process.exit(1);
    }
    console.log(`PR #${prNumber}`);

    // ─── 4. Create API clients ───
    const octokit = github.createClient(inputs.githubToken);
    const claudeClient = claude.createClient(inputs.claudeApiKey);

    // ─── 5. Load config from the repo ───
    const prRef = eventName === 'pull_request'
      ? payload.pull_request.head.sha
      : payload.issue?.pull_request?.url
        ? undefined  // For comments, we'll use the default branch; it's fine
        : undefined;

    const mergedConfig = await config.loadConfig(
      octokit, owner, repo, prRef, inputs.configPath
    );

    console.log(`Mode: ${mergedConfig.mode}`);
    console.log(`Jira enabled: ${mergedConfig.jira_enabled}`);

    // ─── 6. Check mode ───
    // In manual mode, only /review comments trigger a review
    // In automatic mode, both comments and PR events trigger
    if (mergedConfig.mode === 'manual' && eventName === 'pull_request') {
      console.log('Mode is "manual" but trigger was a PR event (not /review). Exiting.');
      return;
    }

    // ─── 7. Post progress comment (unless dry-run) ───
    let progressCommentId = null;
    if (!reviewCommand.dryRun) {
      progressCommentId = await github.postProgressComment(octokit, owner, repo, prNumber);
    }

    // ─── 8. Fetch full PR context ───
    console.log('\nFetching PR context...');
    const prContext = await github.getPullRequestContext(octokit, owner, repo, prNumber);

    console.log(`  Title: ${prContext.title}`);
    console.log(`  Author: ${prContext.author}`);
    console.log(`  Branch: ${prContext.branch} → ${prContext.baseBranch}`);
    console.log(`  Files: ${prContext.stats.totalFiles}`);
    console.log(`  +${prContext.stats.totalAdditions} -${prContext.stats.totalDeletions}`);

    // ─── 9. Filter files ───
    const originalFileCount = prContext.files.length;
    prContext.files = prContext.files.filter(
      f => !config.shouldIgnoreFile(f.filename, mergedConfig.files.ignore)
    );
    const filteredCount = originalFileCount - prContext.files.length;
    if (filteredCount > 0) {
      console.log(`  Filtered out ${filteredCount} file(s) based on ignore patterns.`);
    }

    // Check if there are any files left to review
    if (prContext.files.length === 0) {
      console.log('No reviewable files in this PR after filtering. Posting skip message.');
      if (!reviewCommand.dryRun && progressCommentId) {
        await github.updateComment(
          octokit, owner, repo, progressCommentId,
          '✅ **AI Code Review — SKIPPED**\n\nAll changed files match ignore patterns. Nothing to review.'
        );
      }
      return;
    }

    // ─── 10. Extract Jira key ───
    const jiraKey = github.extractJiraKey(prContext, mergedConfig.jira.project_key);
    console.log(`  Jira key: ${jiraKey || '(not found)'}`);

    // ─── 11. Load codebase context ───
    // Fetch CODEBASE_CONTEXT.md and always_include_for_context files
    // so Claude has full knowledge of the repo's architecture and patterns.
    console.log('\nLoading codebase context...');
    const headRef = prContext.branch; // Use the PR's head branch

    const [codebaseContext, contextFiles] = await Promise.all([
      github.getCodebaseContext(octokit, owner, repo, headRef),
      github.getContextFiles(
        octokit, owner, repo, headRef,
        mergedConfig.files.always_include_for_context
      ),
    ]);

    if (codebaseContext) {
      console.log('  ✅ Loaded CODEBASE_CONTEXT.md');
    }
    if (contextFiles.length > 0) {
      console.log(`  ✅ Loaded ${contextFiles.length} context file(s)`);
    }

    // ─── 12. Send to Claude for review ───
    console.log('\n🤖 Sending to Claude for review...');
    const review = await claude.reviewCode(
      claudeClient, prContext, mergedConfig, reviewCommand.variant,
      { codebaseContext, contextFiles }
    );

    const blocking = review.issues.filter(i => i.severity === 'blocking');
    const warnings = review.issues.filter(i => i.severity === 'warning');
    const suggestions = review.issues.filter(i => i.severity === 'suggestion');

    console.log(`\nReview complete:`);
    console.log(`  Approved: ${review.approved}`);
    console.log(`  Blocking: ${blocking.length}`);
    console.log(`  Warnings: ${warnings.length}`);
    console.log(`  Suggestions: ${suggestions.length}`);

    // ─── 13. Post results ───
    if (reviewCommand.dryRun) {
      // Dry run: log the review but don't post anything
      console.log('\n🏃 DRY RUN — results logged but NOT posted.\n');
      console.log('Review summary:', review.summary);
      review.issues.forEach(issue => {
        console.log(`  [${issue.severity.toUpperCase()}] ${issue.file}: ${issue.title}`);
      });
    } else {
      // Format and post the review comment
      const commentBody = github.formatReviewComment(review, prContext, jiraKey, mergedConfig);

      // Update the progress comment with the actual review
      if (progressCommentId) {
        await github.updateComment(octokit, owner, repo, progressCommentId, commentBody);
      } else {
        await github.postComment(octokit, owner, repo, prNumber, commentBody);
      }

      console.log('✅ Review posted to PR.');

      // ─── 14. Update Jira (if enabled) ───
      await jira.updateJira(mergedConfig, review, prContext, jiraKey, {
        baseUrl: inputs.jiraBaseUrl,
        email: inputs.jiraEmail,
        apiToken: inputs.jiraApiToken,
      });
    }

    // ─── Done ───
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✨ Review completed in ${elapsed}s.`);

  } catch (error) {
    console.error('\n❌ Review agent failed:', error.message);
    console.error(error.stack);

    // Try to post an error comment on the PR so the developer knows
    try {
      const inputs = getActionInputs();
      const payload = getEventPayload();
      const { owner, repo } = getRepoInfo();
      const prNumber = getPrNumber(process.env.GITHUB_EVENT_NAME, payload);

      if (prNumber && inputs.githubToken) {
        const octokit = github.createClient(inputs.githubToken);
        await github.postComment(
          octokit, owner, repo, prNumber,
          `## ⚠️ AI Code Review — Error\n\n` +
          `The review agent encountered an error:\n\n` +
          `\`\`\`\n${error.message}\n\`\`\`\n\n` +
          `This is likely a configuration issue. Check the Actions log for details.\n\n` +
          `---\n*Abacus Code Review Agent*`
        );
      }
    } catch (postError) {
      console.error('Could not post error comment:', postError.message);
    }

    process.exit(1);
  }
}

// Run
main();
