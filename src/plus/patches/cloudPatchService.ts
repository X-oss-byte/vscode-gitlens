import fetch from 'node-fetch';
import type { Disposable } from 'vscode';
import { Uri } from 'vscode';
import type { Container } from '../../container';
import type { GitCloudPatch } from '../../git/models/patch';
import type { Repository } from '../../git/models/repository';
import { getSettledValue } from '../../system/promise';
import type { ServerConnection } from '../gk/serverConnection';

export const nonexistingChangesetId = '00000000-0000-0000-0000-000000000000';

export interface CloudPatch extends CloudPatchBase {
	readonly user?: {
		readonly id: string;
		readonly name: string;
		readonly email: string;
	};

	readonly changesets: CloudPatchChangeset[];
}

export interface CloudPatchChangeset {
	readonly id: string;
	// readonly linkUrl: string; TODO add this once the backend actually supports it
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly draftId: string;
	readonly gitProfileId: string;
	readonly parentChangesetId: string;
	readonly patches: GitCloudPatch[];
	readonly userId?: string;
}

export interface CloudPatchBase {
	readonly type: 'cloud';

	readonly id: string;
	readonly linkUrl: string;
	readonly title?: string;
	readonly description?: string;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly createdBy: string; // userId of creator
	readonly isPublic: boolean;
	readonly organizationId?: string;
}

export interface CloudPatchData {
	id: string;
	draftId: string;
	gitProfileId: string;
	gitRepositoryName: string;
	gitBranchName: string;
	contents: string;
}

export interface CloudPatchResponse {
	id: string;
	draftId: string;
	gitProfileId?: string;
	gitRepositoryName?: string;
	gitBranchName?: string;
}

export class CloudPatchService implements Disposable {
	// private _disposable: Disposable;
	// private _subscription: Subscription | undefined;

	constructor(
		private readonly container: Container,
		private readonly connection: ServerConnection,
	) {
		// this._disposable = Disposable.from(container.subscription.onDidChange(this.onSubscriptionChanged, this));
	}

	dispose(): void {
		// this._disposable.dispose();
	}

	// private onSubscriptionChanged(_e: SubscriptionChangeEvent): void {
	// 	this._subscription = undefined;
	// }

	// private async ensureSubscription(force?: boolean) {
	// 	if (force || this._subscription == null) {
	// 		this._subscription = await this.container.subscription.getSubscription();
	// 	}
	// 	return this._subscription;
	// }

	async create(repository: Repository, baseSha: string, contents: string): Promise<CloudPatch | undefined> {
		// const subscription = await this.ensureSubscription();
		// if (subscription.account == null) return undefined;

		const [remoteResult, userResult, branchResult] = await Promise.allSettled([
			this.container.git.getBestRemoteWithProvider(repository.uri),
			this.container.git.getCurrentUser(repository.uri),
			repository.getBranch(),
		]);

		// TODO: what happens if there are multiple remotes -- which one should we use? Do we need to ask? See more notes below
		const remote = getSettledValue(remoteResult);
		if (remote?.provider == null) throw new Error('No Git provider found');

		const user = getSettledValue(userResult);
		const gitProfileId = user?.email ?? user?.name ?? '';

		const branch = getSettledValue(branchResult);
		const branchName = branch?.name ?? '';

		// POST v1/drafts
		const draftResponse = await this.connection.fetch(
			Uri.joinPath(this.connection.baseGkApiUri, 'v1/drafts').toString(),
			{
				method: 'POST',
				// body: JSON.stringify({ userId: subscription.account.id }),
			},
		);

		const draftData = (await draftResponse.json()).data;
		const draftId = draftData.id;
		const newDraft = await this.get(draftId);
		if (newDraft == null) return undefined;

		const repoFirstCommitSha = await this.container.git.getUniqueRepositoryId(repository.path);

		// POST /v1/drafts/:draftId/changesets
		const changesetCreateResponse = await this.connection.fetch(
			Uri.joinPath(this.connection.baseGkApiUri, `v1/drafts/${draftId}/changesets`).toString(),
			{
				method: 'POST',
				body: JSON.stringify({
					gitProfileId: gitProfileId,
					patches: [
						{
							baseCommitSha: baseSha,
							baseBranchName: branchName,
							gitRepoData: {
								...(repoFirstCommitSha != null &&
									repoFirstCommitSha != '-' && { initialCommitSha: repoFirstCommitSha }),
								// TODO - Add other repo provider data once the model documentation is available
							},
						},
					],
				}),
			},
		);

		const changesetCreatedData = (await changesetCreateResponse.json()).data;
		const patch = changesetCreatedData.patches[0];

		const { url, method, headers } = patch.secureUploadData;
		const patchId = patch.id;

		// Upload patch to returned S3 url
		await fetch(url, {
			method: method,
			headers: {
				'Content-Type': 'plain/text',
				Host: headers?.['Host']?.['0'] ?? '',
			},
			body: contents,
		});

		// PATCH /v1/patches/:patchId
		await this.connection.fetch(Uri.joinPath(this.connection.baseGkApiUri, `/v1/patches/${patchId}`).toString(), {
			method: 'PATCH',
			body: JSON.stringify({
				baseCommitSha: baseSha,
				gitProfileId: gitProfileId,
				gitProvider: remote.provider.id,
				// TODO: this is a hack and won't always work, so we probably need to plumb this through the RemoteProviders
				// BUT there is a bigger issue with repo identification here -- as we also need to know the base url of the repo (self-hosted)
				gitRepositoryName: remote.provider.path.split('/')[1],
				gitRepositoryOwner: remote.provider.owner,
				gitBranchName: branchName,
			}),
		});

		return {
			...newDraft,
			changesets: [changesetCreatedData],
		};
	}

