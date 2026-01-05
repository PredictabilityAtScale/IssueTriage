import * as vscode from 'vscode';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { config as loadEnv } from 'dotenv';
import { CredentialService } from './services/credentialService';
import { SettingsService } from './services/settingsService';
import { TelemetryService } from './services/telemetryService';
import { StateService } from './services/stateService';
import { GitHubAuthService } from './services/githubAuthService';
import { GitHubClient } from './services/githubClient';
import type { IssueSummary } from './services/githubClient';
import { IssueManager, FilterState, NewIssueDraftInput, NewIssueAnalysisResult, NewIssueSimilarityMatch } from './issueManager';
import { IssueTreeProvider } from './issueTreeProvider';
import { SidebarMatrixView } from './sidebarMatrixView';
import { UsageTapView } from './usageTapView';
import { AssessmentStorage } from './services/assessmentStorage';
import { AssessmentService, AssessmentError } from './services/assessmentService';
import { CliToolService } from './services/cliToolService';
import { RiskStorage } from './services/riskStorage';
import { RiskIntelligenceService } from './services/riskIntelligenceService';
import { AIIntegrationService } from './services/aiIntegrationService';
import { KeywordExtractionService } from './services/keywordExtractionService';
import { KeywordBackfillService } from './services/keywordBackfillService';
import { HistoricalDataService } from './services/historicalDataService';
import type { ExportResult } from './services/historicalDataService';
import { SimilarityService } from './services/similarityService';
import type { AssessmentRecord } from './services/assessmentStorage';
import type { BackfillProgress, RiskSummary, ExportManifest } from './types/risk';
import { LlmGateway } from './services/llmGateway';
import { UsageTapService } from './services/usageTapService';
import { evaluateRecordReadiness } from './services/assessmentReadiness';

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	const activationStart = Date.now();
	console.log('[IssueTriage] Extension activation started');

	try {
		const envPath = path.join(context.extensionUri.fsPath, '.env');
		if (existsSync(envPath)) {
			loadEnv({ path: envPath });
			console.log('[IssueTriage] Environment variables loaded from .env file');
		}
	} catch (error) {
		console.warn('[IssueTriage] Could not load .env file', error);
	}

	console.log('[IssueTriage] Creating settings service...');
	const settings = new SettingsService();
	console.log('[IssueTriage] Creating state service...');
	const state = new StateService(context.globalState, context.workspaceState);
	console.log('[IssueTriage] Creating LLM gateway...');
	const llmGateway = new LlmGateway(settings);
	const services: ServiceBundle = {
		credentials: new CredentialService(context.secrets),
		settings,
		telemetry: new TelemetryService({ settings }),
		state,
		auth: undefined!,
		github: undefined!,
		issueManager: undefined!,
		assessment: undefined!,
		cliTools: undefined!,
		risk: undefined!,
		historicalData: undefined!,
		keywordExtractor: undefined!,
		similarity: undefined!,
		aiIntegration: new AIIntegrationService(),
		usageTap: undefined!,
		llmGateway,
		extensionUri: context.extensionUri
	};

	context.subscriptions.push(services.telemetry);
	services.telemetry.trackEvent('extension.activate');

	console.log('[IssueTriage] Creating UsageTap service...');
		const usageTap = new UsageTapService(settings, services.telemetry);
	services.usageTap = usageTap;
	context.subscriptions.push(usageTap);

	const secretSubscription = services.credentials.onDidChange(id => {
		services.telemetry.trackEvent('credentials.changed', { scope: id });
	});
	context.subscriptions.push(secretSubscription);

	console.log('[IssueTriage] Creating auth service...');
	const auth = new GitHubAuthService(services.credentials, services.state, services.telemetry, services.llmGateway);
	console.log('[IssueTriage] Creating GitHub client...');
	const github = new GitHubClient(auth, services.settings, services.telemetry);
	console.log('[IssueTriage] Creating CLI tools service...');
	const cliTools = new CliToolService(context.extensionUri.fsPath, services.settings, services.state, services.telemetry);

	console.log('[IssueTriage] Creating assessment storage (SQLite)...');
	const storageStart = Date.now();
	const assessmentStorage = new AssessmentStorage(context.globalStorageUri.fsPath);
	console.log(`[IssueTriage] Assessment storage created in ${Date.now() - storageStart}ms`);

	console.log('[IssueTriage] Creating risk storage (SQLite)...');
	const riskStorageStart = Date.now();
	const riskStorage = new RiskStorage(context.globalStorageUri.fsPath);
	console.log(`[IssueTriage] Risk storage created in ${Date.now() - riskStorageStart}ms`);

	console.log('[IssueTriage] Creating ML services...');
	const keywordExtractor = new KeywordExtractionService(services.settings, services.telemetry, services.llmGateway, usageTap);
	const similarity = new SimilarityService(riskStorage);
	const keywordBackfill = new KeywordBackfillService(riskStorage, github, keywordExtractor, services.telemetry);
	const historicalData = new HistoricalDataService(riskStorage, context.globalStorageUri.fsPath, services.telemetry);

	console.log('[IssueTriage] Creating risk intelligence service...');
	const risk = new RiskIntelligenceService(riskStorage, github, services.settings, services.telemetry, keywordExtractor);

	console.log('[IssueTriage] Creating assessment service...');
	const assessment = new AssessmentService(assessmentStorage, services.settings, services.telemetry, github, cliTools, risk, services.llmGateway, usageTap);

	console.log('[IssueTriage] Creating issue manager...');
	const issueManager = new IssueManager(
		auth,
		github,
		services.settings,
		services.state,
		services.telemetry,
		risk,
		assessment,
		keywordExtractor,
		similarity
	);

	services.auth = auth;
	services.github = github;
	services.issueManager = issueManager;
	services.assessment = assessment;
	services.cliTools = cliTools;
	services.risk = risk;
	services.historicalData = historicalData;
	services.keywordExtractor = keywordExtractor;
	services.similarity = similarity;

	context.subscriptions.push(issueManager);
	context.subscriptions.push(new vscode.Disposable(() => assessment.dispose()));
	context.subscriptions.push(cliTools);
	context.subscriptions.push(risk);
	context.subscriptions.push(keywordBackfill);

	console.log('[IssueTriage] Initializing issue manager...');
	const initStart = Date.now();
	void issueManager.initialize().catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		services.telemetry.trackEvent('issueManager.initializeFailed', { message });
		console.error('[IssueTriage] Issue manager initialization failed:', error);
	}).finally(() => {
		console.log(`[IssueTriage] Issue manager initialized in ${Date.now() - initStart}ms`);
	});

	console.log(`[IssueTriage] Extension activation completed in ${Date.now() - activationStart}ms`);

	// Create tree view for sidebar
	const issueTreeProvider = new IssueTreeProvider(issueManager, assessment);
	const treeView = vscode.window.createTreeView('issuetriage.issuesView', {
		treeDataProvider: issueTreeProvider,
		showCollapseAll: true
	});
	context.subscriptions.push(treeView);

	const sidebarMatrixView = new SidebarMatrixView(context.extensionUri, issueManager);
	context.subscriptions.push(sidebarMatrixView);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('issuetriage.matrixOverview', sidebarMatrixView)
	);

	const usageTapView = new UsageTapView(usageTap);
	context.subscriptions.push(usageTapView);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('issuetriage.usageView', usageTapView)
	);
	void usageTap.ensureCustomerProvisioned().catch(error => {
		console.warn('[IssueTriage] Failed to provision UsageTap customer during activation:', error);
	});

	const openPanel = vscode.commands.registerCommand('issuetriage.openPanel', () => {
		IssueTriagePanel.createOrShow(services);
	});

	context.subscriptions.push(openPanel);

	let assessmentInProgress = false;
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.name = 'Issue Triage';
	statusBarItem.command = 'issuetriage.openPanel';
	const updateStatusBar = () => {
		const mode = services.llmGateway.getMode();
		const label = mode === 'remote' ? 'Remote Proxy' : 'Local Direct';
		if (assessmentInProgress) {
			statusBarItem.text = '$(sync~spin) Issue Triage (Assessing…)';
		} else {
			statusBarItem.text = `$(list-tree) Issue Triage (${label})`;
		}
		const tooltipLines = [
			'Open the Issue Triage panel',
			`LLM mode: ${label}`,
			'GitHub auth: Cloudflare worker proxy'
		];
		if (assessmentInProgress) {
			tooltipLines.push('Assessment in progress…');
		}
		if (mode === 'remote') {
			tooltipLines.push(`Proxy endpoint: ${services.llmGateway.getRemoteBaseUrl()}`);
		} else {
			tooltipLines.push('Assessments call OpenRouter directly with your local API key.');
		}
		statusBarItem.tooltip = tooltipLines.join('\n');
	};
	updateStatusBar();
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);
	void vscode.commands.executeCommand('setContext', 'issuetriage.assessmentInProgress', false);
	const setAssessmentInProgress = (value: boolean) => {
		if (assessmentInProgress === value) {
			return;
		}
		assessmentInProgress = value;
		void vscode.commands.executeCommand('setContext', 'issuetriage.assessmentInProgress', value);
		updateStatusBar();
	};

	const configurationSubscription = vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('issuetriage.assessment.llmMode') || event.affectsConfiguration('issuetriage.assessment.remoteEndpoint') || event.affectsConfiguration('issuetriage.assessment.apiKey')) {
			updateStatusBar();
		}
	});
	context.subscriptions.push(configurationSubscription);

	const connectRepository = vscode.commands.registerCommand('issuetriage.connectRepository', async () => {
		await services.issueManager.connectRepository();
	});

	const changeRepository = vscode.commands.registerCommand('issuetriage.changeRepository', async () => {
		await services.issueManager.changeRepository();
	});
	const refreshIssues = vscode.commands.registerCommand('issuetriage.refreshIssues', async () => {
		await services.issueManager.refreshIssues(true);
	});
	const assessIssue = vscode.commands.registerCommand('issuetriage.assessIssue', async (treeItemOrIssueNumber?: unknown, explicitIssueNumber?: number) => {
		if (assessmentInProgress) {
			void vscode.window.showInformationMessage('An assessment is already running. Please wait for it to finish.');
			return;
		}
		const snapshot = services.issueManager.getSnapshot();
		const repository = snapshot.selectedRepository;
		if (!repository) {
			void vscode.window.showWarningMessage('Select a repository before running an assessment.');
			return;
		}
		const issues = snapshot.issues;
		if (!issues.length) {
			void vscode.window.showWarningMessage('No issues available to assess. Refresh the list and try again.');
			return;
		}

		const extractIssueNumber = (input: unknown): number | undefined => {
			if (typeof input === 'number' && Number.isInteger(input)) {
				return input;
			}
			if (!input || typeof input !== 'object') {
				return undefined;
			}
			const candidate = input as { issueNumber?: unknown; metadata?: unknown };
			if (typeof candidate.issueNumber === 'number' && Number.isInteger(candidate.issueNumber)) {
				return candidate.issueNumber;
			}
			const metadata = candidate.metadata as { issueNumber?: unknown } | undefined;
			if (metadata && typeof metadata.issueNumber === 'number' && Number.isInteger(metadata.issueNumber)) {
				return metadata.issueNumber;
			}
			return undefined;
		};

		const issueNumberFromArgs = extractIssueNumber(explicitIssueNumber) ?? extractIssueNumber(treeItemOrIssueNumber);

		const pickIssueNumber = async (): Promise<number | undefined> => {
			const picks = issues.map(issue => ({
				label: `#${issue.number} · ${issue.title}`,
				issueNumber: issue.number
			}));
			const selection = await vscode.window.showQuickPick(picks, {
				placeHolder: 'Select an issue to assess'
			});
			return selection?.issueNumber;
		};

		const issueNumber = issueNumberFromArgs ?? await pickIssueNumber();
		if (typeof issueNumber !== 'number') {
			return;
		}

		const issue = issues.find(candidate => candidate.number === issueNumber)
			?? services.issueManager.getAllIssues().find(candidate => candidate.number === issueNumber);
		if (issue?.state === 'closed') {
			const result = services.issueManager.analyzeRiskSignals(issueNumber, { force: true });
			if (!result.success) {
				if (result.message) {
					void vscode.window.showWarningMessage(result.message);
				}
				return;
			}
			void vscode.window.showInformationMessage(`Collecting risk signals for issue #${issueNumber}.`);
			return;
		}

		setAssessmentInProgress(true);
		try {
			IssueTriagePanel.createOrShow(services);

			await vscode.window.withProgress({
				title: `Assessing issue #${issueNumber}`,
				location: vscode.ProgressLocation.Notification
			}, async progress => {
				progress.report({ message: 'Requesting analysis from LLM service' });
				try {
					const record = await services.assessment.assessIssue(repository.fullName, issueNumber);
					const composite = record.compositeScore.toFixed(1);
					IssueTriagePanel.broadcastAssessment(record);
					void services.issueManager.refreshIssues(false);
					vscode.window.showInformationMessage(`IssueTriage assessment complete for #${issueNumber} (Composite ${composite}).`);
				} catch (error) {
					const userMessage = formatAssessmentError(error);
					vscode.window.showErrorMessage(`Assessment failed: ${userMessage}`);
				}
			});
		} finally {
			setAssessmentInProgress(false);
		}
	});

	const runContextTool = vscode.commands.registerCommand('issuetriage.runContextTool', async () => {
		const tools = services.cliTools.listTools().filter(tool => tool.enabled);
		if (!tools.length) {
			void vscode.window.showInformationMessage('No CLI context tools are available. Configure tools in IssueTriage settings.');
			return;
		}
		const picks = tools.map(tool => {
			const commandPreview = [tool.command, ...tool.args].join(' ').trim();
			const detail = tool.source === 'builtin'
				? 'Source: built-in tool'
				: (commandPreview.length > 80 ? `${commandPreview.slice(0, 77)}...` : commandPreview);
			return {
				label: tool.title,
				description: tool.description ?? (tool.source === 'builtin' ? 'Built-in CLI tool' : 'Workspace CLI tool'),
				detail,
				toolId: tool.id
			};
		});
		const selection = await vscode.window.showQuickPick(picks, {
			placeHolder: 'Select a CLI context tool to run'
		});
		if (!selection) {
			return;
		}
		try {
			const result = await vscode.window.withProgress({
				title: `Running ${selection.label}`,
				location: vscode.ProgressLocation.Notification
			}, () => services.cliTools.runTool(selection.toolId, { reason: 'manual', force: true }));
			const message = result.success
				? `${selection.label} completed in ${result.durationMs}ms.`
				: `${selection.label} failed (exit ${result.exitCode ?? 'n/a'}).`;
			const action = await vscode.window.showInformationMessage(message, 'View Output');
			if (action === 'View Output') {
				services.cliTools.showOutput();
			}
		} catch (error) {
			const description = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Failed to run ${selection.label}: ${description}`);
		}
	});
	
	const backfillKeywords = vscode.commands.registerCommand('issuetriage.backfillKeywords', async (mode?: 'missing' | 'all') => {
		const snapshot = services.issueManager.getSnapshot();
		const repository = snapshot.selectedRepository;
		if (!repository) {
			void vscode.window.showWarningMessage('Select a repository before backfilling keywords.');
			return;
		}

		const effectiveMode: 'missing' | 'all' = mode === 'all' ? 'all' : 'missing';
		const confirmationMessage = effectiveMode === 'all'
			? `This will regenerate keywords for every closed issue in ${repository.fullName}, even if they already have keywords. This may use significant API tokens. Continue?`
			: `This will extract keywords for closed issues missing them in ${repository.fullName}. This may use significant API tokens. Continue?`;

		const confirmation = await vscode.window.showWarningMessage(
			confirmationMessage,
			{ modal: true },
			'Yes', 'No'
		);

		if (confirmation !== 'Yes') {
			IssueTriagePanel.broadcastBackfillComplete({
				success: false,
				error: 'Keyword backfill cancelled.'
			});
			return;
		}

		await vscode.window.withProgress({
			title: effectiveMode === 'all'
				? `Refreshing keywords for ${repository.fullName}`
				: `Backfilling keywords for ${repository.fullName}`,
			location: vscode.ProgressLocation.Notification,
			cancellable: true
		}, async (progress, token) => {
			token.onCancellationRequested(() => {
				keywordBackfill.cancel();
			});

			progress.report({ message: 'Preparing keyword backfill...' });

			const progressDisposable = keywordBackfill.onProgress(p => {
				progress.report({ message: formatBackfillProgressMessage(p) });
				IssueTriagePanel.broadcastBackfillProgress(mapBackfillProgressForPanel(p));
			});

			try {
				const result = await keywordBackfill.backfillKeywords(repository.fullName, {
					delayMs: 500,
					maxTokensPerRun: 200000,
					mode: effectiveMode,
					batchSize: effectiveMode === 'missing' ? 50 : undefined
				});

				const durationMs = calculateBackfillDuration(result);
				if (result.status === 'completed') {
					vscode.window.showInformationMessage(
						`Keyword backfill complete: ${result.successCount} succeeded, ${result.failureCount} failed. Tokens used: ${result.tokensUsed}`
					);
				} else if (result.status === 'cancelled') {
					vscode.window.showWarningMessage('Keyword backfill was cancelled.');
				} else {
					const failureMessage = result.errors[0]?.message ?? 'Unknown error';
					vscode.window.showErrorMessage(`Keyword backfill failed: ${failureMessage}`);
				}

				IssueTriagePanel.broadcastBackfillComplete({
					success: result.status === 'completed',
					result,
					durationMs,
					error: result.status === 'completed' ? undefined : result.errors[0]?.message
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				IssueTriagePanel.broadcastBackfillComplete({ success: false, error: message });
				vscode.window.showErrorMessage(`Keyword backfill failed: ${message}`);
			} finally {
				progressDisposable.dispose();
			}
		});
	});

	const trainModel = vscode.commands.registerCommand('issuetriage.trainModel', async () => {
		const snapshot = services.issueManager.getSnapshot();
		const repository = snapshot.selectedRepository;
		if (!repository) {
			void vscode.window.showWarningMessage('Select a repository before training.');
			return undefined;
		}

		return vscode.window.withProgress({
			title: `Exporting dataset for ${repository.fullName}`,
			location: vscode.ProgressLocation.Notification
		}, async (progress): Promise<ExportResult> => {
			progress.report({ message: 'Validating dataset...' });

			try {
				const result = await historicalData.exportDataset({
					repository: repository.fullName,
					minKeywordCoverage: 0.95
				});

				console.log('[IssueTriage] Export dataset completed', {
					success: result.success,
					snapshots: result.manifest.snapshotsExported,
					coverage: result.manifest.keywordCoveragePct
				});

				await recordLastExport(services.state, repository.fullName, result);

				const validationErrors = result.manifest.validationReport?.errors ?? [];

				if (result.success) {
					const message = `Dataset export complete! ${result.manifest.snapshotsExported} snapshots with ${result.manifest.keywordCoveragePct.toFixed(1)}% keyword coverage.`;
					void vscode.window.showInformationMessage(message, 'View Manifest').then(async action => {
						if (action === 'View Manifest') {
							try {
								const doc = await vscode.workspace.openTextDocument(result.manifestPath);
								await vscode.window.showTextDocument(doc);
							} catch (error) {
								const description = error instanceof Error ? error.message : String(error);
								void vscode.window.showErrorMessage(`Unable to open manifest: ${description}`);
							}
						}
					});
				} else {
					const errors = validationErrors.join('\n') || 'Dataset validation failed validation checks.';
					void vscode.window.showWarningMessage(`Dataset validation warnings:\n${errors}`);
				}

				// Don't broadcast here - let handleExportDataset do it after command returns
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Dataset export failed: ${message}`);
				// Don't broadcast here - let handleExportDataset catch and broadcast
				throw error;
			}
		});
	});
	
	const signOut = vscode.commands.registerCommand('issuetriage.signOut', async () => {
		await services.issueManager.signOut();
	});

	const filterByReadiness = vscode.commands.registerCommand('issuetriage.filterByReadiness', async (firstArg?: unknown, secondArg?: unknown) => {
		const candidate = typeof secondArg === 'string' ? secondArg : (typeof firstArg === 'string' ? firstArg : undefined);
		const active = issueTreeProvider.setFilter(candidate);
		services.telemetry.trackEvent('tree.filterByReadiness', { category: active ?? 'cleared' });
	});

	const sendToAutomation = vscode.commands.registerCommand('issuetriage.sendToAutomation', async (item?: unknown, rawIssueNumber?: unknown) => {
		const snapshot = services.issueManager.getSnapshot();
		const repository = snapshot.selectedRepository;
		if (!repository) {
			void vscode.window.showWarningMessage('No repository connected.');
			return;
		}

		// Extract issue number from tree item or use selected issue
		let issueNumber: number | undefined;
		if (typeof rawIssueNumber === 'number') {
			issueNumber = rawIssueNumber;
		}
		if (!issueNumber && item && typeof item === 'object') {
			const treeItem = item as { metadata?: { issueNumber?: number }; label?: string };
			const metadataNumber = treeItem.metadata?.issueNumber;
			if (typeof metadataNumber === 'number') {
				issueNumber = metadataNumber;
			}
			if (!issueNumber && typeof treeItem.label === 'string') {
				const match = treeItem.label.match(/^#(\d+)/);
				if (match) {
					issueNumber = parseInt(match[1], 10);
				}
			}
		}

		if (!issueNumber) {
			void vscode.window.showWarningMessage('No issue selected.');
			return;
		}

		const automationEnabled = services.settings.get<boolean>('automation.launchEnabled', false);
		if (!automationEnabled) {
			const action = await vscode.window.showWarningMessage(
				`Automation launch is currently disabled. Enable it in settings to send issues to the coding agent.`,
				'Open Settings'
			);
			if (action === 'Open Settings') {
				await vscode.commands.executeCommand('workbench.action.openSettings', 'issuetriage.automation.launchEnabled');
			}
			return;
		}

		const confirmation = await vscode.window.showInformationMessage(
			`Send issue #${issueNumber} to automation coding agent?`,
			{ modal: true },
			'Yes', 'No'
		);

		if (confirmation === 'Yes') {
			services.telemetry.trackEvent('automation.sendIssue', { 
				repository: repository.fullName,
				issueNumber: issueNumber.toString()
			});
			void vscode.window.showInformationMessage(`Issue #${issueNumber} queued for automation (placeholder - integration pending).`);
		}
	});

	context.subscriptions.push(connectRepository, changeRepository, refreshIssues, assessIssue, runContextTool, backfillKeywords, trainModel, signOut, filterByReadiness, sendToAutomation);
}

