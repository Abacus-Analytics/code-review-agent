/**
 * claude.js — Sends code to Claude API and parses the structured review response.
 *
 * This is the "brain" of the review agent. It:
 *   1. Builds a prompt from the PR context and guardrails config
 *   2. Sends it to Claude Sonnet 4.5
 *   3. Parses Claude's JSON response into a structured review
 *   4. Applies guardrail overrides (always_block, ignore, severity overrides)
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

/**
 * Creates an Anthropic API client.
 */
function createClient(apiKey) {
  return new Anthropic({ apiKey });
}

/**
 * Loads the system prompt from the prompts/ directory.
 */
function loadSystemPrompt() {
  const promptPath = path.join(__dirname, '..', 'prompts', 'system-prompt.md');
  return fs.readFileSync(promptPath, 'utf-8');
}

/**
 * Builds the user message from the PR context.
 * This is what gets sent to Claude along with the system prompt.
 *
 * @param {Object} prContext - PR context from github.js
 * @param {Object} config - Merged config
 * @param {string} variant - Review variant
 * @param {Object} extraContext - Additional context: { codebaseContext, contextFiles }
 */
function buildUserMessage(prContext, config, variant = 'default', extraContext = {}) {
  let message = '';

  // ─── Codebase Context (architecture, patterns, conventions) ───
  if (extraContext.codebaseContext) {
    message += `## Codebase Context\n\n`;
    message += `The team has provided this overview of their codebase architecture, `;
    message += `patterns, and conventions. Use this to inform your review — flag `;
    message += `violations of these patterns and understand the intent behind code choices.\n\n`;
    message += `${extraContext.codebaseContext}\n\n`;
  }

  // ─── Reference Files (interfaces, models, etc. not in the diff) ───
  if (extraContext.contextFiles && extraContext.contextFiles.length > 0) {
    message += `## Reference Files (not in the diff)\n\n`;
    message += `These files are included for context so you can understand the interfaces, `;
    message += `models, and patterns the PR code should follow. Do NOT flag issues in these `;
    message += `files — only use them to inform your review of the actual diff.\n\n`;
    extraContext.contextFiles.forEach(file => {
      message += `### ${file.path}\n\n`;
      message += `\`\`\`\n${file.content}\n\`\`\`\n\n`;
    });
  }

  // ─── PR Metadata ───
  message += `## Pull Request Context\n\n`;
  message += `**Title:** ${prContext.title}\n`;
  message += `**Author:** ${prContext.author}\n`;
  message += `**Branch:** ${prContext.branch} → ${prContext.baseBranch}\n`;
  message += `**Files changed:** ${prContext.stats.totalFiles}\n`;
  message += `**Lines added:** ${prContext.stats.totalAdditions}\n`;
  message += `**Lines removed:** ${prContext.stats.totalDeletions}\n\n`;

  // ─── PR Description ───
  if (prContext.body) {
    message += `## PR Description\n\n${prContext.body}\n\n`;
  }

  // ─── Commit Messages ───
  if (prContext.commits.length > 0) {
    message += `## Commits\n\n`;
    prContext.commits.forEach(c => {
      message += `- \`${c.sha}\` ${c.message}\n`;
    });
    message += `\n`;
  }

  // ─── Review Variant Instructions ───
  if (variant === 'strict') {
    message += `## Review Mode: STRICT\n`;
    message += `Be extra thorough. Flag anything that could be improved, even minor style issues. `;
    message += `Treat warnings as blocking where possible.\n\n`;
  } else if (variant === 'lenient') {
    message += `## Review Mode: LENIENT\n`;
    message += `Focus only on critical issues: security vulnerabilities, bugs, and crashes. `;
    message += `Ignore style, naming, and minor performance concerns.\n\n`;
  } else if (variant === 'security-only') {
    message += `## Review Mode: SECURITY ONLY\n`;
    message += `Only check for security vulnerabilities. Ignore all other categories.\n\n`;
  }

  // ─── Custom Rules ───
  if (config.guardrails.custom_rules && config.guardrails.custom_rules.length > 0) {
    message += `## Team-Specific Rules\n\n`;
    message += `In addition to standard checks, enforce these team rules:\n\n`;
    config.guardrails.custom_rules.forEach(rule => {
      message += `- [${rule.severity.toUpperCase()}] ${rule.text}\n`;
    });
    message += `\n`;
  }

  // ─── Ignored Checks ───
  if (config.guardrails.ignore && config.guardrails.ignore.length > 0) {
    message += `## Checks to Skip\n\n`;
    message += `Do NOT flag issues for these checks: ${config.guardrails.ignore.join(', ')}\n\n`;
  }

  // ─── Code Diff ───
  message += `## Code Changes\n\n`;
  message += `Below are the changed files with their diffs. Review each one.\n\n`;

  prContext.files.forEach(file => {
    if (!file.patch) return; // Skip files without diffs (e.g., binary)

    message += `### ${file.filename} (${file.status})\n`;
    message += `+${file.additions} -${file.deletions}\n\n`;
    message += `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
  });

  return message;
}

/**
 * Sends the PR to Claude for review and returns a structured result.
 *
 * @param {Anthropic} client - Anthropic API client
 * @param {Object} prContext - PR context from github.js
 * @param {Object} config - Merged config from config.js
 * @param {string} variant - Review variant (default/strict/lenient/security-only)
 * @returns {Object} Structured review: { approved, issues, summary }
 */
async function reviewCode(client, prContext, config, variant = 'default', extraContext = {}) {
  const systemPrompt = loadSystemPrompt();
  const userMessage = buildUserMessage(prContext, config, variant, extraContext);

  // ─── Call Claude ───
  console.log(`Sending ${prContext.stats.totalFiles} files to Claude for review...`);
  console.log(`Total diff size: ~${userMessage.length} characters`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userMessage },
    ],
  });

  // ─── Parse response ───
  const responseText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  let review;
  try {
    // Claude should return JSON, but sometimes it wraps it in markdown code blocks
    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) ||
                      responseText.match(/```\s*([\s\S]*?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : responseText;
    review = JSON.parse(jsonStr);
  } catch (parseError) {
    console.error('Failed to parse Claude response as JSON. Raw response:');
    console.error(responseText.substring(0, 500));

    // Return a fallback review with the raw text as a single comment
    return {
      approved: false,
      summary: 'The review agent encountered an issue parsing the review. See raw output below.',
      issues: [{
        severity: 'warning',
        category: 'agent-error',
        title: 'Review parsing error',
        file: 'N/A',
        line: null,
        description: `The agent could not produce structured output. Raw response:\n\n${responseText.substring(0, 2000)}`,
        suggestion: 'Try running /review again. If this persists, the system prompt may need adjustment.',
      }],
    };
  }

  // ─── Apply guardrail overrides ───
  review.issues = applyGuardrailOverrides(review.issues || [], config);

  // ─── Determine approval ───
  const blocking = review.issues.filter(i => i.severity === 'blocking');
  const warnings = review.issues.filter(i => i.severity === 'warning');

  review.approved = blocking.length === 0 &&
    (config.guardrails.approval.max_warnings_before_block === 0 ||
     warnings.length <= config.guardrails.approval.max_warnings_before_block);

  return review;
}

/**
 * Applies guardrail overrides from the config:
 *   - Promotes checks in always_block to 'blocking'
 *   - Removes checks in ignore list
 *   - Applies category-level severity overrides
 */
function applyGuardrailOverrides(issues, config) {
  return issues
    // Remove ignored checks
    .filter(issue => {
      const checkId = (issue.check_id || issue.title || '').toLowerCase().replace(/\s+/g, '-');
      return !config.guardrails.ignore.some(ignored =>
        checkId.includes(ignored.toLowerCase())
      );
    })
    // Apply severity overrides
    .map(issue => {
      const checkId = (issue.check_id || issue.title || '').toLowerCase().replace(/\s+/g, '-');

      // Always-block overrides take highest priority
      if (config.guardrails.always_block.some(blocked =>
        checkId.includes(blocked.toLowerCase())
      )) {
        return { ...issue, severity: 'blocking' };
      }

      // Category-level severity overrides
      const category = (issue.category || '').toLowerCase();
      const categorySeverity = config.guardrails.severity[category];
      if (categorySeverity === 'ignore') {
        return null; // Will be filtered out
      }
      if (categorySeverity && categorySeverity !== issue.severity) {
        // Only override if the config severity is MORE strict
        const levels = { blocking: 3, warning: 2, suggestion: 1 };
        if ((levels[categorySeverity] || 0) > (levels[issue.severity] || 0)) {
          return { ...issue, severity: categorySeverity };
        }
      }

      return issue;
    })
    .filter(Boolean); // Remove nulls from ignored categories
}

module.exports = {
  createClient,
  reviewCode,
  buildUserMessage, // Exported for testing
};
