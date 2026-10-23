/**
 * Git hosting providers behind one interface (Azure Repos, GitHub, GitLab,
 * Bitbucket): commit statuses / check runs with line annotations, PR comments
 * updated in place, pull requests with CODEOWNERS reviewers, provider
 * detection from the remote URL and CI variables, and change requests built
 * without touching the working tree.
 */
export * from './types.js';
export * from './http.js';
export * from './detect.js';
export * from './github.js';
export * from './gitlab.js';
export * from './bitbucket.js';
export * from './azure.js';
export * from './summary.js';
export * from './factory.js';
export * from './change-request.js';
export * from './report.js';
export * from './tab.js';
