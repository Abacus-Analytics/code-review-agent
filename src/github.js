/**
 * github.js — Reads PR data and posts review comments.
 *
 * This module handles all GitHub API interactions:
 *   - Reading PR metadata (title, body, author, branch)
 *   - Fetching the full diff (all changed files)
 *   - Reading commit messages
 *   - Posting review summary comments on the PR
 */

const { Octokit } = require('@octokit/rest');

/**
 * Creates an authenticated GitHub API client.
 */
function createClient(token) {
  return new Octokit({ auth: token });
}

/**
 * Fetches all PR context the review agent needs.
 *
 * Returns a single object with everything: title, body, commits,
 * changed files with diffs, branch info, and author.
 *
 * @param {Octokit} octokit - GitHub API client
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {number} prNumber - Pull request number
 * @returns {Object} Full PR context
 */
async function getPullRequestContext(octokit, owner, repo, prNumber) {
  // Fetch PR metadata, files, and commits in parallel
  const [prResponse, filesResponse, commitsResponse] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 }),
    octokit.pulls.listCommits({ owner, repo, pull_number: prNumber, per_page: 100 }),
  ]);

  const pr = prResponse.data;
  const files = filesResponse.data;
  const commits = commitsResponse.data;

  // Handle paginated files for large PRs (> 100 files)
  let allFiles = files;
  if (files.length === 100) {
    let page = 2;
    while (true) {
      const moreFiles = await octokit.pulls.listFiles({
        owner, repo, pull_number: prNumber, per_page: 100, page,
      });
      allFiles = allFiles.concat(moreFiles.data);
      if (moreFiles.data.length < 100) break;
      page++;
    }
  }

  return {
    number: prNumber,
    title: pr.title,
    body: pr.body || '',
    author: pr.user.login,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    url: pr.html_url,

    commits: commits.map(c => ({
      sha: c.sha.substring(0, 7),
      message: c.commit.message,
      author: c.commit.author.name,
    })),

    files: allFiles.map(f => ({
      filename: f.filename,
      status: f.status,           // 'added', 'modified', 'removed', 'renamed'
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch || '',       // The actual diff for this file
    })),

    stats: {
      totalFiles: allFiles.length,
      totalAdditions: allFiles.reduce((sum, f) => sum + f.additions, 0),
      totalDeletions: allFiles.reduce((sum, f) => sum + f.deletions, 0),
    },
  };
}

/**
 * Posts a review summary comment on the PR.
 *
 * @param {Octokit} octokit - GitHub API client
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {number} prNumber - Pull request number
 * @param {string} body - Comment body (markdown)
 */
async function postComment(octokit, owner, repo, prNumber, body) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

/**
 * Posts a "thinking" comment to show the review is in progress.
 * Returns the comment ID so it can be updated/deleted later.
 */
async function postProgressComment(octokit, owner, repo, prNumber) {
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: '🔍 **AI Code Review in progress...** Analyzing your changes now. This usually takes 30-90 seconds.',
  });
  return data.id;
}

/**
 * Updates an existing comment (used to replace the progress comment with results).
 */
async function updateComment(octokit, owner, repo, commentId, body) {
  await octokit.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body,
  });
}

/**
 * Deletes a comment (used to clean up the progress comment).
 */
async function deleteComment(octokit, owner, repo, commentId) {
  try {
    await octokit.issues.deleteComment({
      owner,
      repo,
      comment_id: commentId,
    });
  } catch (e) {
    // Not critical if cleanup fails
  }
}

/**
 * Extracts the Jira issue key from all available PR data.
 * Checks: PR title → PR body → branch name → commit messages
 * Returns the first match, or null if not found.
 *
 * @param {Object} prContext - The full PR context from getPullRequestContext
 * @param {string} projectKey - Jira project key (e.g., 'ABACUS')
 * @returns {string|null} Jira issue key (e.g., 'ABACUS-142') or null
 */
