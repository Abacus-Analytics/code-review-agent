/**
 * jira.js — Updates Jira issues with review results.
 *
 * PHASE 2: This module is fully built but only activates when
 * jira_enabled: true in .code-review.yml.
 *
 * It handles:
 *   - Adding review comments to Jira issues
 *   - Transitioning issues to "TESTING" on approval
 *   - Graceful handling when Jira is disabled or unreachable
 */

/**
 * Creates a Jira API client with basic auth.
 *
 * @param {string} baseUrl - Jira instance URL (e.g., https://yourcompany.atlassian.net)
 * @param {string} email - Jira service account email
 * @param {string} apiToken - Jira API token
 */
function createClient(baseUrl, email, apiToken) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  return {
    baseUrl: baseUrl.replace(/\/$/, ''), // Remove trailing slash
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
}

/**
 * Adds a comment to a Jira issue.
 *
 * @param {Object} client - Jira client from createClient
 * @param {string} issueKey - Jira issue key (e.g., 'ABACUS-142')
 * @param {string} commentBody - Comment text (supports Jira markdown)
 */
async function addComment(client, issueKey, commentBody) {
  const url = `${client.baseUrl}/rest/api/3/issue/${issueKey}/comment`;

  const response = await fetch(url, {
    method: 'POST',
    headers: client.headers,
    body: JSON.stringify({
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: commentBody,
              },
            ],
          },
        ],
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira comment failed (${response.status}): ${errorText}`);
  }

  console.log(`✅ Jira comment added to ${issueKey}`);
}

/**
 * Transitions a Jira issue to a new status.
 *
 * @param {Object} client - Jira client
 * @param {string} issueKey - Jira issue key
 * @param {string} targetStatusName - Target status name (e.g., 'TESTING')
 */
async function transitionIssue(client, issueKey, targetStatusName) {
  // First, get available transitions for this issue
  const transitionsUrl = `${client.baseUrl}/rest/api/3/issue/${issueKey}/transitions`;
  const transitionsResponse = await fetch(transitionsUrl, {
    method: 'GET',
    headers: client.headers,
  });

  if (!transitionsResponse.ok) {
    throw new Error(`Failed to get Jira transitions for ${issueKey}`);
  }

  const { transitions } = await transitionsResponse.json();

  // Find the transition that leads to our target status
  const transition = transitions.find(t =>
    t.to.name.toLowerCase() === targetStatusName.toLowerCase()
  );

  if (!transition) {
    const available = transitions.map(t => `${t.name} → ${t.to.name}`).join(', ');
    console.warn(
      `⚠️ Cannot transition ${issueKey} to "${targetStatusName}". ` +
      `Available transitions: ${available}`
    );
    return false;
  }

  // Execute the transition
  const response = await fetch(transitionsUrl, {
    method: 'POST',
    headers: client.headers,
    body: JSON.stringify({
      transition: { id: transition.id },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jira transition failed (${response.status}): ${errorText}`);
  }

  console.log(`✅ Jira issue ${issueKey} transitioned to "${targetStatusName}"`);
  return true;
}

/**
 * Formats the review into a Jira-friendly comment.
 */
function formatJiraComment(review, prContext, config) {
  const { approved, issues, summary } = review;
  const blocking = issues.filter(i => i.severity === 'blocking');
  const warnings = issues.filter(i => i.severity === 'warning');
  const suggestions = issues.filter(i => i.severity === 'suggestion');

  let comment = '';

  if (approved) {
    comment += `✅ AI Code Review — APPROVED\n\n`;
  } else {
    comment += `🔴 AI Code Review — CHANGES REQUESTED\n\n`;
  }

  comment += `PR: "${prContext.title}"\n`;
  comment += `Files reviewed: ${prContext.stats.totalFiles}`;
  comment += ` | Blocking: ${blocking.length}`;
  comment += ` | Warnings: ${warnings.length}`;
  comment += ` | Suggestions: ${suggestions.length}\n\n`;

  comment += `${summary}\n\n`;

  if (blocking.length > 0) {
    comment += `Blocking Issues (must fix):\n`;
    blocking.forEach((issue, i) => {
      comment += `${i + 1}. [${issue.category.toUpperCase()}] ${issue.title}\n`;
      comment += `   ${issue.file}`;
      if (issue.line) comment += ` (line ${issue.line})`;
      comment += `\n`;
      comment += `   ${issue.description}\n`;
      if (issue.suggestion) comment += `   Fix: ${issue.suggestion}\n`;
      comment += `\n`;
    });
  }

  if (warnings.length > 0) {
    comment += `Warnings:\n`;
    warnings.forEach((issue, i) => {
      comment += `${i + 1}. [${issue.category.toUpperCase()}] ${issue.title}\n`;
      comment += `   ${issue.file} — ${issue.description}\n`;
    });
    comment += `\n`;
  }

  if (approved) {
    comment += `→ Transitioning to ${config.jira.transition_on_approve}\n\n`;
  } else {
    comment += `→ NOT transitioning. Fix blocking issues and push again.\n\n`;
  }

  comment += `Link: ${prContext.url}\n`;
  comment += `Reviewed by: Abacus Code Review Agent (Claude Sonnet 4.5)`;

  return comment;
}

/**
 * Main Jira update function. Called from index.js when jira_enabled is true.
 *
 * @param {Object} config - Merged config
 * @param {Object} review - Structured review from claude.js
 * @param {Object} prContext - PR context from github.js
 * @param {string} jiraKey - Jira issue key (e.g., 'ABACUS-142')
 * @param {Object} credentials - { baseUrl, email, apiToken }
 */
async function updateJira(config, review, prContext, jiraKey, credentials) {
  if (!config.jira_enabled) {
    console.log('Jira updates disabled (jira_enabled: false). Skipping.');
    return;
  }

  if (!jiraKey) {
    console.log('No Jira key found. Skipping Jira update.');
    return;
  }

  if (!credentials.baseUrl || !credentials.email || !credentials.apiToken) {
    console.warn('⚠️ Jira credentials not configured. Skipping Jira update.');
    return;
  }

  const client = createClient(credentials.baseUrl, credentials.email, credentials.apiToken);

  try {
    // Always add a comment
    const comment = formatJiraComment(review, prContext, config);
    await addComment(client, jiraKey, comment);

    // Transition only on approval
    if (review.approved) {
      await transitionIssue(client, jiraKey, config.jira.transition_on_approve);
    }
  } catch (error) {
    console.error(`⚠️ Jira update failed for ${jiraKey}: ${error.message}`);
    // Don't throw — Jira failure shouldn't block the PR comment
  }
}

module.exports = {
  createClient,
  addComment,
  transitionIssue,
  formatJiraComment,
  updateJira,
};
