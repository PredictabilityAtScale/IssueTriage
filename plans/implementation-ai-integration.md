# AI Integration Feature Implementation

## Overview
Added cross-extension integration to send GitHub issues with IssueTriage assessment data to AI coding assistants (GitHub Copilot, Cursor, etc.).

## Components Added

### AIIntegrationService (`src/services/aiIntegrationService.ts`)
A new service that detects available AI coding assistants and formats issue context for them.

**Key Methods:**
- `getAvailableAssistants()` - Detects Cursor, GitHub Copilot, or falls back to clipboard
- `sendToAssistant()` - Sends formatted context to the detected assistant
- `formatIssueContext()` - Creates well-formatted prompt with issue details and assessment
- `getEnvironmentInfo()` - Detects if running in Cursor vs VS Code
- `isWorkspaceRepository()` - Validates that issue repository matches open workspace folder
- `detectWorkspaceRepositorySlug()` - Detects git repository from current VS Code workspace

**Detection Logic:**
```typescript
// Detects environment via vscode.env.appName
const isCursor = appName.toLowerCase().includes('cursor');

// Detects GitHub Copilot via extension API
const copilotChat = vscode.extensions.getExtension('github.copilot-chat');

// Validates workspace repository match
const isWorkspaceRepo = await aiIntegration.isWorkspaceRepository(repository);
if (isWorkspaceRepo === false) {
  // Show warning to user
}
```

**Formatted Context Includes:**
- Repository and issue metadata
- Issue title and description
- IssueTriage assessment scores
- Automation readiness summary
- Pre-implementation questions
- Clear instructions for the AI to implement the issue

### 2. UI Buttons
Added two new buttons to the assessment panel:

**📋 Copy for AI**
- Copies formatted issue context to clipboard
- Works with any AI tool (Copilot, Cursor, Windsurf, etc.)
- Message: "Issue context copied to clipboard!"

**🤖 Send to AI Assistant**
- Automatically detects available AI assistant
- For Cursor: Copies to clipboard and suggests opening Composer (Cmd/Ctrl+I)
- For GitHub Copilot: Opens chat panel and copies context
- Fallback: Copies to clipboard

### 3. Backend Integration
**Extension Message Handlers:**
- `webview.copyIssueForAI` - Fetches issue details, formats context, copies to clipboard
- `webview.sendToAI` - Detects assistant and sends/copies context appropriately

**Service Bundle:**
- Added `aiIntegration: AIIntegrationService` to `ServiceBundle` interface
- Initialized in `activate()` function

### 4. Telemetry
Tracks AI integration usage:
- `ai.copyIssue` - When user copies issue for AI
- `ai.sendToAssistant` - When user sends to AI assistant
- Includes: repository, issue number, assistant ID, whether assessment exists

## User Experience

### Workflow
1. User selects an issue in IssueTriage panel
2. Optionally runs assessment to get automation readiness score
3. Clicks **"📋 Copy for AI"** or **"🤖 Send to AI Assistant"**
4. **Safety Check**: If the issue's repository doesn't match the currently open workspace folder, user gets a warning:
   - "The issue is from 'owner/repo', but your workspace is for a different repository. The AI assistant may not have the correct code context."
   - Options: "Copy Anyway" / "Send Anyway" or "Cancel"
5. Context is formatted with:
   - Issue details
   - Assessment scores and recommendations
   - Clear prompt for implementation
6. User pastes into their preferred AI coding assistant

### Smart Detection
- **In Cursor**: Automatically detects and suggests opening Composer
- **In VS Code with Copilot**: Opens Copilot Chat panel
- **Elsewhere**: Falls back to clipboard with helpful message
- **Workspace Mismatch**: Warns when issue repository ≠ open workspace repository

## Technical Details

### Extension Communication
Uses VS Code's Extension API:
- `vscode.env.appName` - Detect Cursor vs VS Code
- `vscode.extensions.getExtension(id)` - Check if extension installed
- `vscode.commands.executeCommand()` - Trigger commands in other extensions
- `vscode.env.clipboard.writeText()` - Universal clipboard integration

### Context Format Example
```markdown
# GitHub Issue Context

**Repository:** owner/repo
**Issue:** #123
**Title:** Add feature X
**URL:** https://github.com/owner/repo/issues/123

## IssueTriage Assessment

**Automation Readiness Score:** 85.5/100

**Summary:** Issue is well-specified with clear requirements...

**Questions to Address:**
- Which external API endpoint should be used?
- Should errors retry or fail immediately?

## Issue Description

[Full issue body]

---

Please implement this GitHub issue. Consider the assessment recommendations if provided.
```

## Benefits

1. **Streamlined Workflow**: One-click to send issues to AI coding agents
2. **Rich Context**: AI gets assessment data to make better decisions
3. **Tool Agnostic**: Works with any AI assistant via clipboard
4. **Smart Detection**: Adapts to user's environment automatically
5. **Improved Prompt Quality**: Structured format helps AI understand requirements
6. **Safety Validation**: Warns when issue repository doesn't match workspace to prevent confusion

## Testing

### Manual Testing Checklist
- [ ] In VS Code: Verify Copilot detection
- [ ] In Cursor: Verify Cursor detection
- [ ] Test "Copy for AI" button copies to clipboard
- [ ] Test "Send to AI Assistant" opens appropriate tool
- [ ] Verify formatted context includes assessment data
- [ ] Test with and without assessment present
- [ ] **Test workspace mismatch warning**: Open workspace for repo A, select issue from repo B, verify warning appears
- [ ] **Test workspace match**: Open workspace for repo A, select issue from repo A, verify no warning
- [ ] **Test warning actions**: Click "Cancel" and verify operation is aborted
- [ ] **Test warning bypass**: Click "Copy Anyway" / "Send Anyway" and verify operation proceeds
- [ ] Verify telemetry events fire correctly with `workspaceMatch` field

### Test Coverage
Added unit tests in `src/test/aiIntegrationService.test.ts`:
- Environment detection
- Assistant discovery
- Context formatting with/without assessment
- All assistants return valid data

## Future Enhancements

1. **Direct API Integration**: Use public APIs of AI assistants when available
2. **Custom Prompts**: Allow users to customize the context format
3. **Batch Operations**: Send multiple issues at once
4. **Template System**: Different templates for different issue types
5. **GitHub Copilot Chat Participants**: Create a dedicated chat participant for IssueTriage
6. **Cursor API**: Use Cursor's composer API directly when documented

## Related Files Modified
- `src/extension.ts` - Added service, message handlers
- `src/services/aiIntegrationService.ts` - New service (created)
- `src/test/aiIntegrationService.test.ts` - Unit tests (created)
- `src/webview/panel.js` - Added UI buttons and event handlers
- `src/services/assessmentService.ts` - Updated prompt for automation focus (separate change)

## Compatibility
- VS Code: ✅ Full support
- Cursor: ✅ Full support (via clipboard + composer suggestion)
- GitHub Codespaces: ✅ Works via clipboard
- VS Code Web: ✅ Works via clipboard API