// This method is called when your extension is deactivated
export function deactivate() {}

interface ServiceBundle {
	credentials: CredentialService;
	settings: SettingsService;
	telemetry: TelemetryService;
	state: StateService;
	auth: GitHubAuthService;
	github: GitHubClient;
	issueManager: IssueManager;
	assessment: AssessmentService;
	cliTools: CliToolService;
	risk: RiskIntelligenceService;
	historicalData: HistoricalDataService;
	keywordExtractor: KeywordExtractionService;
	similarity: SimilarityService;
	aiIntegration: AIIntegrationService;
	usageTap: UsageTapService;
	llmGateway: LlmGateway;
	extensionUri: vscode.Uri;
}

interface PanelBackfillProgress {
	completed: number;
	total: number;
	current?: string;
	successCount: number;
	failureCount: number;
	skippedCount: number;
	tokensUsed: number;
	status: BackfillProgress['status'];
	mode?: 'missing' | 'all';
}

interface PanelBackfillCompletePayload {
	success: boolean;
	result?: BackfillProgress;
	durationMs?: number;
	error?: string;
}

const LAST_EXPORT_STATE_KEY = 'issuetriage.mlTraining.lastExport';

interface StoredExportRecord {
	repository: string;
	success: boolean;
	manifest: ExportManifest;
	manifestPath: string;
	datasetPath: string;
	storedAt: string;
}

async function recordLastExport(state: StateService, repository: string, result: ExportResult): Promise<void> {
	if (!result.success) {
		return;
	}
	try {
		const existing = {
			...(state.getWorkspace<Record<string, StoredExportRecord>>(LAST_EXPORT_STATE_KEY, {}) ?? {})
		};
		existing[repository] = {
			repository,
			success: true,
			manifest: result.manifest,
			manifestPath: result.manifestPath,
			datasetPath: result.datasetPath,
			storedAt: new Date().toISOString()
		};
		await state.updateWorkspace(LAST_EXPORT_STATE_KEY, existing);
	} catch (error) {
		console.warn('[IssueTriage] Failed to persist last export record', error);
	}
}

function mapBackfillProgressForPanel(progress: BackfillProgress): PanelBackfillProgress {
	return {
		completed: progress.processedIssues,
		total: progress.totalIssues,
		current: progress.currentIssue ? `#${progress.currentIssue}` : undefined,
		successCount: progress.successCount,
		failureCount: progress.failureCount,
		skippedCount: progress.skippedCount,
		tokensUsed: progress.tokensUsed,
		status: progress.status,
		mode: progress.mode
	};
}

function formatBackfillProgressMessage(progress: BackfillProgress): string {
	const parts: string[] = [];
	if (progress.status === 'completed') {
		parts.push('Completed');
	} else if (progress.status === 'cancelled') {
		parts.push('Cancelling...');
	} else {
		parts.push('Processing...');
	}
	if (progress.currentIssue) {
		parts.push(`Issue #${progress.currentIssue}`);
	}
	if (progress.totalIssues > 0) {
		parts.push(`${progress.processedIssues}/${progress.totalIssues} issues`);
	} else {
		parts.push(`${progress.processedIssues} issues`);
	}
	parts.push(`${progress.successCount} succeeded`);
	if (progress.failureCount > 0) {
		parts.push(`${progress.failureCount} failed`);
	}
	if (progress.skippedCount > 0) {
		parts.push(`${progress.skippedCount} skipped`);
	}
	if (progress.tokensUsed > 0) {
		parts.push(`${progress.tokensUsed} tokens`);
	}
	return parts.join(' · ');
}

function calculateBackfillDuration(progress: BackfillProgress): number | undefined {
	const started = Date.parse(progress.startedAt);
	if (!Number.isFinite(started)) {
		return undefined;
	}
	const completedRaw = progress.completedAt ? Date.parse(progress.completedAt) : undefined;
	const end = typeof completedRaw === 'number' && Number.isFinite(completedRaw) ? completedRaw : Date.now();
	return Math.max(0, end - started);
}

class IssueTriagePanel {
	public static readonly viewType = 'issuetriage.panel';
	private static currentPanel: IssueTriagePanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly services: ServiceBundle;
	private disposables: vscode.Disposable[] = [];
	private readonly stateListener: vscode.Disposable;
	private lastExportSignature?: string;

	public static broadcastAssessment(record: AssessmentRecord): void {
		IssueTriagePanel.currentPanel?.postAssessment(record);
	}

	public static broadcastBackfillProgress(progress: PanelBackfillProgress): void {
		IssueTriagePanel.currentPanel?.panel.webview.postMessage({
			type: 'ml.backfillProgress',
			progress
		});
	}

	public static broadcastBackfillComplete(payload: PanelBackfillCompletePayload): void {
		IssueTriagePanel.currentPanel?.panel.webview.postMessage({
			type: 'ml.backfillComplete',
			...payload
		});
	}

	public static broadcastExportComplete(payload: {
		success: boolean;
		manifest?: any;
		manifestPath?: string;
		datasetPath?: string;
		error?: string;
	}): void {
		IssueTriagePanel.currentPanel?.panel.webview.postMessage({
			type: 'ml.exportComplete',
			...payload
		});
	}

	public static createOrShow(services: ServiceBundle) {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (IssueTriagePanel.currentPanel) {
			IssueTriagePanel.currentPanel.panel.reveal(column);
			IssueTriagePanel.currentPanel.update();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			IssueTriagePanel.viewType,
			'Issue Triage',
			column,
			{
				enableScripts: true
			}
		);

		IssueTriagePanel.currentPanel = new IssueTriagePanel(panel, services);
	}

