const acquireVsCodeApi = () => ({ postMessage() {} });
const document = {
  getElementById: () => ({}),
  createElement: () => ({ appendChild() {}, setAttribute() {} }),
};
const window = {
  addEventListener() {},
};
const vscodeApi = acquireVsCodeApi();
const connectButton = {};
const refreshButton = {};
const repositorySelect = {};
const searchInput = {};
const labelFilter = {};
const assigneeFilter = {};
const milestoneFilter = {};
const statusBlock = {};
const issueList = { addEventListener() {} };
const emptyState = {};
const issueSummary = {};
const accountLabel = {};
const automationBadge = { classList: { add() {}, remove() {} } };
const assessmentPanel = { innerHTML: '' };

let latestState = null;
let selectedIssueNumber = undefined;
let latestAssessment = null;

function escapeHtml(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }
  return value.replace(/[&<>"']/g, character => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\'':
        return '&#39;';
      default:
        return character;
    }
  });
}