function extractJiraKey(prContext, projectKey = 'ABACUS') {
  const pattern = new RegExp(`(${projectKey}-\\d+)`, 'i');

  // Check in priority order: title, body, branch, commits
  const sources = [
    prContext.title,
    prContext.body,
    prContext.branch,
    ...prContext.commits.map(c => c.message),
  ];

  for (const source of sources) {
    const match = (source || '').match(pattern);
    if (match) {
      return match[1].toUpperCase();
    }
  }

  return null;
}

/**
 * Formats the review results into a markdown comment for the PR.
 *
 * @param {Object} review - The structured review from Claude
 * @param {Object} prContext - PR context data
 * @param {string|null} jiraKey - Jira key if found
 * @param {Object} config - The merged config
 * @returns {string} Formatted markdown comment
 */
function formatReviewComment(review, prContext, jiraKey, config) {
  const { approved, issues, summary } = review;

  const blocking = issues.filter(i => i.severity === 'blocking');
  const warnings = issues.filter(i => i.severity === 'warning');
  const suggestions = issues.filter(i => i.severity === 'suggestion');

  let comment = '';

  // ─── Header ───
  if (approved) {
    comment += `## ✅ AI Code Review — APPROVED\n\n`;
  } else {
    comment += `## 🔴 AI Code Review — CHANGES REQUESTED\n\n`;
  }

  // ─── Summary ───
  comment += `${summary}\n\n`;

  // ─── Stats line ───
  comment += `**Files reviewed:** ${prContext.stats.totalFiles}`;
  comment += ` | **Blocking:** ${blocking.length}`;
  comment += ` | **Warnings:** ${warnings.length}`;
  comment += ` | **Suggestions:** ${suggestions.length}\n\n`;

  // ─── Jira info ───
  if (jiraKey) {
    comment += `**Jira:** ${jiraKey}`;
    if (config.jira_enabled) {
      comment += approved
        ? ` → Transitioning to ${config.jira.transition_on_approve}`
        : ` → Not transitioning (fix blocking issues first)`;
    } else {
      comment += ` (Jira updates disabled — Mode 1)`;
    }
    comment += `\n\n`;
  } else {
    comment += `> 💡 **No Jira ticket found.** Consider including the ticket key in your PR title, `;
    comment += `description, or branch name (e.g., \`feature/ABACUS-123-description\`).\n\n`;
  }

  // ─── Blocking Issues ───
  if (blocking.length > 0) {
    comment += `### 🔴 Blocking Issues (must fix)\n\n`;
    blocking.forEach((issue, i) => {
      comment += `**${i + 1}. [${issue.category.toUpperCase()}] ${issue.title}**\n`;
      comment += `📄 \`${issue.file}\``;
      if (issue.line) comment += ` (line ${issue.line})`;
      comment += `\n`;
      comment += `${issue.description}\n`;
      if (issue.suggestion) {
        comment += `> 💡 **Fix:** ${issue.suggestion}\n`;
      }
      comment += `\n`;
    });
  }

  // ─── Warnings ───
  if (warnings.length > 0) {
    comment += `### 🟡 Warnings\n\n`;
    warnings.forEach((issue, i) => {
      comment += `**${i + 1}. [${issue.category.toUpperCase()}] ${issue.title}**\n`;
      comment += `📄 \`${issue.file}\``;
      if (issue.line) comment += ` (line ${issue.line})`;
      comment += `\n`;
      comment += `${issue.description}\n`;
      if (issue.suggestion) {
        comment += `> 💡 **Suggestion:** ${issue.suggestion}\n`;
      }
      comment += `\n`;
    });
  }

  // ─── Suggestions ───
  if (suggestions.length > 0) {
    comment += `<details>\n<summary>🟢 Suggestions (${suggestions.length})</summary>\n\n`;
    suggestions.forEach((issue, i) => {
      comment += `**${i + 1}. [${issue.category.toUpperCase()}] ${issue.title}**\n`;
      comment += `📄 \`${issue.file}\``;
      if (issue.line) comment += ` (line ${issue.line})`;
      comment += ` — ${issue.description}\n`;
      if (issue.suggestion) {
        comment += `> ${issue.suggestion}\n`;
      }
      comment += `\n`;
    });
    comment += `</details>\n\n`;
  }

  // ─── Footer ───
  comment += `---\n`;
  comment += `*Reviewed by Abacus Code Review Agent (Claude Sonnet 4.5)*`;

  return comment;
}

