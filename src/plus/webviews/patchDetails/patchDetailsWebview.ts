import type {
	CancellationTokenSource,
	ConfigurationChangeEvent,
	Disposable,
	TextDocumentShowOptions,
	ViewColumn,
} from 'vscode';
import { Uri, window } from 'vscode';
import type { CoreConfiguration } from '../../../constants';
import { Commands } from '../../../constants';
import type { Container } from '../../../container';
import type { PatchSelectedEvent } from '../../../eventBus';
import { executeGitCommand } from '../../../git/actions';
import {
	openChanges,
	openChangesWithWorking,
	openFile,
	openFileOnRemote,
	showDetailsQuickPick,
} from '../../../git/actions/commit';
import { CommitFormatter } from '../../../git/formatters/commitFormatter';
import type { GitCommit } from '../../../git/models/commit';
import type { GitFileChange } from '../../../git/models/file';
import { getGitFileStatusIcon } from '../../../git/models/file';
import type { IssueOrPullRequest } from '../../../git/models/issue';
import type { GitCloudPatch, GitPatch, LocalPatch } from '../../../git/models/patch';
import { createReference } from '../../../git/models/reference';
import type { GitRemote } from '../../../git/models/remote';
import { showCommitPicker } from '../../../quickpicks/commitPicker';
import { getRepositoryOrShowPicker } from '../../../quickpicks/repositoryPicker';
import { executeCommand, registerCommand } from '../../../system/command';
import { configuration } from '../../../system/configuration';
import { debug } from '../../../system/decorators/log';
import type { Deferrable } from '../../../system/function';
import { debounce } from '../../../system/function';
import { Logger } from '../../../system/logger';
import { getLogScope } from '../../../system/logger.scope';
import type { PromiseCancelledError } from '../../../system/promise';
import type { Serialized } from '../../../system/serialize';
import { serialize } from '../../../system/serialize';
import type { IpcMessage } from '../../../webviews/protocol';
import { onIpc } from '../../../webviews/protocol';
import type { WebviewController, WebviewProvider } from '../../../webviews/webviewController';
import { updatePendingContext } from '../../../webviews/webviewController';
import type { CloudPatch } from '../../patches/cloudPatchService';
import type { ShowInCommitGraphCommandArgs } from '../graph/protocol';
import type {
	DidExplainParams,
	FileActionParams,
	PatchDetails,
	Preferences,
	State,
	UpdateablePreferences,
} from './protocol';
import {
	DidChangeNotificationType,
	DidExplainCommandType,
	ExplainCommandType,
	FileActionsCommandType,
	messageHeadlineSplitterToken,
	OpenFileCommandType,
	OpenFileComparePreviousCommandType,
	OpenFileCompareWorkingCommandType,
	OpenFileOnRemoteCommandType,
	OpenInCommitGraphCommandType,
	UpdatePreferencesCommandType,
} from './protocol';

interface Context {
	patch: LocalPatch | CloudPatch | undefined;
	preferences: Preferences;

	visible: boolean;
}

export class PatchDetailsWebviewProvider implements WebviewProvider<State, Serialized<State>> {
	private _bootstraping = true;
	/** The context the webview has */
	private _context: Context;
	/** The context the webview should have */
	private _pendingContext: Partial<Context> | undefined;
	private readonly _disposable: Disposable;
	private _focused = false;

	constructor(
		private readonly container: Container,
		private readonly host: WebviewController<State, Serialized<State>>,
	) {
		this._context = {
			patch: undefined,
			preferences: {
				avatars: configuration.get('views.patchDetails.avatars'),
				dateFormat: configuration.get('defaultDateFormat') ?? 'MMMM Do, YYYY h:mma',
				files: configuration.get('views.patchDetails.files'),
				indentGuides:
					configuration.getAny<CoreConfiguration, Preferences['indentGuides']>(
						'workbench.tree.renderIndentGuides',
					) ?? 'onHover',
			},
			visible: false,
		};

		this._disposable = configuration.onDidChangeAny(this.onAnyConfigurationChanged, this);
	}

	dispose() {
		this._disposable.dispose();
	}

	onReloaded(): void {
		void this.notifyDidChangeState(true);
	}

