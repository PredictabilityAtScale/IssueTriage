# Privacy Policy for IssueTriage

**Effective Date:** November 9, 2025

## Overview

IssueTriage is a Visual Studio Code extension that helps teams assess issue readiness for implementation. This privacy policy explains what data is collected, how it's used, and your choices regarding data collection.

## Data Collection

### 1. GitHub Data

**What we collect:**
- Repository metadata (name, owner, issue lists)
- Issue content (titles, descriptions, comments, labels, assignees)
- Pull request history and commit data for risk analysis
- Your GitHub username and account information

**How we use it:**
- Display issues within VS Code
- Generate readiness assessments
- Calculate risk intelligence from historical data
- All GitHub data is accessed via your personal access token

**Where it's stored:**
- Locally on your machine in VS Code's storage
- Assessment results stored in local SQLite databases
- Risk profiles cached locally for performance
- **Never transmitted to third parties except as described below**

### 2. OpenRouter API (LLM Assessments)

**What we send:**
- Issue titles and descriptions
- Repository context (when you run assessments)
- Historical risk data (when available)

**How it's used:**
- Generate AI-powered readiness assessments
- Extract keywords for machine learning features

**API modes:**
- **Local mode:** Your OpenRouter API key is stored securely in VS Code SecretStorage and used to call OpenRouter directly
- **Remote mode (default):** Requests are proxied through the IssueTriage Cloudflare Worker, which holds the API key server-side

**Your API key:**
- Stored securely using VS Code's built-in SecretStorage API
- Never logged or transmitted to any party except OpenRouter
- You can remove it anytime via the Sign Out command

### 3. UsageTap Telemetry

**What we collect:**
- LLM request metadata (start time, end time, model used)
- Token usage statistics
- No personal information or issue content is sent

**How it's used:**
- Monitor LLM usage and costs
- Improve automation readiness insights
- Aggregate usage analytics

**Opt-out:**
Set `issuetriage.telemetry.enabled` to `false` in VS Code settings.

### 4. Extension Telemetry

**What we collect:**
- Extension activation events
- Command usage (e.g., "assessment run", "issues refreshed")
- Error events (no sensitive data included)
- Feature usage patterns

**How it's used:**
- Understand which features are used
- Identify and fix bugs
- Improve the extension

**Opt-out:**
Set `issuetriage.telemetry.enabled` to `false` in VS Code settings.

## Data Storage

### Local Storage
- **Assessment database:** `~/.vscode/extensions/PredictabilityAtScale.issuetriage-*/globalStorage/`
- **Risk profiles:** Same directory, separate SQLite database
- **Session tokens:** VS Code SecretStorage (encrypted by VS Code)
- **Settings:** VS Code configuration files

### Remote Storage
- **No remote storage:** IssueTriage does not maintain any user databases or remote storage
- **Cloudflare Worker:** Stateless proxy, does not log or persist requests

## Third-Party Services

### OpenRouter (openrouter.ai)
- Used for AI-powered assessments
- Subject to [OpenRouter's Privacy Policy](https://openrouter.ai/privacy)
- You can use your own API key for full control

### GitHub (github.com)
- Used for repository and issue data access
- Subject to [GitHub's Privacy Policy](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement)
- Authentication via OAuth device flow

### UsageTap (usagetap.com)
- Optional telemetry service for LLM usage tracking
- Subject to [UsageTap's Privacy Policy](https://usagetap.com/privacy)
- Can be disabled via settings

## Your Rights and Choices

### Access and Deletion
- All data is stored locally on your machine
- Delete extension data by:
  1. Uninstalling the extension
  2. Manually deleting the globalStorage directory
  3. Using the "Sign Out" command to clear credentials

### Opt-Out Options
- **Disable telemetry:** Set `issuetriage.telemetry.enabled: false`
- **Use your own API key:** Configure `issuetriage.assessment.apiKey` or use local mode
- **Disconnect GitHub:** Use "Issue Triage: Sign Out" command

### Data Portability
- Assessment data stored in SQLite format
- Export available via "Export Training Dataset" feature
- All data is readable with standard SQLite tools

## Data Security

### Security Measures
- Credentials stored in VS Code SecretStorage (OS-level encryption)
- HTTPS for all external API calls
- Content Security Policy (CSP) on all webviews
- No hardcoded credentials in source code
- API keys managed via environment variables or secure settings

### Cloudflare Worker Security
- HMAC state signing for OAuth flows
- Constant-time comparison for token validation
- Server-side secret management
- No request logging or persistence

## Children's Privacy

IssueTriage is not directed at children under 13. We do not knowingly collect information from children.

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be reflected in the extension repository and the effective date will be updated.

## Contact

For privacy questions or concerns:
- **GitHub Issues:** https://github.com/PredictabilityAtScale/IssueTriage/issues
- **Email:** Create an issue on our GitHub repository

## Open Source

IssueTriage is open source (MIT License). You can review our data handling practices in the source code:
https://github.com/PredictabilityAtScale/IssueTriage

---

**Summary:** IssueTriage stores data locally on your machine, uses your GitHub credentials to access repositories, and optionally sends issue content to OpenRouter for AI assessments. All telemetry can be disabled via settings.
