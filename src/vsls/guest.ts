'use strict';
import { CancellationToken, Disposable, WorkspaceFolder } from 'vscode';
import { LiveShare, SharedServiceProxy } from 'vsls';
import { GitCommandOptions, Repository, RepositoryChange } from '../git/git';
import { debug, log } from '../system';
import { VslsHostService } from './host';
import {
    GitCommandRequestType,
    RepositoriesInFolderRequestType,
    RepositoryProxy,
    RequestType,
    WorkspaceFileExistsRequestType
} from './protocol';

export const leadingSlashRegex = /^[\/|\\]/;

export class VslsGuestService implements Disposable {
    static async connect(api: LiveShare) {
        const service = await api.getSharedService(VslsHostService.ServiceId);
        if (service == null) {
            throw new Error('Failed to connect to host service');
        }

        return new VslsGuestService(api, service);
    }

    constructor(
        private readonly _api: LiveShare,
        private readonly _service: SharedServiceProxy
    ) {
        _service.onDidChangeIsServiceAvailable(this.onAvailabilityChanged.bind(this));
    }

    dispose() {}

    @log()
    private onAvailabilityChanged(available: boolean) {
        // TODO
    }

    @log()
    async git<TOut extends string | Buffer>(options: GitCommandOptions, ...args: any[]) {
        const response = await this.sendRequest(GitCommandRequestType, { options: options, args: args });

        if (response.isBuffer) {
            return new Buffer(response.data, 'binary') as TOut;
        }
        return response.data as TOut;
    }

    @log()
    async getRepositoriesInFolder(
        folder: WorkspaceFolder,
        onAnyRepositoryChanged: (repo: Repository, reason: RepositoryChange) => void
    ): Promise<Repository[]> {
        const response = await this.sendRequest(RepositoriesInFolderRequestType, {
            folderUri: folder.uri.toString(true)
        });

        return response.repositories.map(
            (r: RepositoryProxy) => new Repository(folder, r.path, r.root, onAnyRepositoryChanged, false, r.closed)
        );
    }

    @log()
    async fileExists(
        repoPath: string,
        fileName: string,
        options: { ensureCase: boolean } = { ensureCase: false }
    ): Promise<boolean> {
        const response = await this.sendRequest(WorkspaceFileExistsRequestType, {
            fileName: fileName,
            repoPath: repoPath,
            options: options
        });

        return response.exists;
    }

    @debug()
    private sendRequest<TRequest, TResponse>(
        requestType: RequestType<TRequest, TResponse>,
        request: TRequest,
        cancellation?: CancellationToken
    ): Promise<TResponse> {
        return this._service.request(requestType.name, [request]);
    }
}