	onShowing(
		_loading: boolean,
		options: { column?: ViewColumn; preserveFocus?: boolean },
		...args: [Partial<PatchSelectedEvent['data']> | { state: Partial<Serialized<State>> }] | unknown[]
	): boolean {
		let data: Partial<PatchSelectedEvent['data']> | undefined;

		const [arg] = args;
		// if (isSerializedState<Serialized<State>>(arg)) {
		// 	const { selected } = arg.state;
		// 	if (selected?.repoPath != null && selected?.sha != null) {
		// 		if (selected.stashNumber != null) {
		// 			data = {
		// 				patch: createReference(selected.sha, selected.repoPath, {
		// 					refType: 'stash',
		// 					name: selected.message,
		// 					number: selected.stashNumber,
		// 				}),
		// 			};
		// 		} else {
		// 			data = {
		// 				commit: createReference(selected.sha, selected.repoPath, {
		// 					refType: 'revision',
		// 					message: selected.message,
		// 				}),
		// 			};
		// 		}
		// 	}
		if (arg != null && typeof arg === 'object') {
			data = arg;
		} else {
			data = undefined;
		}

		let patch;
		if (data != null) {
			if (data.preserveFocus) {
				options.preserveFocus = true;
			}
			({ patch, ...data } = data);
		}

		if (patch != null) {
			this.updatePatch(patch);
		}

		if (data?.preserveVisibility && !this.host.visible) return false;

		return true;
	}

	includeBootstrap(): Promise<Serialized<State>> {
		this._bootstraping = true;

		this._context = { ...this._context, ...this._pendingContext };
		this._pendingContext = undefined;

		return this.getState(this._context);
	}

	registerCommands(): Disposable[] {
		return [registerCommand(`${this.host.id}.refresh`, () => this.host.refresh(true))];
	}

	private onPatchSelected(e: PatchSelectedEvent) {
		if (e.data == null) return;

		// if (this._pinned && e.data.interaction === 'passive') {
		// 	this._commitStack.insert(getReferenceFromRevision(e.data.commit));
		// 	this.updateNavigation();
		// } else {
		void this.host.show(false, { preserveFocus: e.data.preserveFocus }, e.data);
		// }
	}

	onFocusChanged(focused: boolean): void {
		if (this._focused === focused) return;

		this._focused = focused;
		if (focused) {
			this.ensureTrackers();
		}
	}

	onVisibilityChanged(visible: boolean) {
		this.ensureTrackers();
		this.updatePendingContext({ visible: visible });
		if (!visible) return;

		// Since this gets called even the first time the webview is shown, avoid sending an update, because the bootstrap has the data
		if (this._bootstraping) {
			this._bootstraping = false;

			if (this._pendingContext == null) return;
		}

		this.updateState(true);
	}

	private onAnyConfigurationChanged(e: ConfigurationChangeEvent) {
		if (
			configuration.changed(e, ['defaultDateFormat', 'views.patchDetails.files', 'views.patchDetails.avatars']) ||
			configuration.changedAny<CoreConfiguration>(e, 'workbench.tree.renderIndentGuides')
		) {
			this.updatePendingContext({
				preferences: {
					...this._context.preferences,
					...this._pendingContext?.preferences,
					avatars: configuration.get('views.patchDetails.avatars'),
					dateFormat: configuration.get('defaultDateFormat') ?? 'MMMM Do, YYYY h:mma',
					files: configuration.get('views.patchDetails.files'),
					indentGuides:
						configuration.getAny<CoreConfiguration, Preferences['indentGuides']>(
							'workbench.tree.renderIndentGuides',
						) ?? 'onHover',
				},
			});
		}

		this.updateState();
	}

	private _selectionTrackerDisposable: Disposable | undefined;
	private ensureTrackers(): void {
		this._selectionTrackerDisposable?.dispose();
		this._selectionTrackerDisposable = undefined;

		if (!this.host.visible) return;

		this._selectionTrackerDisposable = this.container.events.on('patch:selected', this.onPatchSelected, this);
	}