/**
 * Fetches the CODEBASE_CONTEXT.md file from the repo root.
 * This file contains the team's architecture overview, patterns,
 * conventions, and anything else the agent should know before reviewing.
 *
 * Returns the file content as a string, or null if it doesn't exist.
 */
async function getCodebaseContext(octokit, owner, repo, ref) {
  try {
    const { data } = await octokit.repos.getContent({
      owner, repo, path: 'CODEBASE_CONTEXT.md', ref,
    });
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (error) {
    if (error.status === 404) {
      console.log('  No CODEBASE_CONTEXT.md found (optional but recommended).');
      return null;
    }
    console.warn(`  Warning: Could not read CODEBASE_CONTEXT.md: ${error.message}`);
    return null;
  }
}

/**
 * Fetches files matching the always_include_for_context patterns.
 * These are files the agent should see even if they're not in the PR diff,
 * so it understands the interfaces, models, and patterns the code should follow.
 *
 * Uses the GitHub Trees API to list all files, then fetches matching ones.
 * Returns an array of { path, content } objects.
 *
 * @param {Octokit} octokit - GitHub API client
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} ref - Git ref (branch SHA)
 * @param {string[]} patterns - Glob patterns to match (e.g., ["src/** /Interfaces/**"])
 * @returns {Array<{path: string, content: string}>} Matched files with content
 */
async function getContextFiles(octokit, owner, repo, ref, patterns) {
  if (!patterns || patterns.length === 0) {
    return [];
  }

  try {
    // Get the full file tree for the repo at this ref
    const { data: tree } = await octokit.git.getTree({
      owner, repo,
      tree_sha: ref || 'HEAD',
      recursive: 'true',
    });

    // Import the glob matcher from config
    const { shouldIgnoreFile } = require('./config');

    // Find files that match ANY of the context patterns
    // (reusing shouldIgnoreFile logic — if it "matches" the pattern, include it)
    const matchingPaths = tree.tree
      .filter(item => item.type === 'blob') // Only files, not directories
      .filter(item => {
        return patterns.some(pattern => {
          return shouldIgnoreFile(item.path, [pattern]);
        });
      })
      .map(item => item.path);

    if (matchingPaths.length === 0) {
      console.log('  No context files matched the patterns.');
      return [];
    }

    // Cap at 30 files to avoid sending too much to Claude
    const filesToFetch = matchingPaths.slice(0, 30);
    if (matchingPaths.length > 30) {
      console.log(`  Found ${matchingPaths.length} context files, capping at 30.`);
    }

    // Fetch file contents in parallel (batches of 10 to be kind to the API)
    const contextFiles = [];
    for (let i = 0; i < filesToFetch.length; i += 10) {
      const batch = filesToFetch.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          try {
            const { data } = await octokit.repos.getContent({
              owner, repo, path: filePath, ref,
            });
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            return { path: filePath, content };
          } catch (err) {
            console.warn(`  Could not read context file ${filePath}: ${err.message}`);
            return null;
          }
        })
      );
      contextFiles.push(...results.filter(Boolean));
    }

    console.log(`  Loaded ${contextFiles.length} context file(s) for review.`);
    return contextFiles;

  } catch (error) {
    console.warn(`  Warning: Could not fetch context files: ${error.message}`);
    return [];
  }
}

module.exports = {
  createClient,
  getPullRequestContext,
  getCodebaseContext,
  getContextFiles,
  postComment,
  postProgressComment,
  updateComment,
  deleteComment,
  extractJiraKey,
  formatReviewComment,
};
