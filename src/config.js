/**
 * config.js — Reads .code-review.yml from the repo and merges with defaults.
 *
 * If the repo doesn't have a .code-review.yml, sensible defaults are used.
 * Any settings in the repo's file override the defaults.
 */

const yaml = require('js-yaml');

// ─── Default configuration ────────────────────────────────────────
// These apply when a repo doesn't have a .code-review.yml file,
// or when specific settings are missing from their file.
const DEFAULTS = {
  mode: 'manual',          // 'manual' = /review only, 'automatic' = every PR
  jira_enabled: false,     // Don't touch Jira until explicitly enabled

  jira: {
    project_key: 'ABACUS',
    transition_on_approve: 'TESTING',
    comment_on_reject: true,
  },

  guardrails: {
    severity: {
      security: 'blocking',
      bugs: 'blocking',
      performance: 'warning',
      architecture: 'warning',
      code_quality: 'suggestion',
    },
    always_block: [
      'missing-authorize-attribute',
      'sql-injection',
      'secrets-in-code',
      'async-void',
    ],
    ignore: [],
    custom_rules: [],
    approval: {
      block_on: 'blocking',
      auto_approve_suggestions_only: true,
      max_warnings_before_block: 5,
    },
  },

  files: {
    ignore: [
      '**/*.Designer.cs',
      'Migrations/**',
      'wwwroot/lib/**',
      '**/*.min.js',
      '**/*.min.css',
      '**/*.g.cs',
      '**/bin/**',
      '**/obj/**',
    ],
    always_include_for_context: [],
  },
};

/**
 * Loads and merges the repo's .code-review.yml with defaults.
 *
 * @param {import('@octokit/rest').Octokit} octokit - GitHub API client
 * @param {string} owner - Repo owner (org or user)
 * @param {string} repo - Repo name
 * @param {string} ref - Git ref (branch/SHA) to read the config from
 * @param {string} configPath - Path to the config file in the repo
 * @returns {Object} Merged configuration
 */
async function loadConfig(octokit, owner, repo, ref, configPath = '.code-review.yml') {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: configPath,
      ref,
    });

    // GitHub returns file content as base64
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    const repoConfig = yaml.load(content) || {};

    // Deep merge: repo config overrides defaults
    return deepMerge(DEFAULTS, repoConfig);
  } catch (error) {
    if (error.status === 404) {
      // No config file — use all defaults
      console.log('No .code-review.yml found in repo, using defaults.');
      return { ...DEFAULTS };
    }
    console.warn(`Warning: Could not read config file: ${error.message}. Using defaults.`);
    return { ...DEFAULTS };
  }
}

/**
 * Parses the /review command for optional flags.
 * Examples:
 *   "/review"              → { run: true, variant: 'default', dryRun: false }
 *   "/review strict"       → { run: true, variant: 'strict', dryRun: false }
 *   "/review lenient"      → { run: true, variant: 'lenient', dryRun: false }
 *   "/review security-only"→ { run: true, variant: 'security-only', dryRun: false }
 *   "/review dry-run"      → { run: true, variant: 'default', dryRun: true }
 *   "some other comment"   → { run: false }
 */
function parseReviewCommand(commentBody) {
  const trimmed = (commentBody || '').trim().toLowerCase();

  if (!trimmed.startsWith('/review')) {
    return { run: false };
  }

  const parts = trimmed.split(/\s+/);
  const flags = parts.slice(1);

  const dryRun = flags.includes('dry-run');
  const variant = flags.find(f => ['strict', 'lenient', 'security-only'].includes(f)) || 'default';

  return { run: true, variant, dryRun };
}

/**
 * Checks if a file path matches any of the ignore patterns.
 * Supports simple glob patterns: *, **, and exact matches.
 */
function shouldIgnoreFile(filePath, ignorePatterns) {
  for (const pattern of ignorePatterns) {
    if (matchGlob(filePath, pattern)) {
      return true;
    }
  }
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

function matchGlob(filePath, pattern) {
  // Split pattern into segments and build regex
  // Handle each glob feature:
  //   **  = match any number of directories (including zero)
  //   *   = match anything within a single path segment (no /)
  //   ?   = match one character

  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // ** — match any path depth
      if (pattern[i + 2] === '/') {
        regex += '(.+/)?'; // **/ — zero or more directories
        i += 3;
      } else {
        regex += '.*'; // Trailing ** — match everything
        i += 2;
      }
    } else if (ch === '*') {
      regex += '[^/]*'; // * — anything except /
      i++;
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regex += '\\' + ch; // Escape regex special chars
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  return new RegExp(`^${regex}$`).test(filePath);
}

module.exports = {
  DEFAULTS,
  loadConfig,
  parseReviewCommand,
  shouldIgnoreFile,
};