	onMessageReceived(e: IpcMessage) {
		switch (e.method) {
			case OpenFileOnRemoteCommandType.method:
				onIpc(OpenFileOnRemoteCommandType, e, params => void this.openFileOnRemote(params));
				break;
			case OpenFileCommandType.method:
				onIpc(OpenFileCommandType, e, params => void this.openFile(params));
				break;
			case OpenFileCompareWorkingCommandType.method:
				onIpc(OpenFileCompareWorkingCommandType, e, params => void this.openFileComparisonWithWorking(params));
				break;
			case OpenFileComparePreviousCommandType.method:
				onIpc(
					OpenFileComparePreviousCommandType,
					e,
					params => void this.openFileComparisonWithPrevious(params),
				);
				break;
			case FileActionsCommandType.method:
				onIpc(FileActionsCommandType, e, params => void this.showFileActions(params));
				break;
			case OpenInCommitGraphCommandType.method:
				onIpc(
					OpenInCommitGraphCommandType,
					e,
					params =>
						void executeCommand<ShowInCommitGraphCommandArgs>(Commands.ShowInCommitGraph, {
							ref: createReference(params.ref, params.repoPath, { refType: 'revision' }),
						}),
				);
				break;
			case UpdatePreferencesCommandType.method:
				onIpc(UpdatePreferencesCommandType, e, params => this.updatePreferences(params));
				break;
			case ExplainCommandType.method:
				onIpc(ExplainCommandType, e, () => this.explainPatch(e.completionId));
		}
	}

	private async explainPatch(completionId?: string) {
		if (this._context.patch == null) return;

		let params: DidExplainParams;

		try {
			const commit = await this.getUnreachablePatchCommit();
			if (commit == null) return;

			const summary = await this.container.ai.explainCommit(commit, {
				progress: { location: { viewId: this.host.id } },
			});
			params = { summary: summary };
		} catch (ex) {
			debugger;
			params = { error: { message: ex.message } };
		}

		void this.host.notify(DidExplainCommandType, params, completionId);
	}

	private _cancellationTokenSource: CancellationTokenSource | undefined = undefined;

	@debug({ args: false })
	protected async getState(current: Context): Promise<Serialized<State>> {
		if (this._cancellationTokenSource != null) {
			this._cancellationTokenSource.cancel();
			this._cancellationTokenSource.dispose();
			this._cancellationTokenSource = undefined;
		}

		let details;
		if (current.patch != null) {
			details = await this.getDetailsModel(current.patch);

			// if (!current.richStateLoaded) {
			// 	this._cancellationTokenSource = new CancellationTokenSource();

			// 	const cancellation = this._cancellationTokenSource.token;
			// 	setTimeout(() => {
			// 		if (cancellation.isCancellationRequested) return;
			// 		void this.updateRichState(current, cancellation);
			// 	}, 100);
			// }
		}

		// const commitChoices = await Promise.all(this.commits.map(async commit => summaryModel(commit)));

		const state = serialize<State>({
			webviewId: this.host.id,
			timestamp: Date.now(),
			patch: details,
			preferences: current.preferences,
		});
		return state;
	}

	// @debug({ args: false })
	// private async updateRichState(current: Context, cancellation: CancellationToken): Promise<void> {
	// 	const { commit } = current;
	// 	if (commit == null) return;

	// 	const remote = await this.container.git.getBestRemoteWithRichProvider(commit.repoPath);

	// 	if (cancellation.isCancellationRequested) return;

	// 	let autolinkedIssuesOrPullRequests;
	// 	// let pr: PullRequest | undefined;

	// 	if (remote?.provider != null) {
	// 		// const [autolinkedIssuesOrPullRequestsResult, prResult] = await Promise.allSettled([
	// 		// 	configuration.get('views.patchDetails.autolinks.enabled') &&
	// 		// 	configuration.get('views.patchDetails.autolinks.enhanced')
	// 		// 		? this.container.autolinks.getLinkedIssuesAndPullRequests(commit.message ?? commit.summary, remote)
	// 		// 		: undefined,
	// 		// 	configuration.get('views.patchDetails.pullRequests.enabled')
	// 		// 		? commit.getAssociatedPullRequest({ remote: remote })
	// 		// 		: undefined,
	// 		// ]);
	// 		const autolinkedIssuesOrPullRequestsResult =
	// 			configuration.get('views.patchDetails.autolinks.enabled') &&
	// 			configuration.get('views.patchDetails.autolinks.enhanced')
	// 				? this.container.autolinks.getLinkedIssuesAndPullRequests(commit.message ?? commit.summary, remote)
	// 				: undefined;

	// 		if (cancellation.isCancellationRequested) return;