	private constructor(panel: vscode.WebviewPanel, services: ServiceBundle) {
		this.panel = panel;
		this.services = services;

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.update();
		this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message), undefined, this.disposables);
		this.stateListener = this.services.issueManager.onDidChangeState(state => {
			this.postState(state);
		});
		this.disposables.push(this.stateListener);
		
		// Send initial state immediately after HTML is set
		// This ensures the webview has the current state even if webview.ready message is delayed
		const initialState = this.services.issueManager.getSnapshot();
		this.postState(initialState);
	}

	private update() {
		this.panel.title = 'Issue Triage';
		this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
		this.services.telemetry.trackEvent('panel.rendered');
	}

	public dispose() {
		IssueTriagePanel.currentPanel = undefined;

		while (this.disposables.length) {
			const disposable = this.disposables.pop();
			if (disposable) {
				disposable.dispose();
			}
		}
		this.panel.dispose();
	}

	private getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = `default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; frame-src https://usagetap.com;`;

		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.services.extensionUri, 'dist', 'webview', 'panel.js'));
		const styles = this.getStyles(nonce);
		const bodyContent = this.getBodyContent(nonce);

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta http-equiv="Content-Security-Policy" content="${csp}">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Issue Triage</title>
			${styles}
		</head>
		<body>
			${bodyContent}
			<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
		</html>`;
	}

	private getStyles(nonce: string): string {
		return `<style nonce="${nonce}">
				:root {
					color-scheme: light dark;
					font-family: var(--vscode-font-family, Segoe WPC, Segoe UI, sans-serif);
					font-size: 13px;
				}

				body {
					margin: 0;
					padding: 0;
					background: var(--vscode-editor-background, #1e1e1e);
					color: var(--vscode-editor-foreground, #cccccc);
				}

				.visually-hidden {
					position: absolute;
					width: 1px;
					height: 1px;
					padding: 0;
					margin: -1px;
					overflow: hidden;
					clip: rect(0, 0, 0, 0);
					white-space: nowrap;
					border: 0;
				}

				.header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					padding: 16px;
					border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				}

				.header-left {
					display: flex;
					flex-direction: column;
					gap: 4px;
				}

				.header h1 {
					font-size: 18px;
					margin: 0;
				}

				.toolbar {
					display: flex;
					gap: 8px;
					align-items: center;
				}

				button, select, input[type="search"] {
					font: inherit;
					padding: 6px 10px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: var(--vscode-editor-background);
					color: inherit;
					outline: none;
				}

				button:focus-visible,
				select:focus-visible,
				input[type="search"]:focus-visible,
				.issue-card:focus-visible,
				.issue-action:focus-visible,
				.button-link:focus-visible,
				.state-tab:focus-visible,
				.compact-button:focus-visible {
					outline: 2px solid var(--vscode-focusBorder, #0078d4);
					outline-offset: 2px;
				}

				button.primary {
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					border-color: transparent;
				}

				button:disabled {
					opacity: 0.6;
					cursor: not-allowed;
				}

			.state-tabs {
				display: flex;
				gap: 4px;
				padding: 12px 16px 0 16px;
				border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			}

			.state-tab {
				padding: 8px 16px;
				border: none;
				background: transparent;
				color: var(--vscode-descriptionForeground);
				cursor: pointer;
				border-bottom: 2px solid transparent;
				font-weight: 500;
			}

			.state-tab.active {
				color: var(--vscode-foreground);
				border-bottom-color: var(--vscode-button-background);
			}

			.state-tab:hover:not(.active) {
				background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
			}

			.filters-bar {
				display: flex;
				gap: 12px;
				padding: 12px 16px;
				border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-button-background) 5%);
				flex-wrap: wrap;
				align-items: flex-end;
			}

			.filter-group {
				display: flex;
				flex-direction: column;
				gap: 4px;
				min-width: 140px;
			}

			.filter-group.search-group {
				flex: 1;
				min-width: 200px;
			}

		.filter-group.repo-group {
			min-width: 280px;
		}

		.filter-group.readiness-group {
			min-width: 180px;
		}

		.repo-controls {
			display: flex;
			gap: 8px;
			align-items: center;
		}

		.repo-controls select {
			flex: 1;
		}

		.compact-button {
			padding: 6px 12px;
			font-size: 12px;
			white-space: nowrap;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border-color: transparent;
		}

		.filter-label {
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--vscode-descriptionForeground, var(--vscode-foreground));
			font-weight: 600;
		}

		.container {
			display: grid;
			grid-template-columns: 1fr;
			height: calc(100vh - 160px);
		}

			@media (min-width: 960px) {
				.container {
					grid-template-columns: 1fr 1fr;
				}
			}

			.issue-list-panel {
				border-right: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				padding: 16px;
				overflow-y: auto;
				display: flex;
				flex-direction: column;
				gap: 12px;
				position: relative;
			}

		.issue-list-panel[hidden],
		.matrix-panel[hidden],
		.llm-usage-panel[hidden],
		.detail-panel[hidden] {
			display: none;
		}

		.analysis-actions {
			display: flex;
			justify-content: flex-end;
			align-items: center;
		}

		.analysis-actions[hidden] {
			display: none;
		}

		.overview-grid {
			display: grid;
			gap: 12px;
			grid-template-columns: repeat(auto-fit, minmax(clamp(100px, 22vw, 160px), 1fr));
		}

		.overview-card {
			border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			border-radius: 6px;
			padding: 12px;
			background: color-mix(in srgb, var(--vscode-editor-background) 93%, var(--vscode-button-background) 7%);
		}

		.overview-card h3 {
			margin: 0;
			font-size: 13px;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--vscode-descriptionForeground, var(--vscode-foreground));
		}

		.overview-value {
			font-size: 24px;
			font-weight: 600;
			margin: 8px 0 4px;
		}			.overview-subtitle {
				margin: 0;
				font-size: 12px;
				color: var(--vscode-descriptionForeground, var(--vscode-foreground));
			}

			.overview-empty {
				border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				border-radius: 6px;
				padding: 16px;
				text-align: center;
				color: var(--vscode-descriptionForeground, var(--vscode-foreground));
			}

			.overview-readiness .readiness-distribution {
				list-style: none;
				margin: 12px 0 0;
				padding: 0;
				display: grid;
				gap: 8px;
			}

			.readiness-distribution li {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 8px;
				font-size: 12px;
			}

			.readiness-label {
				flex: 1;
			}

			.readiness-dot {
				width: 10px;
				height: 10px;
				border-radius: 999px;
				display: inline-block;
			}

			.readiness-dot.readiness-ready {
				background: rgba(46, 160, 67, 0.8);
			}

			.readiness-dot.readiness-prepare {
				background: rgba(187, 128, 9, 0.8);
			}

			.readiness-dot.readiness-review {
				background: rgba(229, 140, 33, 0.8);
			}

			.readiness-dot.readiness-manual {
				background: rgba(229, 83, 75, 0.8);
			}

			.loading-state {
				position: absolute;
				top: 0;
				left: 0;
				right: 0;
				bottom: 0;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				gap: 12px;
				background: color-mix(in srgb, var(--vscode-editor-background) 85%, transparent 15%);
				backdrop-filter: blur(2px);
				z-index: 1;
			}

			.loading-state[hidden] {
				display: none;
			}

			.loading-spinner {
				width: 28px;
				height: 28px;
				border-radius: 50%;
				border: 3px solid color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent 80%);
				border-top-color: var(--vscode-button-background);
				animation: issuetriage-spin 0.9s linear infinite;
			}

			@keyframes issuetriage-spin {
				from {
					transform: rotate(0deg);
				}
				to {
					transform: rotate(360deg);
				}
			}

			.detail-panel {
				padding: 16px;
				overflow-y: auto;
			}

				.backfill-panel {
					margin-top: 24px;
					padding: 16px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-button-background) 4%);
					display: flex;
					flex-direction: column;
					gap: 12px;
				}

				.backfill-header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
				}

				.backfill-header h2 {
					margin: 0;
					font-size: 16px;
				}

				.backfill-body {
					display: flex;
					flex-direction: column;
					gap: 16px;
				}

				.backfill-columns {
					display: grid;
					gap: 16px;
					grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
				}

				.backfill-section {
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
					padding: 12px;
					background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-button-background) 6%);
					display: flex;
					flex-direction: column;
					gap: 12px;
				}

				.backfill-section header {
					display: flex;
					flex-direction: column;
					gap: 2px;
				}

				.backfill-section h3 {
					margin: 0;
					font-size: 14px;
				}

				.backfill-section p {
					margin: 0;
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.backfill-list {
					margin: 0;
					padding: 0;
					list-style: none;
					display: flex;
					flex-direction: column;
					gap: 10px;
				}

				.backfill-item {
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
					padding: 10px;
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					display: flex;
					flex-direction: column;
					gap: 8px;
				}

				.backfill-item-header {
					display: flex;
					align-items: flex-start;
					justify-content: space-between;
					gap: 8px;
				}

				.backfill-item-title {
					font-weight: 600;
					font-size: 13px;
				}

				.backfill-item-meta {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.backfill-stats {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
					font-size: 12px;
				}

				.backfill-buttons {
					display: flex;
					gap: 8px;
					flex-wrap: wrap;
				}

				.backfill-buttons button {
					padding: 4px 10px;
					font-size: 12px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
					cursor: pointer;
				}

				.backfill-buttons button:hover {
					border-color: var(--vscode-button-background);
				}

				.backfill-empty,
				.backfill-error,
				.backfill-loading {
					padding: 12px;
					border-radius: 6px;
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					text-align: center;
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.backfill-error {
					border-color: rgba(229, 83, 75, 0.55);
					color: rgba(229, 83, 75, 0.95);
				}

				.backfill-badge {
					display: inline-block;
					padding: 2px 6px;
					border-radius: 999px;
					font-size: 11px;
					background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-button-background) 15%);
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				}

				.unlinked-filters {
					display: flex;
					gap: 16px;
					flex-wrap: wrap;
					margin-bottom: 16px;
					padding: 12px;
					border-radius: 6px;
					background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-button-background) 4%);
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
				}

				.unlinked-filters .filter-group {
					display: flex;
					align-items: center;
					gap: 8px;
				}

				.unlinked-filters label {
					font-size: 12px;
					color: var(--vscode-foreground);
					display: flex;
					align-items: center;
					gap: 6px;
				}

				.unlinked-filters select {
					padding: 4px 8px;
					font-size: 12px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: var(--vscode-input-background);
					color: var(--vscode-input-foreground);
					cursor: pointer;
				}

				.unlinked-filters select:hover {
					border-color: var(--vscode-button-background);
				}

				.backfill-section header button[data-bulk-create] {
					margin-top: 8px;
					padding: 6px 12px;
					font-size: 12px;
					border-radius: 4px;
					border: 1px solid var(--vscode-button-background);
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					cursor: pointer;
					font-weight: 600;
				}

				.backfill-section header button[data-bulk-create]:hover {
					background: var(--vscode-button-hoverBackground);
				}

				.backfill-section header button[data-bulk-create]:disabled {
					opacity: 0.5;
					cursor: not-allowed;
				}

			.issue-list {
				display: grid;
				gap: 8px;
			}

			.issue-card {
					padding: 12px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					cursor: pointer;
					transition: border-color 0.1s ease, background 0.1s ease;
				}

				.issue-card-header {
					display: flex;
					align-items: center;
					justify-content: space-between;
					gap: 12px;
					margin-bottom: 8px;
				}

				.issue-card-title {
					display: flex;
					align-items: center;
					gap: 8px;
					min-width: 0;
				}

			.issue-card.selected {
				border-color: var(--vscode-button-background);
				background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-button-background) 20%);
				box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder, var(--vscode-button-background)) 80%, transparent 20%);
			}

			.issue-card:focus-visible {
				border-color: var(--vscode-focusBorder, var(--vscode-button-background));
			}

			.issue-card.issue-state-closed {
				opacity: 0.85;
			}

			.issue-card h3 {
				margin: 0;
				font-size: 14px;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}				.risk-badge {
					padding: 2px 6px;
					border-radius: 999px;
					font-size: 11px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					text-transform: uppercase;
					letter-spacing: 0.05em;
				}

				.risk-badge.risk-low {
					background: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 18%, transparent);
					border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 35%, transparent);
				}

				.risk-badge.risk-medium {
					background: rgba(187, 128, 9, 0.2);
					border-color: rgba(187, 128, 9, 0.4);
				}

				.risk-badge.risk-high {
					background: rgba(229, 83, 75, 0.25);
					border-color: rgba(229, 83, 75, 0.55);
				}

				.risk-badge.risk-pending {
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
					border-style: dashed;
				}

				.risk-badge.risk-error {
					background: rgba(229, 83, 75, 0.15);
					border-color: rgba(229, 83, 75, 0.45);
				}

				.risk-badge.risk-stale {
					border-style: dashed;
				}

				.issue-card-actions {
					display: flex;
					align-items: center;
					gap: 6px;
					flex-wrap: wrap;
					justify-content: flex-end;
				}

				.issue-action-row {
					display: flex;
					align-items: center;
					gap: 8px;
					flex-wrap: wrap;
					margin: 8px 0 6px;
				}

				.issue-action-status {
					font-size: 12px;
					color: var(--vscode-descriptionForeground);
				}

				.issue-action {
					padding: 4px 10px;
					font-size: 12px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					cursor: pointer;
					text-transform: uppercase;
					letter-spacing: 0.05em;
				}

				.issue-action:hover {
					border-color: var(--vscode-button-background);
				}

				.issue-action:disabled {
					opacity: 0.6;
					cursor: not-allowed;
				}

				.meta-row {
					display: flex;
					flex-wrap: wrap;
					gap: 6px;
					font-size: 12px;
				}

			.badge {
				padding: 2px 6px;
				border-radius: 999px;
				background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-button-background) 15%);
			}

			.composite-badge {
				background: color-mix(in srgb, var(--vscode-button-background) 25%, transparent 75%);
				border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			}

			.state-badge {
				background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-descriptionForeground) 10%);
				border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
			}				.status {
					padding: 12px;
					border-radius: 6px;
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					margin-bottom: 16px;
				}

				.empty-state {
					text-align: center;
					padding: 48px 16px;
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
				}

				.assessment-panel {
					margin-top: 24px;
					padding: 16px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-button-background) 4%);
				}

				.assessment-panel h2 {
					margin: 0 0 4px 0;
					font-size: 16px;
				}

				.assessment-panel p {
					margin: 4px 0;
				}

				.assessment-empty,
				.assessment-loading,
				.assessment-error {
					text-align: center;
					padding: 24px 8px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.score-grid {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(clamp(88px, 18vw, 132px), 1fr));
					gap: 12px;
					margin: 16px 0;
				}

				.score-card {
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
					padding: 10px;
					background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
				}

				.score-card strong {
					display: block;
					font-size: 11px;
					text-transform: uppercase;
					letter-spacing: 0.05em;
					margin-bottom: 4px;
				}

				.score-card span {
					font-size: 20px;
					font-weight: 600;
				}

				.recommendations-list {
					margin: 0 0 0 16px;
					padding: 0;
				}

				.recommendations-list li {
					margin-bottom: 6px;
				}

				.question-list {
					margin: 0;
					padding: 0;
					list-style: none;
					display: grid;
					gap: 12px;
				}

				.assessment-question {
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
					padding: 12px;
					background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-button-background) 5%);
				}

				.assessment-question.pending {
					background: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-button-background) 3%);
				}

				.assessment-question.answered {
					border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 45%, transparent 55%);
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-testing-iconPassed, #2ea043) 8%);
				}

				.question-text {
					margin: 0 0 8px 0;
					font-weight: 600;
				}

				.question-form {
					display: flex;
					flex-direction: column;
					gap: 8px;
				}

				.question-form textarea {
					resize: vertical;
					min-height: 72px;
					padding: 8px;
					border-radius: 4px;
					border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
					font: inherit;
					background: var(--vscode-editor-background);
					color: inherit;
				}

				.question-form textarea:focus {
					outline: 1px solid var(--vscode-focusBorder, #0078d4);
					outline-offset: 2px;
				}

				.question-actions {
					display: flex;
					gap: 8px;
					align-items: center;
					flex-wrap: wrap;
				}

				.question-error .question-form textarea {
					border-color: var(--vscode-errorForeground, #f48771);
					box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-errorForeground, #f48771) 60%, transparent 40%);
				}

				.question-error-message {
					color: var(--vscode-errorForeground, #f48771);
					font-size: 12px;
				}

				.question-meta {
					display: flex;
					gap: 8px;
					align-items: center;
					flex-wrap: wrap;
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					margin-bottom: 8px;
				}

				.question-answer-display {
					font-size: 13px;
					line-height: 1.5;
				}

				.question-empty {
					margin: 0;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.assessment-hint {
					margin-top: 12px;
					padding: 10px;
					border-radius: 6px;
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					display: flex;
					gap: 12px;
					align-items: center;
					flex-wrap: wrap;
				}

				.assessment-actions {
					display: flex;
					gap: 8px;
					flex-wrap: wrap;
					margin-top: 16px;
				}

				.button-link {
					background: none;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 4px;
					padding: 6px 10px;
					color: inherit;
					cursor: pointer;
				}

				.button-link:hover {
					border-color: var(--vscode-button-background);
				}

				.automation-badge {
					padding: 2px 8px;
					border-radius: 999px;
					font-size: 11px;
					border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
				}

				.automation-badge.enabled {
					background: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 18%, transparent);
					border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 35%, transparent);
				}

				.automation-badge.disabled {
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
					border-style: dashed;
				}

				.readiness-pill {
					display: inline-block;
					padding: 4px 10px;
					border-radius: 999px;
					font-size: 12px;
					font-weight: 600;
					text-transform: uppercase;
					border: 1px solid rgba(128,128,128,0.45);
				}

				.readiness-ready {
					background: rgba(46, 160, 67, 0.2);
					border-color: rgba(46, 160, 67, 0.5);
				}

				.readiness-prepare {
					background: rgba(187, 128, 9, 0.2);
					border-color: rgba(187, 128, 9, 0.5);
				}

				.readiness-review {
					background: rgba(229, 140, 33, 0.25);
					border-color: rgba(229, 140, 33, 0.55);
				}

				.readiness-manual {
					background: rgba(229, 83, 75, 0.25);
					border-color: rgba(229, 83, 75, 0.55);
				}

				.risk-section {
					margin-top: 24px;
					padding: 16px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-button-background) 5%);
				}

				.risk-section h3 {
					margin-top: 0;
					margin-bottom: 8px;
				}

				.risk-level {
					font-weight: 600;
					margin-bottom: 12px;
				}

				.risk-level.risk-low {
					color: var(--vscode-testing-iconPassed, #2ea043);
				}

				.risk-level.risk-medium {
					color: rgba(187, 128, 9, 0.95);
				}

				.risk-level.risk-high {
					color: rgba(229, 83, 75, 0.95);
				}

				.risk-columns {
					display: grid;
					gap: 16px;
					grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
					margin-top: 12px;
				}

				.risk-metrics,
				.risk-drivers {
					margin: 0;
					padding-left: 18px;
				}

				.risk-metrics li,
				.risk-drivers li {
					margin-bottom: 6px;
				}

				.risk-meta {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					margin: 4px 0;
				}

				.assessment-history {
					margin-top: 24px;
				}

				.assessment-history h4 {
					margin: 0 0 12px;
					font-size: 14px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.history-timeline {
					position: relative;
					padding-left: 28px;
					margin-top: 12px;
					margin-bottom: 0;
					list-style: none;
				}

				.history-timeline::before {
					content: '';
					position: absolute;
					left: 8px;
					top: 0;
					bottom: 0;
					width: 2px;
					background: var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				}

				.history-item {
					position: relative;
					margin-bottom: 20px;
					padding: 12px;
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: var(--vscode-editor-background);
				}

				.history-item::before {
					content: '';
					position: absolute;
					left: -24px;
					top: 16px;
					width: 10px;
					height: 10px;
					border-radius: 50%;
					background: var(--vscode-button-background);
					border: 2px solid var(--vscode-editor-background);
				}

				.history-item.latest::before {
					background: var(--vscode-testing-iconPassed, #2ea043);
				}

				.history-header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 8px;
				}

				.history-timestamp {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.history-scores {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
					gap: 8px;
					margin-top: 8px;
				}

				.history-score {
					text-align: center;
					padding: 6px;
					border-radius: 4px;
					background: color-mix(in srgb, var(--vscode-editor-background) 93%, var(--vscode-button-background) 7%);
				}

				.history-score-label {
					font-size: 10px;
					text-transform: uppercase;
					letter-spacing: 0.05em;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.history-score-value {
					font-size: 16px;
					font-weight: 600;
					margin-top: 2px;
				}

				.history-trend {
					font-size: 11px;
					margin-left: 4px;
				}

				.history-trend.up {
					color: var(--vscode-testing-iconPassed, #2ea043);
				}

				.history-trend.down {
					color: rgba(229, 83, 75, 0.95);
				}

				.history-empty {
					padding: 16px;
					text-align: center;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
				}

					margin: 0 0 16px 0;
					font-size: 13px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.ml-actions {
					display: flex;
					gap: 12px;
					margin-bottom: 16px;
				}

				.ml-actions button {
					padding: 8px 16px;
					border-radius: 4px;
					border: 1px solid var(--vscode-button-border);
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					cursor: pointer;
					font-size: 13px;
				}

				.ml-actions button:hover {
					background: var(--vscode-button-hoverBackground);
				}

				.ml-actions button.primary {
					font-weight: 600;
				}

				.ml-actions button:disabled {
					opacity: 0.5;
					cursor: not-allowed;
				}

				.stats-grid {
					display: grid;
					grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
					gap: 16px;
					margin-top: 16px;
				}

				.stat-card {
					padding: 16px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
					border-radius: 6px;
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					text-align: center;
				}

				.stat-value {
					font-size: 24px;
					font-weight: 700;
					margin-bottom: 4px;
				}

				.stat-label {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.progress-section {
					margin-top: 16px;
				}

				.progress-bar {
					width: 100%;
					height: 8px;
					background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-button-background) 15%);
					border-radius: 4px;
					overflow: hidden;
					margin-bottom: 8px;
				}

				.progress-fill {
					height: 100%;
					background: var(--vscode-button-background);
					transition: width 0.3s ease;
					width: 0%;
				}

				.progress-status {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.results-section {
					margin-top: 16px;
					font-size: 13px;
				}

				.success-message {
					padding: 12px;
					border-radius: 6px;
					border: 1px solid var(--vscode-testing-iconPassed, #2ea043);
					background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-testing-iconPassed) 10%);
					color: var(--vscode-testing-iconPassed, #2ea043);
				}

				.error-message {
					padding: 12px;
					border-radius: 6px;
					border: 1px solid rgba(229, 83, 75, 0.55);
					background: color-mix(in srgb, var(--vscode-editor-background) 90%, rgba(229, 83, 75, 0.1));
					color: rgba(229, 83, 75, 0.95);
				}

				.info-section {
					font-size: 13px;
				}

				.ml-training-panel {
					padding: 24px;
					overflow-y: auto;
					grid-column: 1 / -1;
					box-sizing: border-box;
				}

				.ml-training-content {
					max-width: 960px;
					margin: 0 auto;
					display: flex;
					flex-direction: column;
					gap: 24px;
				}

				.ml-training-content > h2 {
					margin: 0;
					font-size: 20px;
					font-weight: 600;
				}

				.ml-description {
					margin: 4px 0 16px 0;
					font-size: 13px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.ml-section {
					padding: 16px;
					border-radius: 8px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-button-background) 6%);
					display: flex;
					flex-direction: column;
					gap: 12px;
				}

			.llm-usage-panel {
				padding: 24px;
				overflow-y: auto;
				grid-column: 1 / -1;
			}				.llm-usage-content {
					display: flex;
					flex-direction: column;
					gap: 16px;
				}

				.llm-usage-content h2 {
					margin: 0 0 8px 0;
					font-size: 20px;
					font-weight: 600;
				}

				.usage-description {
					margin: 0 0 16px 0;
					font-size: 13px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

			.usagetap-widget {
				width: 100%;
				min-height: 420px;
				border-radius: 12px;
				border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
				overflow: hidden;
				background: var(--vscode-editor-background);
			}

			/* Override UsageTap widget styles to match VS Code theme */
			.usagetap-widget iframe {
				display: block;
				width: 100%;
				height: 800px;
				border: 0;
				background: transparent;
			}

			body.new-issue-open {
				overflow: hidden;
			}				.new-issue-overlay {
					position: fixed;
					inset: 0;
					display: none;
					align-items: flex-start;
					justify-content: center;
					padding: 32px 16px;
					background: color-mix(in srgb, var(--vscode-editor-background) 65%, rgba(0, 0, 0, 0.35));
					backdrop-filter: blur(3px);
					z-index: 50;
					overflow-y: auto;
				}

				.new-issue-overlay.visible {
					display: flex;
				}

				.new-issue-overlay[hidden] {
					display: none !important;
				}

				.new-issue-container {
					width: min(920px, 100%);
					background: var(--vscode-editor-background);
					color: inherit;
					border-radius: 8px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					box-shadow: 0 24px 48px rgba(0, 0, 0, 0.35);
					padding: 24px;
					display: flex;
					flex-direction: column;
					gap: 24px;
				}

				.new-issue-header {
					display: flex;
					justify-content: space-between;
					align-items: flex-start;
					gap: 16px;
				}

				.new-issue-header h2 {
					margin: 0;
					font-size: 20px;
				}

				.new-issue-subtitle {
					margin: 4px 0 0 0;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.icon-button {
					border: none;
					background: transparent;
					color: inherit;
					font-size: 22px;
					line-height: 1;
					padding: 4px 8px;
					cursor: pointer;
				}

				.icon-button:hover {
					background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-button-background) 20%);
				}

				.icon-button:focus-visible {
					outline: 1px solid var(--vscode-focusBorder);
					outline-offset: 2px;
				}

				.new-issue-form {
					display: grid;
					gap: 16px;
				}

				.new-issue-form .form-row {
					display: flex;
					flex-direction: column;
					gap: 6px;
				}

				.new-issue-form label {
					font-weight: 600;
					font-size: 13px;
				}

				.new-issue-form input,
				.new-issue-form textarea {
					font: inherit;
					padding: 8px;
					border-radius: 4px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					background: var(--vscode-editor-background);
					color: inherit;
				}

				.new-issue-form textarea {
					min-height: 140px;
					resize: vertical;
				}

				.new-issue-form .input-hint {
					margin: 0;
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
				}

				.new-issue-form .form-actions {
					display: flex;
					flex-wrap: wrap;
					justify-content: flex-end;
					gap: 12px;
				}

				.new-issue-analysis {
					border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					padding-top: 16px;
					display: grid;
					gap: 16px;
				}

				.new-issue-status {
					font-size: 13px;
				}

				.new-issue-status.success {
					color: var(--vscode-testing-iconPassed, #2ea043);
				}

				.new-issue-status.error {
					color: rgba(229, 83, 75, 0.95);
				}

				.new-issue-match-container {
					display: grid;
					gap: 12px;
				}

				.new-issue-match-list {
					margin: 0;
					padding: 0;
					list-style: none;
					display: grid;
					gap: 12px;
				}

				.new-issue-match {
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
					padding: 12px;
					background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-button-background) 6%);
					display: grid;
					gap: 8px;
				}

				.new-issue-match-header {
					display: flex;
					justify-content: space-between;
					align-items: baseline;
					gap: 12px;
				}

				.new-issue-match button {
					border: none;
					background: none;
					color: var(--vscode-textLink-foreground, var(--vscode-button-background));
					cursor: pointer;
					font-size: 14px;
					text-align: left;
					padding: 0;
				}

				.new-issue-match button:hover {
					text-decoration: underline;
				}

				.new-issue-match-meta {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					line-height: 1.4;
				}

				.new-issue-match-confidence {
					font-size: 12px;
					font-weight: 600;
					text-transform: uppercase;
				}

				.new-issue-keywords {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
				}

				.new-issue-chip {
					padding: 4px 8px;
					border-radius: 12px;
					background: color-mix(in srgb, var(--vscode-button-background) 25%, transparent);
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					font-size: 12px;
				}

				@media (max-width: 720px) {
					.new-issue-container {
						padding: 16px;
						gap: 16px;
					}

					.new-issue-form textarea {
						min-height: 120px;
					}
				}

				.matrix-panel {
					display: none;
					flex-direction: column;
					gap: 12px;
					padding: 16px;
					height: 100%;
					box-sizing: border-box;
					overflow-y: auto;
					border-right: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
				}

				.matrix-panel.visible {
					display: flex;
				}

				.matrix-header {
					display: flex;
					flex-direction: column;
					padding: 0;
					gap: 6px;
				}

				.matrix-header h2 {
					margin: 0;
				}

				.matrix-header p {
					margin: 0;
				}

				.matrix-legend {
					display: flex;
					flex-wrap: wrap;
					gap: 8px;
				}

				.matrix-legend-item {
					display: inline-flex;
					align-items: center;
					gap: 6px;
					font-size: 12px;
					padding: 4px 8px;
					border-radius: 999px;
					background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-button-background) 8%);
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
				}

				.matrix-legend-swatch {
					width: 10px;
					height: 10px;
					border-radius: 50%;
				}

				.matrix-legend-swatch.readiness-ready {
					background: rgba(46, 160, 67, 0.9);
				}

				.matrix-legend-swatch.readiness-prepare {
					background: rgba(187, 128, 9, 0.9);
				}

				.matrix-legend-swatch.readiness-review {
					background: rgba(229, 140, 33, 0.9);
				}

				.matrix-legend-swatch.readiness-manual {
					background: rgba(229, 83, 75, 0.9);
				}

				.matrix-main {
					position: relative;
					flex: 1;
					min-height: 360px;
					padding: 0;
					margin: 0;
					background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-button-background) 5%);
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 10px;
					overflow: visible;
					display: flex;
				}

				.matrix-main svg {
					flex: 1;
					width: 100%;
					height: 100%;
					overflow: visible;
				}

				.matrix-tooltip {
					position: absolute;
					pointer-events: none;
					background: color-mix(in srgb, var(--vscode-editor-background) 96%, rgba(0,0,0,0.4));
					border-radius: 6px;
					border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					padding: 8px 10px;
					box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
					font-size: 12px;
					max-width: 240px;
					z-index: 5;
				}

				.matrix-tooltip strong {
					display: block;
					margin-bottom: 4px;
				}

				.matrix-empty {
					text-align: center;
					font-size: 13px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					border: 1px dashed var(--vscode-editorWidget-border, rgba(128,128,128,0.35));
					border-radius: 6px;
					padding: 12px;
					margin: 0;
				}

				.matrix-axis {
					stroke: color-mix(in srgb, var(--vscode-editorForeground, #cccccc) 45%, transparent);
					stroke-width: 0.8;
					vector-effect: non-scaling-stroke;
				}

				.matrix-axis.axis-mid {
					stroke-dasharray: 2 2;
				}

				.matrix-grid rect {
					fill: none;
				}

				.matrix-label {
					fill: color-mix(in srgb, var(--vscode-editorForeground, #cccccc) 20%, transparent);
					font-size: 18px;
					font-weight: 700;
					text-transform: uppercase;
				}

				.matrix-label.do {
					fill: color-mix(in srgb, var(--vscode-testing-iconPassed, #2ea043) 30%, transparent);
				}

				.matrix-label.avoid {
					fill: color-mix(in srgb, rgba(229, 83, 75, 0.85) 35%, transparent);
				}

				.matrix-point {
					fill: rgba(128, 128, 128, 0.75);
					stroke: var(--vscode-editor-background);
					stroke-width: 0.6;
					vector-effect: non-scaling-stroke;
					transition: r 0.15s ease, opacity 0.15s ease;
					cursor: pointer;
				}

				.matrix-point[data-hovered="true"] {
					r: 5;
					opacity: 1;
					stroke-width: 1.2;
				}

				.matrix-point.readiness-ready {
					fill: rgba(46, 160, 67, 0.9);
				}

				.matrix-point.readiness-prepare {
					fill: rgba(187, 128, 9, 0.9);
				}

				.matrix-point.readiness-review {
					fill: rgba(229, 140, 33, 0.9);
				}

				.matrix-point.readiness-manual {
					fill: rgba(229, 83, 75, 0.9);
				}

				.matrix-footnote {
					font-size: 12px;
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					margin-top: 28px;
				}

				@media (max-width: 860px) {
					.matrix-panel {
						padding: 12px;
					}

					.matrix-main {
						min-height: 260px;
						margin: 0;
					}
				}

				.muted {
					color: var(--vscode-descriptionForeground, var(--vscode-foreground));
					font-style: italic;
				}
			</style>`;
	}

	private getBodyContent(nonce: string): string {
		const usageCustomerId = encodeURIComponent(this.services.usageTap.getCustomerId());
		const usageIframeSrc = `https://usagetap.com/embed-api/render?api_key=ek-5p6ZQVeedlbzFRO5xN1YBlLtMihH9svY85fVKZQiOng&organization_id=dbc2357b-7ab0-4a5e-af23-4bd114afc044&customer_id=${usageCustomerId}&type=usage&format=compact&theme=auto&background=transparent&metrics=premiumCalls,standardCalls`;
		const callsIframeSrc = `https://usagetap.com/embed-api/render?api_key=ek-5p6ZQVeedlbzFRO5xN1YBlLtMihH9svY85fVKZQiOng&organization_id=dbc2357b-7ab0-4a5e-af23-4bd114afc044&customer_id=${usageCustomerId}&type=calls&format=detailed&theme=auto&background=transparent&pageSize=20&layout=grid&height=800px`;

		return `<div class="header">
				<div class="header-left">
					<h1>Issue Triage</h1>
					<div class="meta-row">
						<span id="accountLabel"></span>
						<span id="automationBadge" class="automation-badge" role="status" aria-live="polite"></span>
					</div>
				</div>
				<div class="toolbar">
				<button id="openNewIssue" class="primary">New Issue</button>
					<button id="refresh">Refresh</button>
				</div>
			</div>
			<div id="filtersBar" class="filters-bar" aria-live="polite">
				<div class="filter-group repo-group">
					<label class="filter-label" id="repositoryLabel" for="repositorySelect">Repository</label>
					<div class="repo-controls" role="group" aria-labelledby="repositoryLabel">
						<select id="repositorySelect" aria-describedby="repositoryHelp"></select>
						<button id="connect" class="compact-button" aria-label="Connect to GitHub">Connect to GitHub</button>
					</div>
					<p id="repositoryHelp" class="visually-hidden">Select a repository to load issues for IssueTriage.</p>
				</div>
				<div class="filter-group search-group">
					<label class="filter-label" for="searchInput">Search</label>
					<input type="search" id="searchInput" placeholder="Search titles" />
				</div>
				<div class="filter-group">
					<label class="filter-label" for="labelFilter">Label</label>
					<select id="labelFilter"></select>
				</div>
				<div class="filter-group">
					<label class="filter-label" for="assigneeFilter">Assignee</label>
					<select id="assigneeFilter"></select>
				</div>
				<div class="filter-group">
					<label class="filter-label" for="milestoneFilter">Milestone</label>
					<select id="milestoneFilter"></select>
				</div>
				<div class="filter-group readiness-group">
					<label class="filter-label" for="readinessFilter">Readiness</label>
					<select id="readinessFilter"></select>
				</div>
			</div>
			<div class="state-tabs" role="group" aria-label="Issue view selection">
				<button class="state-tab active" id="openTab" aria-pressed="true">Open</button>
				<button class="state-tab" id="closedTab" aria-pressed="false">Closed</button>
				<button class="state-tab" id="unlinkedTab" aria-pressed="false">Unlinked</button>
				<button class="state-tab" id="matrixTab" aria-pressed="false">Matrix</button>
				<button class="state-tab" id="llmUsageTab" aria-pressed="false">LLM Usage</button>
				<button class="state-tab" id="mlTrainingTab" aria-pressed="false">ML Training</button>
			</div>
			<div class="container" id="mainContainer">
				<div id="matrixPanel" class="matrix-panel" aria-label="Readiness matrix" hidden>
					<header class="matrix-header">
						<div>
							<h2>Readiness vs Business Value</h2>
							<p class="muted">Prioritize automation-ready issues with the highest business impact.</p>
						</div>
						<div class="matrix-legend" id="readinessMatrixLegend" aria-hidden="true"></div>
					</header>
					<div class="matrix-main">
						<svg id="readinessMatrixMain" viewBox="0 0 100 100" role="img" aria-labelledby="matrixMainTitle" preserveAspectRatio="xMidYMid meet">
							<title id="matrixMainTitle">Issue readiness versus business value</title>
						</svg>
						<div id="readinessMatrixTooltip" class="matrix-tooltip" hidden></div>
					</div>
					<div id="readinessMatrixEmpty" class="matrix-empty" hidden>Run IssueTriage on open issues to populate this matrix.</div>
					<p class="matrix-footnote">Readiness uses the composite IssueTriage score; business value comes directly from assessments.</p>
				</div>
				<div id="llmUsagePanel" class="llm-usage-panel" aria-label="LLM Usage" hidden>
					<div class="llm-usage-content">
						<header class="llm-usage-header">
							<h2>LLM Usage Tracking</h2>
							<p class="usage-description">Monitor aggregate usage metrics and inspect detailed call activity captured by <a href="https://usagetap.com" target="_blank" rel="noopener noreferrer">UsageTap.com</a> — predictable usage-based billing & insights for every AI feature you ship.</p>
						</header>
						<section class="llm-usage-section" aria-labelledby="llmUsageCallsHeading">
							<!-- UsageTap Call Details Widget (iframe) -->
							<div class="usagetap-widget">
								<iframe src="${callsIframeSrc}"
									width="100%"
									height="800px"
									frameborder="0"
									style="background: transparent; background-color: transparent; border-radius: 12px;">
									allowtransparency="true"
								</iframe>
							</div>
						</section>
					</div>
				</div>
				<div class="issue-list-panel" aria-label="Issue list and overview" id="issuesPanel">
					<div id="issueSummary" class="meta-row" role="status" aria-live="polite"></div>
					<div id="analysisActions" class="analysis-actions" hidden>
						<button id="runAnalysisButton" class="compact-button" type="button">Run Analysis</button>
					</div>
					<h2 class="visually-hidden" id="overviewHeading">Overview metrics</h2>
					<section id="overviewMetrics" class="overview-grid" aria-labelledby="overviewHeading" aria-live="polite"></section>
					<h2 class="visually-hidden" id="issueListHeading">Issues</h2>
					<section id="issueList" class="issue-list" role="listbox" aria-labelledby="issueListHeading"></section>
					<div id="loadingState" class="loading-state" hidden role="status" aria-live="polite">
						<div class="loading-spinner" aria-hidden="true"></div>
						<p>Loading issues...</p>
					</div>
					<div id="emptyState" class="empty-state" hidden role="status" aria-live="polite">
						<p>No issues match your filters.</p>
					</div>
					<section id="backfillPanel" class="backfill-panel" aria-labelledby="backfillHeading" aria-live="polite" hidden>
						<div class="backfill-header">
							<h2 id="backfillHeading">Unlinked work</h2>
							<div class="backfill-actions">
								<button id="refreshBackfill" class="compact-button" type="button">Refresh</button>
							</div>
						</div>
						<div id="backfillBody" class="backfill-body"></div>
					</section>
				</div>
				<div class="detail-panel" aria-label="Assessment detail" id="detailPanel">
					<h2 class="visually-hidden" id="assessmentHeading">Assessment detail</h2>
					<section id="assessmentPanel" class="assessment-panel" aria-labelledby="assessmentHeading" aria-live="polite"></section>
				</div>
			</div>
			<div class="ml-training-panel" aria-label="ML Training" id="mlTrainingPanel" hidden>
				<div class="ml-training-content">
					<h2>Machine Learning Training</h2>
					<p class="ml-description">Build and maintain keyword-based similarity search for historical risk learning.</p>
					
					<div class="ml-section">
						<h3>Keyword Coverage</h3>
						<div id="keywordStats" class="stats-grid">
							<div class="stat-card">
								<div class="stat-value" id="totalIssuesCount">-</div>
								<div class="stat-label">Total Closed Issues</div>
							</div>
							<div class="stat-card">
								<div class="stat-value" id="keywordCoverageCount">-</div>
								<div class="stat-label">With Keywords</div>
							</div>
							<div class="stat-card">
								<div class="stat-value" id="keywordCoveragePct">-%</div>
								<div class="stat-label">Coverage</div>
							</div>
						</div>
					</div>
					<div class="ml-section">
						<h3>Backfill Keywords</h3>
						<p>Regenerate AI keywords for closed issues. Choose whether to refresh everything or only fill in gaps. This uses LLM API calls and tracks token usage.</p>
						<div class="ml-actions">
							<button id="backfillMissingButton" class="primary">Backfill Missing</button>
							<button id="backfillAllButton" class="compact-button">Backfill All</button>
							<button id="cancelBackfillButton" disabled>Cancel</button>
						</div>
						<p class="muted">Backfill Missing only processes closed issues without keywords. Backfill All regenerates keywords for every closed issue.</p>
						<div id="backfillProgress" class="progress-section" hidden>
							<div class="progress-bar">
								<div id="backfillProgressBar" class="progress-fill"></div>
							</div>
							<div id="backfillStatus" class="progress-status"></div>
						</div>
						<div id="backfillResults" class="results-section"></div>
					</div>
					<div class="ml-section">
						<h3>Export Training Dataset</h3>
						<p>Validate keyword coverage and export the dataset for external model training.</p>
						<div class="ml-actions">
							<button id="exportDatasetButton" class="primary">Export Dataset</button>
							<button id="downloadDatasetButton" class="compact-button">Download JSON</button>
						</div>
						<div id="exportResults" class="results-section"></div>
						<div id="downloadResults" class="results-section"></div>
					</div>
					<div class="ml-section">
						<h3>Last Export</h3>
						<div id="lastExport" class="info-section">
							<p class="muted">No exports yet</p>
						</div>
					</div>
				</div>
			</div>
			<div id="newIssueOverlay" class="new-issue-overlay" hidden>
				<div class="new-issue-container" role="dialog" aria-modal="true" aria-labelledby="newIssueHeading">
					<header class="new-issue-header">
						<div>
							<h2 id="newIssueHeading">Create New Issue</h2>
							<p id="newIssueSubheading" class="new-issue-subtitle">Draft a summary, run similarity, and create a GitHub issue without leaving VS Code.</p>
						</div>
						<button id="closeNewIssueButton" class="icon-button" type="button" aria-label="Close new issue panel">×</button>
					</header>
					<form id="newIssueForm" class="new-issue-form">
						<div class="form-row">
							<label for="newIssueTitle">Title</label>
							<input id="newIssueTitle" name="title" type="text" required maxlength="240" placeholder="Summarize the change or problem" />
						</div>
						<div class="form-row">
							<label for="newIssueSummary">Summary</label>
							<textarea id="newIssueSummary" name="summary" rows="6" required placeholder="Provide context, impact, and acceptance goals"></textarea>
							<p class="input-hint">Similarity analysis needs a clear summary. Include impact, components, or symptoms.</p>
						</div>
						<div class="form-row">
							<label for="newIssueLabels">Labels</label>
							<input id="newIssueLabels" name="labels" type="text" placeholder="bug, security" list="labelSuggestions" autocomplete="off" />
							<p class="input-hint">Separate multiple labels with commas. Suggestions come from the repository.</p>
						</div>
						<div class="form-row">
							<label for="newIssueAssignees">Assignees</label>
							<input id="newIssueAssignees" name="assignees" type="text" placeholder="octocat" list="assigneeSuggestions" autocomplete="off" />
							<p class="input-hint">Optional. Separate multiple usernames with commas.</p>
						</div>
						<div class="form-row">
							<label for="newIssuePriority">Priority</label>
							<input id="newIssuePriority" name="priority" type="text" placeholder="P1, High, Medium" maxlength="24" />
						</div>
						<div class="form-actions">
							<button type="button" id="analyzeNewIssueButton" class="primary">Analyze Similar Issues</button>
							<button type="submit" id="createNewIssueButton" class="compact-button">Create Issue</button>
							<button type="button" id="resetNewIssueButton">Reset</button>
						</div>
						<datalist id="labelSuggestions"></datalist>
						<datalist id="assigneeSuggestions"></datalist>
					</form>
					<section id="newIssueAnalysisSection" class="new-issue-analysis" aria-live="polite">
						<div id="newIssueStatus" class="new-issue-status muted"></div>
						<div id="newIssueAnalysisResults" hidden>
							<h3>Similarity Insights</h3>
							<p id="newIssueTokenUsage" class="muted"></p>
							<div id="newIssueMatchContainer" class="new-issue-match-container">
								<ul id="newIssueMatchList" class="new-issue-match-list" role="list"></ul>
							</div>
							<div id="newIssueKeywordSummary" class="new-issue-keywords"></div>
						</div>
						<div id="newIssueCreateResult" class="new-issue-success" hidden></div>
					</section>
				</div>
			</div>`;
	}

	private postState(state: unknown): void {
		this.panel.webview.postMessage({ type: 'stateUpdate', state });
		void this.postLastExportRecord(this.readRepositoryFromState(state));
	}

	private readRepositoryFromState(state: unknown): string | undefined {
		if (!state || typeof state !== 'object') {
			return undefined;
		}
		const candidate = state as { selectedRepository?: { fullName?: string } };
		const fullName = candidate.selectedRepository?.fullName;
		return typeof fullName === 'string' && fullName.length > 0 ? fullName : undefined;
	}

	private async postLastExportRecord(repositoryHint?: string, force = false): Promise<void> {
		try {
			const repository = repositoryHint ?? this.services.issueManager.getSnapshot().selectedRepository?.fullName;
			const record = repository ? this.getLastExportRecord(repository) : undefined;
			const signature = JSON.stringify({ repository: repository ?? null, record: record ?? null });
			if (!force && signature === this.lastExportSignature) {
				return;
			}
			this.lastExportSignature = signature;
			await this.panel.webview.postMessage({ type: 'ml.lastExport', record });
		} catch (error) {
			console.warn('[IssueTriage] Failed to post last export record', error);
		}
	}

	private getLastExportRecord(repository: string): StoredExportRecord | undefined {
		const records = this.services.state.getWorkspace<Record<string, StoredExportRecord>>(LAST_EXPORT_STATE_KEY, {});
		return records?.[repository];
	}

	private async handleMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
		switch (message.type) {
			case 'webview.ready':
				this.postState(this.services.issueManager.getSnapshot());
				break;
			case 'webview.connect':
				await this.services.issueManager.connectRepository();
				break;
			case 'webview.refresh':
				await this.services.issueManager.refreshIssues(true);
				break;
			case 'webview.selectRepository':
				if (typeof message.repository === 'string' && message.repository) {
					await this.services.issueManager.selectRepository(message.repository);
					await this.postLastExportRecord(message.repository, true);
				}
				break;
			case 'webview.selectIssue': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				if (issueNumber === undefined) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					break;
				}
				this.services.telemetry.trackEvent('dashboard.issueSelected', {
					repository,
					issue: String(issueNumber)
				});
				await this.sendLatestAssessment(repository, issueNumber);
				break;
			}
			case 'webview.getAssessmentHistory': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				if (issueNumber === undefined) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					break;
				}
				await this.sendAssessmentHistory(repository, issueNumber);
				break;
			}
			case 'webview.exportAssessment': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				const formatValue = typeof message.format === 'string' ? message.format : undefined;
				const format = formatValue === 'markdown' || formatValue === 'json' ? formatValue : undefined;
				if (issueNumber === undefined || !format) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					break;
				}
				await this.exportAssessment(repository, issueNumber, format);
				break;
			}
			case 'webview.linkPullRequest': {
				const pullNumber = this.parseIssueNumber(message.pullNumber);
				if (pullNumber === undefined) {
					break;
				}
				await this.services.issueManager.linkPullRequestToIssue(pullNumber);
				break;
			}
			case 'webview.createIssueFromPullRequest': {
				const pullNumber = this.parseIssueNumber(message.pullNumber);
				if (pullNumber === undefined) {
					break;
				}
					const state = typeof message.state === 'string' ? message.state : 'open';
					await this.services.issueManager.createIssueFromPullRequest(pullNumber, { close: state === 'closed' });
				break;
			}
			case 'webview.linkCommit': {
				const sha = typeof message.sha === 'string' ? message.sha : undefined;
				if (!sha) {
					break;
				}
				await this.services.issueManager.linkCommitToIssue(sha);
				break;
			}
			case 'webview.createIssueFromCommit': {
				const sha = typeof message.sha === 'string' ? message.sha : undefined;
				if (!sha) {
					break;
				}
					const state = typeof message.state === 'string' ? message.state : 'open';
					await this.services.issueManager.createIssueFromCommit(sha, { close: state === 'closed' });
				break;
			}
			case 'webview.refreshUnlinked':
				await this.services.issueManager.refreshUnlinkedData(true);
				break;
			case 'webview.bulkCreateIssues': {
				const itemType = typeof message.itemType === 'string' ? message.itemType : undefined;
				if (itemType !== 'pull' && itemType !== 'commit') {
					break;
				}
				// Get the filtered items from the message
				const items = Array.isArray(message.items) ? message.items : undefined;
				await this.handleBulkCreateIssues(itemType, items);
				break;
			}
			case 'webview.filtersChanged': {
				const filters = this.ensureFilterPayload(message.filters);
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName ?? 'unselected';
				this.services.telemetry.trackEvent('dashboard.filtersChanged', {
					repository,
					state: filters.state ?? 'open',
					readiness: filters.readiness ?? 'all',
					label: filters.label ?? 'none',
					assignee: filters.assignee ?? 'none',
					milestone: filters.milestone ?? 'none',
					search: filters.search ? 'entered' : 'empty'
				}, {
					searchLength: filters.search ? filters.search.length : 0,
					visibleIssues: snapshot.issues.length
				});
				await this.services.issueManager.updateFilters(filters);
				break;
			}
			case 'webview.newIssue.opened': {
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName ?? 'unselected';
				this.services.telemetry.trackEvent('issueCreator.opened', {
					repository
				});
				break;
			}
			case 'webview.newIssue.analyze': {
				const requestId = this.parseRequestId(message.requestId);
				if (requestId === undefined) {
					break;
				}
				const draft = this.parseNewIssueDraft(message.draft);
				try {
					const analysis = await this.services.issueManager.analyzeNewIssueDraft(draft);
					await this.panel.webview.postMessage({
						type: 'newIssue.analysis',
						requestId,
						analysis
					});
				} catch (error) {
					const description = error instanceof Error ? error.message : String(error);
					await this.panel.webview.postMessage({
						type: 'newIssue.analysisError',
						requestId,
						error: description
					});
				}
				break;
			}
			case 'webview.newIssue.create': {
				const requestId = this.parseRequestId(message.requestId);
				if (requestId === undefined) {
					break;
				}
				const draft = this.parseNewIssueDraft(message.draft);
				const analysis = this.parseNewIssueAnalysis(message.analysis);
				try {
					const result = await this.services.issueManager.createIssueFromDraft(draft, analysis);
					await this.panel.webview.postMessage({
						type: 'newIssue.created',
						requestId,
						issueNumber: result.issueNumber,
						url: result.url,
						title: result.title
					});
					void vscode.window.showInformationMessage(`Created GitHub issue #${result.issueNumber}.`);
				} catch (error) {
					const description = error instanceof Error ? error.message : String(error);
					await this.panel.webview.postMessage({
						type: 'newIssue.createError',
						requestId,
						error: description
					});
					void vscode.window.showErrorMessage(`Unable to create issue: ${description}`);
				}
				break;
			}
			case 'webview.signOut':
				await this.services.issueManager.signOut();
				break;
			case 'webview.openIssue':
				if (typeof message.url === 'string') {
					await vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				break;
			case 'webview.openUrl':
				if (typeof message.url === 'string') {
					await vscode.env.openExternal(vscode.Uri.parse(message.url));
				}
				break;
			case 'webview.analyzeRiskSignals': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				if (issueNumber === undefined) {
					break;
				}
				const result = this.services.issueManager.analyzeRiskSignals(issueNumber, { force: true });
				if (!result.success) {
					if (result.message) {
						void vscode.window.showWarningMessage(result.message);
					}
					break;
				}
				void vscode.window.showInformationMessage(`Collecting risk signals for issue #${issueNumber}.`);
				break;
			}
			case 'webview.answerAssessmentQuestion': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				const rawQuestion = this.normalizeString(message.question)?.trim();
				const rawAnswer = this.normalizeString(message.answer)?.trim();
				if (issueNumber === undefined || !rawQuestion || !rawAnswer) {
					this.panel.webview.postMessage({
						type: 'assessment.questionAnswerError',
						issueNumber,
						question: rawQuestion ?? '',
						error: 'Question and answer are required.'
					});
					break;
				}
				try {
					const result = await this.services.issueManager.answerAssessmentQuestion(issueNumber, rawQuestion, rawAnswer);
					this.panel.webview.postMessage({
						type: 'assessment.questionAnswered',
						issueNumber,
						question: result.question,
						answer: result.response.answer,
						commentUrl: result.commentUrl,
						answeredAt: result.response.answeredAt
					});
					vscode.window.showInformationMessage(`Posted answer for #${issueNumber}.`);
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					this.panel.webview.postMessage({
						type: 'assessment.questionAnswerError',
						issueNumber,
						question: rawQuestion,
						error: errorMessage
					});
					vscode.window.showErrorMessage(`Unable to post answer: ${errorMessage}`);
				}
				break;
			}
			case 'webview.runAssessment': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				if (issueNumber === undefined) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					void vscode.window.showWarningMessage('Select a repository before running an assessment.');
					break;
				}
				const issue = snapshot.issues.find(candidate => candidate.number === issueNumber)
					?? this.services.issueManager.getAllIssues().find(candidate => candidate.number === issueNumber);
				const viewingClosedIssues = issue?.state === 'closed' || snapshot.filters.state === 'closed';
				if (viewingClosedIssues) {
					const result = this.services.issueManager.analyzeRiskSignals(issueNumber, { force: true });
					this.services.telemetry.trackEvent('assessment.quickRun.redirectedToRisk', {
						repository,
						issue: String(issueNumber)
					});
					if (!result.success) {
						if (result.message) {
							void vscode.window.showWarningMessage(result.message);
						}
						break;
					}
					void vscode.window.showInformationMessage(`Collecting risk signals for issue #${issueNumber}.`);
					break;
				}
				this.panel.webview.postMessage({ type: 'assessment.loading', issueNumber });
				this.services.telemetry.trackEvent('assessment.quickRun.requested', {
					repository,
					issue: String(issueNumber)
				});
				try {
					const record = await vscode.window.withProgress({
						title: `Assessing issue #${issueNumber}`,
						location: vscode.ProgressLocation.Notification
					}, async () => this.services.assessment.assessIssue(repository, issueNumber));
					IssueTriagePanel.broadcastAssessment(record);
					vscode.window.showInformationMessage(`IssueTriage assessment complete for #${issueNumber}.`);
				} catch (error) {
					const messageText = formatAssessmentError(error);
					this.panel.webview.postMessage({
						type: 'assessment.error',
						issueNumber,
						message: messageText
					});
					vscode.window.showErrorMessage(`Assessment failed: ${messageText}`);
				}
				break;
			}
			case 'webview.runBulkAssessment': {
				const rawValues = Array.isArray(message.issueNumbers) ? message.issueNumbers : [];
				const issueNumbers = rawValues
					.map(value => this.parseIssueNumber(value))
					.filter((value): value is number => typeof value === 'number' && value > 0);
				const uniqueIssueNumbers = Array.from(new Set(issueNumbers)).slice(0, 5);
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					void vscode.window.showWarningMessage('Select a repository before running an assessment.');
					this.panel.webview.postMessage({ type: 'assessment.bulkComplete' });
					break;
				}
				if (!uniqueIssueNumbers.length) {
					void vscode.window.showInformationMessage('No unanalyzed open issues are ready for analysis.');
					this.panel.webview.postMessage({ type: 'assessment.bulkComplete' });
					break;
				}
				this.services.telemetry.trackEvent('assessment.bulkRun.requested', {
					repository,
					total: String(uniqueIssueNumbers.length)
				});
				const successes: number[] = [];
				const failures: Array<{ issue: number; message: string }> = [];
				try {
					await vscode.window.withProgress({
						title: `Running IssueTriage analysis (${uniqueIssueNumbers.length})`,
						location: vscode.ProgressLocation.Notification
					}, async progress => {
						let completed = 0;
						for (const issueNumber of uniqueIssueNumbers) {
							completed += 1;
							progress.report({ message: `Assessing #${issueNumber} (${completed}/${uniqueIssueNumbers.length})` });
							this.panel.webview.postMessage({ type: 'assessment.loading', issueNumber });
							try {
								const record = await this.services.assessment.assessIssue(repository, issueNumber);
								IssueTriagePanel.broadcastAssessment(record);
								successes.push(issueNumber);
							} catch (error) {
								const messageText = formatAssessmentError(error);
								failures.push({ issue: issueNumber, message: messageText });
								this.panel.webview.postMessage({
									type: 'assessment.error',
									issueNumber,
									message: messageText
								});
							}
						}
					});
					const successCount = successes.length;
					const failureCount = failures.length;
					if (successCount > 0) {
						const successMessage = successCount === 1
							? `Completed assessment for issue #${successes[0]}.`
							: `Completed assessments for ${successCount} issues.`;
						void vscode.window.showInformationMessage(successMessage);
					}
					if (failureCount > 0) {
						const detail = failures
							.slice(0, 3)
							.map(item => `#${item.issue}: ${item.message}`)
							.join('; ');
						const suffix = failureCount > 3 ? `; +${failureCount - 3} more` : '';
						void vscode.window.showErrorMessage(`Assessments failed for ${failureCount} issue${failureCount === 1 ? '' : 's'}: ${detail}${suffix}`);
					}
					this.services.telemetry.trackEvent('assessment.bulkRun.completed', {
						repository,
						successCount: String(successes.length),
						failureCount: String(failures.length)
					});
				} finally {
					await this.services.issueManager.refreshAssessments();
					this.panel.webview.postMessage({
						type: 'assessment.bulkComplete',
						summary: {
							successCount: successes.length,
							failureCount: failures.length
						}
					});
				}
				break;
			}
			case 'webview.copyIssueForAI': {
				const issueNumber = this.parseIssueNumber(message.issueNumber);
				if (issueNumber === undefined) {
					break;
				}
				const snapshot = this.services.issueManager.getSnapshot();
				const repository = snapshot.selectedRepository?.fullName;
				if (!repository) {
					break;
				}

				// Check if issue repository matches workspace
				const isWorkspaceRepo = await this.services.aiIntegration.isWorkspaceRepository(repository);
				if (isWorkspaceRepo === false) {
					const proceed = await vscode.window.showWarningMessage(
						`The issue is from '${repository}', but your workspace is for a different repository. The AI assistant may not have the correct code context.`,
						'Copy Anyway',
						'Cancel'
					);
					if (proceed !== 'Copy Anyway') {
						break;
					}
				}

				try {
					const issueDetails = await this.services.github.getIssueDetails(repository, issueNumber);
					const assessment = await this.services.assessment.getLatestAssessment(repository, issueNumber);
					const context = this.services.aiIntegration.formatIssueContext(
						issueDetails,
						assessment ? {
							compositeScore: assessment.compositeScore,
							recommendations: assessment.recommendations,
							summary: assessment.summary
						} : undefined
					);
					await vscode.env.clipboard.writeText(context);
					void vscode.window.showInformationMessage('Issue context copied to clipboard!');
					this.services.telemetry.trackEvent('ai.copyIssue', {
						repository,
						issue: String(issueNumber),
						hasAssessment: String(!!assessment),
						workspaceMatch: String(isWorkspaceRepo ?? 'unknown')
					});
				} catch (error) {
					void vscode.window.showErrorMessage(`Failed to copy issue: ${error instanceof Error ? error.message : 'Unknown error'}`);
				}
				break;
			}
			case 'webview.getKeywordStats': {
				const stats = await this.getKeywordStats();
				await this.panel?.webview.postMessage({ type: 'ml.keywordStats', stats });
				break;
			}
			case 'webview.getLastExport': {
				await this.postLastExportRecord(undefined, true);
				break;
			}
			case 'webview.backfillKeywords': {
				const mode = message.mode === 'all' ? 'all' : 'missing';
				await this.handleBackfillKeywords(mode);
				break;
			}
			case 'webview.cancelBackfill': {
				// Cancel is handled in the backfillKeywords command itself
				break;
			}
			case 'webview.exportDataset': {
				await this.handleExportDataset();
				break;
			}
			case 'webview.downloadDataset': {
				await this.handleDownloadDataset();
				break;
			}
			case 'webview.openFolder': {
				if (typeof message.path === 'string') {
					const folderPath = path.dirname(message.path);
					await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folderPath));
				}
				break;
			}
			case 'webview.openFile': {
				if (typeof message.path === 'string') {
					const doc = await vscode.workspace.openTextDocument(message.path);
					await vscode.window.showTextDocument(doc);
				}
				break;
			}
			default:
				break;
		}
	}

	private async getKeywordStats(): Promise<{ totalIssues: number; withKeywords: number; coverage: number }> {
		try {
			const snapshot = this.services.issueManager.getSnapshot();
			const repository = snapshot.selectedRepository?.fullName;
			if (!repository) {
				return { totalIssues: 0, withKeywords: 0, coverage: 0 };
			}

			// Get keyword coverage from risk storage
			const stats = await this.services.risk.getKeywordCoverage(repository);

			console.log(`[IssueTriage] Keyword stats: ${stats.withKeywords}/${stats.total} (${stats.coverage.toFixed(1)}%)`);

			return {
				totalIssues: stats.total,
				withKeywords: stats.withKeywords,
				coverage: stats.coverage
			};
		} catch (error) {
			console.error('[IssueTriage] Error getting keyword stats:', error);
			return { totalIssues: 0, withKeywords: 0, coverage: 0 };
		}
	}

	private async handleBackfillKeywords(mode: 'missing' | 'all' = 'missing'): Promise<void> {
		try {
			const snapshot = this.services.issueManager.getSnapshot();
			const repository = snapshot.selectedRepository?.fullName;
			if (!repository) {
				await this.panel?.webview.postMessage({
					type: 'ml.backfillComplete',
					success: false,
					error: 'No repository selected'
				});
				return;
			}

			// Trigger the command and let it handle progress
			await vscode.commands.executeCommand('issuetriage.backfillKeywords', mode);
		} catch (error) {
			await this.panel?.webview.postMessage({
				type: 'ml.backfillComplete',
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
		}
	}

	private async handleExportDataset(): Promise<void> {
		try {
			const snapshot = this.services.issueManager.getSnapshot();
			const repository = snapshot.selectedRepository?.fullName;
			if (!repository) {
				await this.panel?.webview.postMessage({
					type: 'ml.exportComplete',
					success: false,
					error: 'No repository selected'
				});
				return;
			}

			const result = await vscode.commands.executeCommand<ExportResult | undefined>('issuetriage.trainModel');
			console.log('[IssueTriage] handleExportDataset command result', result?.success);
			if (result) {
				const validationErrors = result.manifest.validationReport?.errors ?? [];
				await this.panel?.webview.postMessage({
					type: 'ml.exportComplete',
					success: result.success,
					manifest: result.manifest,
					manifestPath: result.manifestPath,
					datasetPath: result.datasetPath,
					error: result.success ? undefined : validationErrors.join('\n') || 'Dataset validation failed validation checks.'
				});
			} else {
				await this.panel?.webview.postMessage({
					type: 'ml.exportComplete',
					success: false,
					error: 'Dataset export cancelled.'
				});
			}
			await this.postLastExportRecord(undefined, true);
		} catch (error) {
			await this.panel?.webview.postMessage({
				type: 'ml.exportComplete',
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
			await this.postLastExportRecord(undefined, true);
		}
	}

	private async handleDownloadDataset(): Promise<void> {
		try {
			const snapshot = this.services.issueManager.getSnapshot();
			const repository = snapshot.selectedRepository?.fullName;
			if (!repository) {
				await this.panel.webview.postMessage({
					type: 'ml.downloadComplete',
					success: false,
					error: 'No repository selected'
				});
				return;
			}

			const sanitizedRepo = repository.replace(/[\\/:*?"<>|]/g, '-');
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const defaultPath = path.join(os.homedir(), `risk-dataset-${sanitizedRepo}-${timestamp}.json`);
			const saveUri = await vscode.window.showSaveDialog({
				title: 'Save Dataset Snapshot',
				defaultUri: vscode.Uri.file(defaultPath),
				saveLabel: 'Save Dataset',
				filters: {
					'JSON Files': ['json'],
					'All Files': ['*']
				}
			});
			if (!saveUri) {
				await this.panel.webview.postMessage({
					type: 'ml.downloadComplete',
					success: false,
					cancelled: true
				});
				return;
			}

			const exportText = await this.services.historicalData.exportDatasetText({ repository });
			await vscode.workspace.fs.writeFile(saveUri, Buffer.from(exportText.content, 'utf8'));
			void vscode.window.showInformationMessage(`Dataset saved to ${saveUri.fsPath}`, 'Open File').then(async action => {
				if (action === 'Open File') {
					try {
						const doc = await vscode.workspace.openTextDocument(saveUri);
						await vscode.window.showTextDocument(doc);
					} catch (error) {
						const description = error instanceof Error ? error.message : String(error);
						void vscode.window.showErrorMessage(`Unable to open dataset: ${description}`);
					}
				}
			});
			this.services.telemetry.trackEvent('dataset.downloaded', {
				repository,
				issues: String(exportText.count),
				coverage: exportText.keywordCoveragePct.toFixed(1)
			});
			await this.panel.webview.postMessage({
				type: 'ml.downloadComplete',
				success: true,
				filePath: saveUri.fsPath,
				count: exportText.count,
				coverage: exportText.keywordCoveragePct
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			void vscode.window.showErrorMessage(`Failed to save dataset: ${message}`);
			await this.panel.webview.postMessage({
				type: 'ml.downloadComplete',
				success: false,
				error: message
			});
		}
	}

	private async handleBulkCreateIssues(itemType: 'pull' | 'commit', filteredItemIds?: unknown[]): Promise<void> {
		try {
			const snapshot = this.services.issueManager.getSnapshot();
			const repository = snapshot.selectedRepository?.fullName;
			if (!repository) {
				void vscode.window.showErrorMessage('No repository selected');
				return;
			}

			const work = snapshot.unlinkedWork;
			const allItems = itemType === 'pull' ? work.pullRequests : work.commits;
			
			if (!allItems || allItems.length === 0) {
				void vscode.window.showInformationMessage(`No unlinked ${itemType === 'pull' ? 'pull requests' : 'commits'} to process.`);
				return;
			}

			// Filter items based on the provided IDs if available
			let items: typeof allItems = allItems;
			if (Array.isArray(filteredItemIds) && filteredItemIds.length > 0) {
				if (itemType === 'pull') {
					const prNumbers = new Set(filteredItemIds.filter((id): id is number => typeof id === 'number'));
					items = allItems.filter(item => prNumbers.has((item as { number: number }).number)) as typeof allItems;
				} else {
					const shas = new Set(filteredItemIds.filter((id): id is string => typeof id === 'string'));
					items = allItems.filter(item => shas.has((item as { sha: string }).sha)) as typeof allItems;
				}
			}

			if (items.length === 0) {
				void vscode.window.showInformationMessage(`No ${itemType === 'pull' ? 'pull requests' : 'commits'} match the current filters.`);
				return;
			}

			const itemLabel = itemType === 'pull' ? 'pull requests' : 'commits';
			const confirmation = await vscode.window.showWarningMessage(
				`Create ${items.length} issues from unlinked ${itemLabel}?`,
				{ modal: true },
				'Create Issues'
			);

			if (confirmation !== 'Create Issues') {
				return;
			}

			void vscode.window.showInformationMessage(`Creating ${items.length} issues from ${itemLabel}...`);

			let successCount = 0;
			let failureCount = 0;
			const errors: string[] = [];

			for (const item of items) {
				try {
					if (itemType === 'pull') {
						const pr = item as { number: number; state?: string };
						// Close the issue if the PR is merged or closed
						await this.services.issueManager.createIssueFromPullRequest(pr.number, { 
							close: pr.state !== 'open',
							silent: true // Suppress individual notifications during batch
						});
					} else {
						const commit = item as { sha: string };
						// Close the issue since commits represent completed work
						await this.services.issueManager.createIssueFromCommit(commit.sha, { 
							close: true,
							silent: true // Suppress individual notifications during batch
						});
					}
					successCount++;
				} catch (error) {
					failureCount++;
					const itemId = itemType === 'pull' 
						? `#${(item as { number: number }).number}` 
						: (item as { sha: string }).sha.slice(0, 7);
					const message = error instanceof Error ? error.message : String(error);
					errors.push(`${itemId}: ${message}`);
				}
			}

			// Refresh unlinked data
			await this.services.issueManager.refreshUnlinkedData(true);

			// Show summary
			if (failureCount === 0) {
				void vscode.window.showInformationMessage(`Successfully created ${successCount} issues from ${itemLabel}.`);
			} else if (successCount === 0) {
				void vscode.window.showErrorMessage(`Failed to create issues. ${failureCount} errors occurred.`);
			} else {
				void vscode.window.showWarningMessage(
					`Created ${successCount} issues, but ${failureCount} failed. Check the output for details.`
				);
			}

			// Log errors if any
			if (errors.length > 0) {
				console.error('[IssueTriage] Bulk create errors:', errors);
			}

			this.services.telemetry.trackEvent('unlinked.bulkCreate', {
				repository,
				itemType,
				total: String(items.length),
				totalUnfiltered: String(allItems.length),
				filtered: String(items.length !== allItems.length),
				success: String(successCount),
				failures: String(failureCount)
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			void vscode.window.showErrorMessage(`Failed to bulk create issues: ${message}`);
		}
	}

	private parseRequestId(value: unknown): number | undefined {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.trunc(value);
		}
		if (typeof value === 'string' && value.trim().length) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return Math.trunc(parsed);
			}
		}
		return undefined;
	}

	private parseNewIssueDraft(raw: unknown): NewIssueDraftInput {
		if (!raw || typeof raw !== 'object') {
			return { title: '', summary: '' };
		}
		const source = raw as Record<string, unknown>;
		const labels = this.coerceStringArray(source.labels);
		const assignees = this.coerceStringArray(source.assignees);
		const draft: NewIssueDraftInput = {
			title: typeof source.title === 'string' ? source.title : '',
			summary: typeof source.summary === 'string' ? source.summary : ''
		};
		if (labels.length) {
			draft.labels = labels;
		}
		if (assignees.length) {
			draft.assignees = assignees;
		}
		if (typeof source.priority === 'string') {
			draft.priority = source.priority;
		}
		return draft;
	}

	private parseNewIssueAnalysis(raw: unknown): NewIssueAnalysisResult | undefined {
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}
		const source = raw as Record<string, unknown>;
		const keywords = this.coerceStringArray(source.keywords);
		const tokensRaw = typeof source.tokensUsed === 'number'
			? source.tokensUsed
			: (typeof source.tokensUsed === 'string' ? Number(source.tokensUsed) : 0);
		const tokensUsed = Number.isFinite(tokensRaw) ? tokensRaw : 0;
		const matchesInput = Array.isArray(source.matches) ? source.matches : [];
		const matches: NewIssueSimilarityMatch[] = [];
		for (const item of matchesInput) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const candidate = item as Record<string, unknown>;
			const issueNumber = this.parseIssueNumber(candidate.issueNumber);
			if (issueNumber === undefined) {
				continue;
			}
			const title = typeof candidate.title === 'string' ? candidate.title : `Issue #${issueNumber}`;
			const url = typeof candidate.url === 'string' ? candidate.url : this.buildIssueUrlFromSnapshot(issueNumber);
			const overlapRaw = typeof candidate.overlapScore === 'number'
				? candidate.overlapScore
				: (typeof candidate.overlapScore === 'string' ? Number(candidate.overlapScore) : 0);
			const overlapScore = Number.isFinite(overlapRaw) ? overlapRaw : 0;
			const sharedKeywords = this.coerceStringArray(candidate.sharedKeywords);
			const matchKeywords = this.coerceStringArray(candidate.keywords);
			const labels = this.coerceStringArray(candidate.labels);
			const summary = typeof candidate.summary === 'string' ? candidate.summary : undefined;
			const calculatedAt = typeof candidate.calculatedAt === 'string' ? candidate.calculatedAt : undefined;
			const riskRaw = typeof candidate.riskLevel === 'string' ? candidate.riskLevel.toLowerCase() : '';
			const riskLevel: 'low' | 'medium' | 'high' = riskRaw === 'high' || riskRaw === 'medium' ? riskRaw : 'low';
			const riskScoreRaw = typeof candidate.riskScore === 'number'
				? candidate.riskScore
				: (typeof candidate.riskScore === 'string' ? Number(candidate.riskScore) : 0);
			const riskScore = Number.isFinite(riskScoreRaw) ? riskScoreRaw : 0;
			const confidenceRaw = typeof candidate.confidenceLevel === 'string'
				? candidate.confidenceLevel.toLowerCase()
				: '';
			let confidenceLevel: 'high' | 'medium' | 'low';
			switch (confidenceRaw) {
				case 'high':
					confidenceLevel = 'high';
					break;
				case 'medium':
					confidenceLevel = 'medium';
					break;
				default:
					confidenceLevel = overlapScore >= 0.6 ? 'high' : overlapScore >= 0.35 ? 'medium' : 'low';
					break;
			}
			const confidenceLabel = typeof candidate.confidenceLabel === 'string' && candidate.confidenceLabel
				? candidate.confidenceLabel
				: (confidenceLevel === 'high' ? 'High confidence' : confidenceLevel === 'medium' ? 'Medium confidence' : 'Low confidence');
			const state = typeof candidate.state === 'string' && candidate.state === 'open' ? 'open' : 'closed';
			matches.push({
				issueNumber,
				title,
				url,
				state,
				riskLevel,
				riskScore,
				overlapScore,
				sharedKeywords,
				keywords: matchKeywords,
				labels,
				summary,
				calculatedAt,
				confidenceLevel,
				confidenceLabel
			});
		}
		return {
			keywords,
			tokensUsed,
			matches
		};
	}

	private coerceStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return [];
		}
		const result: string[] = [];
		for (const entry of value) {
			if (typeof entry !== 'string') {
				continue;
			}
			const trimmed = entry.trim();
			if (trimmed) {
				result.push(trimmed);
			}
		}
		return result;
	}

	private buildIssueUrlFromSnapshot(issueNumber: number): string {
		const repository = this.services.issueManager.getSnapshot().selectedRepository?.fullName;
		return repository ? `https://github.com/${repository}/issues/${issueNumber}` : '';
	}

	private parseIssueNumber(value: unknown): number | undefined {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.trunc(value);
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return Math.trunc(parsed);
			}
		}
		return undefined;
	}

	private async sendLatestAssessment(repository: string, issueNumber: number): Promise<void> {
		this.panel.webview.postMessage({ type: 'assessment.loading', issueNumber });
		try {
			const record = await this.services.assessment.getLatestAssessment(repository, issueNumber);
			if (!record) {
				this.panel.webview.postMessage({ type: 'assessment.result', issueNumber, assessment: null });
				return;
			}
			this.panel.webview.postMessage({
				type: 'assessment.result',
				issueNumber,
				assessment: this.toWebviewAssessment(record)
			});
		} catch (error) {
			this.panel.webview.postMessage({
				type: 'assessment.error',
				issueNumber,
				message: formatAssessmentError(error)
			});
		}
	}

	private async sendAssessmentHistory(repository: string, issueNumber: number): Promise<void> {
		try {
			const records = await this.services.assessment.getAssessmentHistory(repository, issueNumber, 20);
			const history = records.map(record => this.toWebviewAssessment(record));
			this.panel.webview.postMessage({
				type: 'assessment.history',
				issueNumber,
				history
			});
		} catch (error) {
			this.panel.webview.postMessage({
				type: 'assessment.historyError',
				issueNumber,
				message: error instanceof Error ? error.message : 'Unable to load assessment history.'
			});
		}
	}

	private async exportAssessment(repository: string, issueNumber: number, format: 'markdown' | 'json'): Promise<void> {
		const snapshot = this.services.issueManager.getSnapshot();
		const issue = snapshot.issues.find(item => item.number === issueNumber);
		if (!issue) {
			void vscode.window.showWarningMessage(`Issue #${issueNumber} is no longer available to export.`);
			return;
		}

		let record: AssessmentRecord | undefined;
		try {
			record = await this.services.assessment.getLatestAssessment(repository, issueNumber);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unable to load latest assessment from disk.';
			void vscode.window.showErrorMessage(`IssueTriage export failed: ${message}`);
			return;
		}

		if (!record) {
			void vscode.window.showInformationMessage(`No IssueTriage assessment found for #${issueNumber}. Run an assessment before exporting.`);
			return;
		}

		const readiness = snapshot.assessmentSummaries[issueNumber]?.readiness;
		const riskSummary = snapshot.riskSummaries[issueNumber];
		const readinessMeta = this.getReadinessMetadata(readiness);
		const content = format === 'markdown'
			? this.createMarkdownExport(repository, issue, record, readinessMeta, riskSummary)
			: this.createJsonExport(repository, issue, record, readinessMeta, riskSummary);

		const defaultUri = this.buildDefaultExportUri(format, issue);
		const filters: Record<string, string[]> = format === 'markdown'
			? { Markdown: ['md', 'markdown'] }
			: { JSON: ['json'] };
		const saveUri = await vscode.window.showSaveDialog({
			defaultUri,
			saveLabel: format === 'markdown' ? 'Export Markdown' : 'Export JSON',
			filters
		});
		if (!saveUri) {
			return;
		}

		try {
			await fs.writeFile(saveUri.fsPath, content, 'utf8');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unable to write export file.';
			void vscode.window.showErrorMessage(`IssueTriage export failed: ${message}`);
			return;
		}

		this.services.telemetry.trackEvent('assessment.export', {
			repository,
			issue: String(issueNumber),
			format
		});

		const openAction = 'Open File';
		const selection = await vscode.window.showInformationMessage(
			`IssueTriage ${format === 'markdown' ? 'Markdown' : 'JSON'} export saved to ${saveUri.fsPath}.`,
			openAction
		);
		if (selection === openAction) {
			const document = await vscode.workspace.openTextDocument(saveUri);
			await vscode.window.showTextDocument(document, { preview: false });
		}
	}

	private buildDefaultExportUri(format: 'markdown' | 'json', issue: IssueSummary): vscode.Uri | undefined {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return undefined;
		}
		const extension = format === 'markdown' ? '.md' : '.json';
		const fileName = `issue-${issue.number}-assessment${extension}`;
		const filePath = path.join(workspaceFolder.uri.fsPath, fileName);
		return vscode.Uri.file(filePath);
	}

	private getReadinessMetadata(readiness?: string): { key?: string; label: string; description?: string } {
		switch (readiness) {
			case 'ready':
				return { key: 'ready', label: 'Automation Ready', description: 'Safe to hand off to automation.' };
			case 'prepare':
				return { key: 'prepare', label: 'Prep Required', description: 'Add missing context then reassess.' };
			case 'review':
				return { key: 'review', label: 'Needs Review', description: 'Human review recommended before automation.' };
			case 'manual':
				return { key: 'manual', label: 'Manual Only', description: 'Keep this issue manual for now.' };
			default:
				return { label: 'Not Assessed Yet' };
		}
	}

	private createMarkdownExport(
		repository: string,
		issue: IssueSummary,
		record: AssessmentRecord,
		readiness: { key?: string; label: string; description?: string },
		riskSummary: RiskSummary | undefined
	): string {
		const assessedAt = this.formatIsoDate(record.createdAt);
		const commentUrl = this.buildCommentUrl(record);
		const metadataLines = [
			`- Repository: ${repository}`,
			`- Issue: [#${issue.number}](${issue.url})`,
			`- Title: ${issue.title}`,
			`- State: ${issue.state}`,
			`- Labels: ${issue.labels.length ? issue.labels.join(', ') : 'None'}`,
			`- Assignees: ${issue.assignees.length ? issue.assignees.join(', ') : 'None'}`,
			`- Milestone: ${issue.milestone ?? 'None'}`,
			`- Updated: ${this.formatIsoDate(issue.updatedAt)}`
		];

		const tableLines = [
			'| Dimension | Score |',
			'| --- | --- |',
			`| Composite | ${record.compositeScore.toFixed(1)} |`,
			`| Requirements | ${record.requirementsScore.toFixed(1)} |`,
			`| Complexity | ${record.complexityScore.toFixed(1)} |`,
			`| Security | ${record.securityScore.toFixed(1)} |`,
			`| Business Impact | ${record.businessScore.toFixed(1)} |`
		];

		const recommendationLines = record.recommendations.length
			? record.recommendations.map(item => `- ${item}`)
			: ['- No open questions identified.'];

		const riskLines = this.createMarkdownRiskSection(riskSummary);

		const sections: string[] = [
			`# IssueTriage Assessment · ${repository} #${issue.number} – ${issue.title}`,
			`_Generated ${new Date().toISOString()}_`,
			'',
			'## Issue Metadata',
			...metadataLines,
			'',
			'## Readiness',
			`**${readiness.label}** (Composite ${record.compositeScore.toFixed(1)})`
		];
		if (readiness.description) {
			sections.push(readiness.description);
		}
		sections.push('', ...tableLines, '', `Model: ${record.model}`, `Assessment Run: ${assessedAt}`, '', '## Summary', record.summary || 'No summary provided.', '', '## Pre-implementation Questions', ...recommendationLines, '', ...riskLines, '', '## References', `- Issue: ${issue.url}`);

		if (commentUrl) {
			sections.push(`- Latest comment: ${commentUrl}`);
		}

		return sections.join('\n');
	}

	private createMarkdownRiskSection(riskSummary: RiskSummary | undefined): string[] {
		if (!riskSummary) {
			return ['## Risk Insights', 'No risk intelligence captured yet.'];
		}
		switch (riskSummary.status) {
			case 'pending':
				return ['## Risk Insights', 'Risk signals are still being collected for this issue.'];
			case 'error':
				return ['## Risk Insights', `Unable to load risk insights: ${riskSummary.message ?? 'An unexpected error occurred.'}`];
			case 'skipped':
				return ['## Risk Insights', riskSummary.message ?? 'Risk analysis was skipped for this issue.'];
			case 'ready':
				return this.buildReadyRiskLines(riskSummary);
			default:
				return ['## Risk Insights', 'Risk status unknown.'];
		}
	}

	private buildReadyRiskLines(summary: RiskSummary): string[] {
		const level = summary.riskLevel ?? 'low';
		const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
		const scoreText = typeof summary.riskScore === 'number' ? summary.riskScore.toFixed(0) : 'n/a';
		const lines = [
			'## Risk Insights',
			`**${levelLabel} Risk** (Score ${scoreText})`,
		];
		if (summary.stale) {
			lines.push('Signals are refreshing; data may be stale.');
		}
		if (summary.calculatedAt) {
			lines.push(`Calculated: ${this.formatIsoDate(summary.calculatedAt)}`);
		}
		if (summary.metrics) {
			lines.push('', '### Key Metrics');
			lines.push(`- Linked pull requests: ${summary.metrics.prCount}`);
			lines.push(`- Files touched: ${summary.metrics.filesTouched}`);
			lines.push(`- Total lines changed: ${summary.metrics.changeVolume}`);
			const reviewBreakdown: string[] = [];
			const prReviewComments = summary.metrics.prReviewCommentCount ?? 0;
			const prDiscussionComments = summary.metrics.prDiscussionCommentCount ?? 0;
			const prChangeRequests = summary.metrics.prChangeRequestCount ?? 0;
			if (prReviewComments > 0) {
				reviewBreakdown.push(`${prReviewComments} review comment${prReviewComments === 1 ? '' : 's'}`);
			}
			if (prDiscussionComments > 0) {
				reviewBreakdown.push(`${prDiscussionComments} discussion comment${prDiscussionComments === 1 ? '' : 's'}`);
			}
			if (prChangeRequests > 0) {
				reviewBreakdown.push(`${prChangeRequests} change request${prChangeRequests === 1 ? '' : 's'}`);
			}
			const reviewSuffix = reviewBreakdown.length ? ` (${reviewBreakdown.join(', ')})` : '';
			lines.push(`- Review signals: ${summary.metrics.reviewCommentCount}${reviewSuffix}`);
		}
		if (summary.topDrivers && summary.topDrivers.length) {
			lines.push('', '### Risk Drivers');
			summary.topDrivers.forEach(item => {
				lines.push(`- ${item}`);
			});
		}
		return lines;
	}

	private createJsonExport(
		repository: string,
		issue: IssueSummary,
		record: AssessmentRecord,
		readiness: { key?: string; label: string; description?: string },
		riskSummary: RiskSummary | undefined
	): string {
		const payload: Record<string, unknown> = {
			generatedAt: new Date().toISOString(),
			repository,
			issue: {
				number: issue.number,
				title: issue.title,
				url: issue.url,
				state: issue.state,
				labels: issue.labels,
				assignees: issue.assignees,
				milestone: issue.milestone ?? null,
				updatedAt: this.formatIsoDate(issue.updatedAt)
			},
			assessment: {
				compositeScore: record.compositeScore,
				requirementsScore: record.requirementsScore,
				complexityScore: record.complexityScore,
				securityScore: record.securityScore,
				businessScore: record.businessScore,
				recommendations: record.recommendations,
				summary: record.summary,
				model: record.model,
				createdAt: this.formatIsoDate(record.createdAt),
				commentUrl: this.buildCommentUrl(record) ?? null
			}
		};
		if (readiness.key) {
			payload.readiness = {
				key: readiness.key,
				label: readiness.label,
				description: readiness.description ?? null
			};
		}
		if (riskSummary) {
			payload.risk = {
				status: riskSummary.status,
				riskLevel: riskSummary.riskLevel ?? null,
				riskScore: riskSummary.riskScore ?? null,
				calculatedAt: riskSummary.calculatedAt ? this.formatIsoDate(riskSummary.calculatedAt) : null,
				topDrivers: riskSummary.topDrivers ?? [],
				metrics: riskSummary.metrics ?? null,
				stale: Boolean(riskSummary.stale),
				message: riskSummary.message ?? null
			};
		}
		return JSON.stringify(payload, null, 2);
	}

	private formatIsoDate(value: string | undefined): string {
		if (!value) {
			return 'n/a';
		}
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return value;
		}
		return date.toISOString();
	}

	private postAssessment(record: AssessmentRecord): void {
		const snapshot = this.services.issueManager.getSnapshot();
		if (snapshot.selectedRepository?.fullName !== record.repository) {
			return;
		}
		this.panel.webview.postMessage({
			type: 'assessment.result',
			issueNumber: record.issueNumber,
			assessment: this.toWebviewAssessment(record)
		});
		void this.services.issueManager.refreshIssues(false);
	}

	private toWebviewAssessment(record: AssessmentRecord): Record<string, unknown> {
		const readiness = evaluateRecordReadiness(record);
		return {
			repository: record.repository,
			issueNumber: record.issueNumber,
			compositeScore: record.compositeScore,
			requirementsScore: record.requirementsScore,
			complexityScore: record.complexityScore,
			securityScore: record.securityScore,
			businessScore: record.businessScore,
			recommendations: [...record.recommendations],
			summary: record.summary,
			model: record.model,
			createdAt: record.createdAt,
			commentUrl: this.buildCommentUrl(record),
			readiness: readiness.readiness,
			readinessScore: readiness.blendedScore
		};
	}

	private buildCommentUrl(record: AssessmentRecord): string | undefined {
		if (!record.commentId) {
			return undefined;
		}
		return `https://github.com/${record.repository}/issues/${record.issueNumber}#issuecomment-${record.commentId}`;
	}

	private normalizeString(value: unknown): string | undefined {
		if (typeof value !== 'string' || value.trim() === '') {
			return undefined;
		}
		return value;
	}

	private ensureFilterPayload(value: unknown): FilterState {
		if (!value || typeof value !== 'object') {
			return {};
		}
		const payload = value as Record<string, unknown>;
		const stateValue = this.normalizeString(payload.state);
		const normalizedState = stateValue === 'open' || stateValue === 'closed' ? stateValue : undefined;
		const readinessValue = this.normalizeString(payload.readiness);
		const normalizedReadiness = readinessValue === 'all'
			|| readinessValue === 'ready'
			|| readinessValue === 'prepare'
			|| readinessValue === 'review'
			|| readinessValue === 'manual'
			? readinessValue
			: undefined;
		return {
			search: this.normalizeString(payload.search),
			label: this.normalizeString(payload.label),
			assignee: this.normalizeString(payload.assignee),
			milestone: this.normalizeString(payload.milestone),
			state: normalizedState,
			readiness: normalizedReadiness
		};
	}
}

function getNonce(): string {
	const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let result = '';
	for (let i = 0; i < 32; i += 1) {
		result += charset.charAt(Math.floor(Math.random() * charset.length));
	}
	return result;
}

function formatAssessmentError(error: unknown): string {
	if (error instanceof AssessmentError) {
		switch (error.code) {
			case 'missingApiKey':
				return 'OpenRouter API key not configured. Update IssueTriage settings to continue.';
			case 'usageLimitExceeded':
				return 'Usage limit exceeded. Please add your own OpenRouter API key in IssueTriage settings to continue.';
			case 'invalidResponse':
				return 'The assessment response was invalid. Please retry in a moment.';
			case 'storageError':
				return 'Unable to read or write assessments on disk. Check workspace permissions.';
			case 'providerError':
			default:
				return error.message;
		}
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