	async get(id: string): Promise<CloudPatch | undefined> {
		const draftResponse = await this.connection.fetch(
			Uri.joinPath(this.connection.baseGkApiUri, `v1/drafts/${id}`).toString(),
			{
				method: 'GET',
			},
		);

		const draftData = (await draftResponse.json()).data;
		const changeSets = await this.getChangesets(id); // TODO@eamodio The changesets don't come in on the GET call above, and the GET call for changesets is 404ing.
		return {
			type: 'cloud',
			id: draftData.id,
			linkUrl: draftData.deepLink,
			title: draftData.title,
			description: draftData.description,
			createdAt: new Date(draftData.createdAt),
			updatedAt: new Date(draftData.updatedAt),
			createdBy: draftData.createdBy,
			isPublic: draftData.isPublic,
			organizationId: draftData.organizationId,
			changesets: changeSets ?? [],
		};
	}

	// TODO: This call is 404ing...maybe it's not implemented yet?
	async getChangesets(id: string): Promise<CloudPatchChangeset[] | undefined> {
		const changesetsResponse = await this.connection.fetch(
			Uri.joinPath(this.connection.baseGkApiUri, `/v1/drafts/${id}/changesets`).toString(),
			{
				method: 'GET',
			},
		);

		const changesetsData = (await changesetsResponse.json()).data;
		return changesetsData.map((changesetData: any): CloudPatchChangeset => {
			const { id, createdAt, updatedAt, draftId, gitProfileId, parentChangesetId, patches } = changesetData;
			return {
				id: id,
				createdAt: new Date(createdAt),
				updatedAt: new Date(updatedAt),
				draftId: draftId,
				gitProfileId: gitProfileId,
				parentChangesetId: parentChangesetId,
				patches: patches,
			};
		}) as CloudPatchChangeset[];
	}

	async getPatches(id: string, options?: { includeContents?: boolean }): Promise<CloudPatchData[] | undefined> {
		const patchesResponse = await this.connection.fetch(
			Uri.joinPath(this.connection.baseGkApiUri, `/v1/drafts/${id}/patches`).toString(),
			{
				method: 'GET',
			},
		);

		const patchesData: CloudPatchResponse[] = (await patchesResponse.json()).data;
		const patches = await Promise.allSettled(
			patchesData.map(async (patchData: any): Promise<CloudPatchData> => {
				const { draftId, gitProfileId, gitRepositoryName, gitBranchName } = patchData;
				const { url, method, headers } = patchData.secureDownloadData;
				let contents = '';
				let patchDownloadResponse;
				if (options?.includeContents) {
					// Download patch from returned S3 url
					patchDownloadResponse = await this.connection.fetch(url, {
						method: method,
						headers: {
							Accept: 'text/plain',
							Host: headers?.['Host']?.['0'] ?? '',
						},
					});

					contents = await patchDownloadResponse.text();
				}

				return {
					id: patchData.id,
					draftId: draftId,
					gitProfileId: gitProfileId,
					gitRepositoryName: gitRepositoryName,
					gitBranchName: gitBranchName,
					contents: contents,
				};
			}),
		);

		return patches.map(patch => getSettledValue(patch)) as CloudPatchData[];
	}

	async getPatch(id: string): Promise<CloudPatchData | undefined> {
		const patchResponse = await this.connection.fetch(
			Uri.joinPath(this.connection.baseGkApiUri, `/v1/patches/${id}`).toString(),
			{
				method: 'GET',
			},
		);

		const patchData = (await patchResponse.json()).data;
		const { draftId, gitProfileId, gitRepositoryName, gitBranchName } = patchData;
		const { url, method, headers } = patchData.secureDownloadData;

		// Download patch from returned S3 url
		const patchDownloadResponse = await fetch(url, {
			method: method,
			headers: {
				Accept: 'text/plain',
				Host: headers?.['Host']?.['0'] ?? '',
			},
		});

		const contents = await patchDownloadResponse.text();

		return {
			id: id,
			draftId: draftId,
			gitProfileId: gitProfileId,
			gitRepositoryName: gitRepositoryName,
			gitBranchName: gitBranchName,
			contents: contents,
		};
	}

	async getPatchContents(id: string): Promise<string | undefined> {
		// const subscription = await this.ensureSubscription();
		// if (subscription.account == null) return undefined;

		// GET /v1/patches/:patchId
		const patchResponse = await this.connection.fetch(
			Uri.joinPath(this.connection.baseGkApiUri, `/v1/patches/${id}`).toString(),
			{
				method: 'GET',
			},
		);

		const patchData = (await patchResponse.json()).data;
		const { url, method, headers } = patchData.secureDownloadData;

		// Download patch from returned S3 url
		const patchDownloadResponse = await fetch(url, {
			method: method,
			headers: {
				Accept: 'text/plain',
				Host: headers?.['Host']?.['0'] ?? '',
			},
		});

		return patchDownloadResponse.text();
	}
}