	// 		// autolinkedIssuesOrPullRequests = getSettledValue(autolinkedIssuesOrPullRequestsResult);
	// 		// pr = getSettledValue(prResult);
	// 		autolinkedIssuesOrPullRequests = autolinkedIssuesOrPullRequestsResult
	// 			? await autolinkedIssuesOrPullRequestsResult
	// 			: undefined;
	// 	}

	// 	const formattedMessage = this.getFormattedMessage(commit, remote, autolinkedIssuesOrPullRequests);

	// 	// Remove possible duplicate pull request
	// 	// if (pr != null) {
	// 	// 	autolinkedIssuesOrPullRequests?.delete(pr.id);
	// 	// }

	// 	this.updatePendingContext({
	// 		formattedMessage: formattedMessage,
	// 		// autolinkedIssues:
	// 		// 	autolinkedIssuesOrPullRequests != null ? [...autolinkedIssuesOrPullRequests.values()] : undefined,
	// 		// pullRequest: pr,
	// 	});

	// 	this.updateState();

	// 	// return {
	// 	// 	formattedMessage: formattedMessage,
	// 	// 	pullRequest: pr,
	// 	// 	autolinkedIssues:
	// 	// 		autolinkedIssuesOrPullRequests != null
	// 	// 			? [...autolinkedIssuesOrPullRequests.values()].filter(<T>(i: T | undefined): i is T => i != null)
	// 	// 			: undefined,
	// 	// };
	// }

	private _commitDisposable: Disposable | undefined;

	private updatePatch(
		patch: LocalPatch | CloudPatch | undefined,
		options?: { force?: boolean; immediate?: boolean },
	) {
		// // this.commits = [commit];
		// if (!options?.force && this._context.commit?.sha === patch?.ref) return;
		// this._commitDisposable?.dispose();
		// let commit: GitCommit | undefined;
		// if (isCommit(patch)) {
		// 	commit = patch;
		// } else if (patch != null) {
		// 	if (patch.refType === 'stash') {
		// 		const stash = await this.container.git.getStash(patch.repoPath);
		// 		commit = stash?.commits.get(patch.ref);
		// 	} else {
		// 		commit = await this.container.git.getCommit(patch.repoPath, patch.ref);
		// 	}
		// }
		// if (commit?.isUncommitted) {
		// 	const repository = this.container.git.getRepository(commit.repoPath)!;
		// 	this._commitDisposable = Disposable.from(
		// 		repository.startWatchingFileSystem(),
		// 		repository.onDidChangeFileSystem(() => {
		// 			// this.updatePendingContext({ commit: undefined });
		// 			this.updatePendingContext({ commit: commit }, true);
		// 			this.updateState();
		// 		}),
		// 	);
		// }

		this.updatePendingContext(
			{
				patch: patch,
				// richStateLoaded: false, //(commit?.isUncommitted) || !getContext('gitlens:hasConnectedRemotes'),
				// formattedMessage: undefined,
				// autolinkedIssues: undefined,
				// pullRequest: undefined,
			},
			options?.force,
		);
		this.ensureTrackers();
		this.updateState(options?.immediate ?? true);
	}

	private updatePreferences(preferences: UpdateablePreferences) {
		if (
			this._context.preferences?.files?.compact === preferences.files?.compact &&
			this._context.preferences?.files?.icon === preferences.files?.icon &&
			this._context.preferences?.files?.layout === preferences.files?.layout &&
			this._context.preferences?.files?.threshold === preferences.files?.threshold
		) {
			return;
		}

		const changes: Preferences = {
			...this._context.preferences,
			...this._pendingContext?.preferences,
		};

		if (preferences.files != null) {
			if (this._context.preferences?.files?.compact !== preferences.files?.compact) {
				void configuration.updateEffective('views.patchDetails.files.compact', preferences.files?.compact);
			}
			if (this._context.preferences?.files?.icon !== preferences.files?.icon) {
				void configuration.updateEffective('views.patchDetails.files.icon', preferences.files?.icon);
			}
			if (this._context.preferences?.files?.layout !== preferences.files?.layout) {
				void configuration.updateEffective('views.patchDetails.files.layout', preferences.files?.layout);
			}
			if (this._context.preferences?.files?.threshold !== preferences.files?.threshold) {
				void configuration.updateEffective('views.patchDetails.files.threshold', preferences.files?.threshold);
			}

			changes.files = preferences.files;
		}

		this.updatePendingContext({ preferences: changes });
	}

	private updatePendingContext(context: Partial<Context>, force: boolean = false): boolean {
		const [changed, pending] = updatePendingContext(this._context, this._pendingContext, context, force);
		if (changed) {
			this._pendingContext = pending;
		}

		return changed;
	}

	private _notifyDidChangeStateDebounced: Deferrable<() => void> | undefined = undefined;

	private updateState(immediate: boolean = false) {
		if (immediate) {
			void this.notifyDidChangeState();
			return;
		}

		if (this._notifyDidChangeStateDebounced == null) {
			this._notifyDidChangeStateDebounced = debounce(this.notifyDidChangeState.bind(this), 500);
		}

		this._notifyDidChangeStateDebounced();
	}

	private async notifyDidChangeState(force: boolean = false) {
		const scope = getLogScope();

		this._notifyDidChangeStateDebounced?.cancel();
		if (!force && this._pendingContext == null) return false;

		let context: Context;
		if (this._pendingContext != null) {
			context = { ...this._context, ...this._pendingContext };
			this._context = context;
			this._pendingContext = undefined;
		} else {
			context = this._context;
		}

		return window.withProgress({ location: { viewId: this.host.id } }, async () => {
			try {
				await this.host.notify(DidChangeNotificationType, {
					state: await this.getState(context),
				});
			} catch (ex) {
				Logger.error(scope, ex);
				debugger;
			}
		});
	}

	// private async updateRichState() {
	// 	if (this.commit == null) return;

	// 	const richState = await this.getRichState(this.commit);
	// 	if (richState != null) {
	// 		void this.notify(DidChangeRichStateNotificationType, richState);
	// 	}
	// }

	// private getBestCommitOrStash(): GitCommit | GitRevisionReference | undefined {
	// 	let commit: GitCommit | GitRevisionReference | undefined = this._pendingContext?.commit;
	// 	if (commit == null) {
	// 		const args = this.container.events.getCachedEventArgs('commit:selected');
	// 		commit = args?.commit;
	// 	}

	// 	return commit;
	// }

	// eslint-disable-next-line @typescript-eslint/require-await
	private async getDetailsModel(patchset: LocalPatch | CloudPatch): Promise<PatchDetails> {
		let patch: GitPatch | GitCloudPatch;
		if (patchset.type === 'local') {
			patch = patchset.patch;
		} else {
			patch = patchset.changesets[0].patches[0];
		}

		if (patch.files == null) {
			setTimeout(async () => {
				const files = await this.container.git.getDiffFiles('', patch.contents);
				patch.files = files?.files;

				this.updatePendingContext({ patch: patchset }, true);
				this.updateState();
			}, 1);
		}

		const files = patch.files?.map(({ status, repoPath, path, originalPath }) => {
			const icon = getGitFileStatusIcon(status);
			return {
				path: path,
				originalPath: originalPath,
				status: status,
				repoPath: repoPath,
				icon: {
					dark: this.host
						.asWebviewUri(Uri.joinPath(this.host.getRootUri(), 'images', 'dark', icon))
						.toString(),
					light: this.host
						.asWebviewUri(Uri.joinPath(this.host.getRootUri(), 'images', 'light', icon))
						.toString(),
				},
			};
		});

		if (patchset.type === 'local' || patch.type === 'file') {
			return {
				type: 'local',
				files: files,
			};
		}

		return {
			type: 'cloud',
			repoPath: patch.repo.path,
			author: {
				name: 'You',
				email: 'no@way.com',
				avatar: undefined,
			},
			files: files,
			createdAt: patchset.createdAt.getTime(),
			updatedAt: patchset.updatedAt.getTime(),
		};
	}

	private getFormattedMessage(
		commit: GitCommit,
		remote: GitRemote | undefined,
		issuesOrPullRequests?: Map<string, IssueOrPullRequest | PromiseCancelledError | undefined>,
	) {
		let message = CommitFormatter.fromTemplate(`\${message}`, commit);
		const index = message.indexOf('\n');
		if (index !== -1) {
			message = `${message.substring(0, index)}${messageHeadlineSplitterToken}${message.substring(index + 1)}`;
		}

		if (!configuration.get('views.patchDetails.autolinks.enabled')) return message;

		return this.container.autolinks.linkify(
			message,
			'html',
			remote != null ? [remote] : undefined,
			issuesOrPullRequests,
		);
	}

	private async getFileCommitFromParams(
		params: FileActionParams,
	): Promise<[commit: GitCommit, file: GitFileChange] | undefined> {
		const commit = await (await this.getUnreachablePatchCommit())?.getCommitForFile(params.path);
		return commit != null ? [commit, commit.file!] : undefined;
	}

	private async getUnreachablePatchCommit(): Promise<GitCommit | undefined> {
		let patch: GitPatch | GitCloudPatch;
		switch (this._context.patch?.type) {
			case 'local':
				patch = this._context.patch.patch;
				break;
			case 'cloud':
				patch = this._context.patch.changesets[0]?.patches[0];
				break;
			default:
				throw new Error('Invalid patch type');
		}

		if (patch.repo == null) {
			const pick = await getRepositoryOrShowPicker(
				'Patch Details: Select Repository',
				'Choose which repository this patch belongs to',
			);
			if (pick == null) return undefined;

			patch.repo = pick;
		}

		if (patch.baseRef == null) {
			const pick = await showCommitPicker(
				this.container.git.getLog(patch.repo.uri),
				'Patch Details: Select Base',
				'Choose the base which this patch was created from or should be applied to',
			);
			if (pick == null) return undefined;

			patch.baseRef = pick.sha;
		}

		if (patch.commit == null) {
			try {
				const commit = await this.container.git.createUnreachableCommitForPatch(
					patch.repo.uri,
					patch.contents,
					patch.baseRef ?? 'HEAD',
					'PATCH',
				);
				patch.commit = commit;
			} catch (ex) {
				void window.showErrorMessage(`Unable preview the patch on base '${patch.baseRef}': ${ex.message}`);
				patch.baseRef = undefined;
			}
		}
		return patch.commit;
	}

	private showAutolinkSettings() {
		void executeCommand(Commands.ShowSettingsPageAndJumpToAutolinks);
	}

	private showCommitSearch() {
		void executeGitCommand({ command: 'search', state: { openPickInView: true } });
	}

	// private showCommitPicker() {
	// 	void executeGitCommand({
	// 		command: 'log',
	// 		state: {
	// 			reference: 'HEAD',
	// 			repo: this._context.commit?.repoPath,
	// 			openPickInView: true,
	// 		},
	// 	});
	// }

	// private showCommitActions() {
	// 	const commit = this.getPatchCommit();
	// 	if (commit == null || commit.isUncommitted) return;

	// 	void showDetailsQuickPick(commit);
	// }

	private async showFileActions(params: FileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		void showDetailsQuickPick(commit, file);
	}

	private async openFileComparisonWithWorking(params: FileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		void openChangesWithWorking(file, commit, {
			preserveFocus: true,
			preview: true,
			...this.getShowOptions(params),
		});
	}

	private async openFileComparisonWithPrevious(params: FileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		void openChanges(file, commit, {
			preserveFocus: true,
			preview: true,
			...this.getShowOptions(params),
		});
		this.container.events.fire('file:selected', { uri: file.uri }, { source: this.host.id });
	}

	private async openFile(params: FileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		void openFile(file, commit, {
			preserveFocus: true,
			preview: true,
			...this.getShowOptions(params),
		});
	}

	private async openFileOnRemote(params: FileActionParams) {
		const result = await this.getFileCommitFromParams(params);
		if (result == null) return;

		const [commit, file] = result;

		void openFileOnRemote(file, commit);
	}

	private getShowOptions(params: FileActionParams): TextDocumentShowOptions | undefined {
		return params.showOptions;

		// return getContext('gitlens:webview:graph:active') || getContext('gitlens:webview:rebase:active')
		// 	? { ...params.showOptions, viewColumn: ViewColumn.Beside } : params.showOptions;
	}
}

// async function summaryModel(commit: GitCommit): Promise<CommitSummary> {
// 	return {
// 		sha: commit.sha,
// 		shortSha: commit.shortSha,
// 		summary: commit.summary,
// 		message: commit.message,
// 		author: commit.author,
// 		avatar: (await commit.getAvatarUri())?.toString(true),
// 	};
// }
