'use strict';
import { CancellationToken, Disposable, Uri, workspace } from 'vscode';
import { LiveShare, SharedService } from 'vsls';
import { Container } from '../container';
import { git } from '../git/git';
import { log, Strings } from '../system';
import { Iterables } from '../system/iterable';
import {
    GitCommandRequest,
    GitCommandRequestType,
    GitCommandResponse,
    RepositoriesInFolderRequest,
    RepositoriesInFolderRequestType,
    RepositoriesInFolderResponse,
    RequestType,
    WorkspaceFileExistsRequest,
    WorkspaceFileExistsRequestType,
    WorkspaceFileExistsResponse,
    WorkspacePathsRequest,
    WorkspacePathsRequestType,
    WorkspacePathsResponse
} from './protocol';
import { vslsUriRootRegex } from './vsls';

export class VslsHostService implements Disposable {
    static ServiceId = 'proxy';

    static async share(api: LiveShare) {
        const service = await api.shareService(this.ServiceId);
        if (service == null) {
            throw new Error('Failed to share host service');
        }

        return new VslsHostService(api, service);
    }

    constructor(
        private readonly _api: LiveShare,
        private readonly _service: SharedService
    ) {
        _service.onDidChangeIsServiceAvailable(this.onAvailabilityChanged.bind(this));

        this.onRequest(GitCommandRequestType, this.onGitCommandRequest.bind(this));
        this.onRequest(RepositoriesInFolderRequestType, this.onRepositoriesInFolderRequest.bind(this));
        this.onRequest(WorkspaceFileExistsRequestType, this.onWorkspaceFileExistsRequest.bind(this));
        this.onRequest(WorkspacePathsRequestType, this.onWorkspacePathsRequest.bind(this));
    }

    dispose() {
        void this._api.unshareService(VslsHostService.ServiceId);
    }

    private onRequest<TRequest, TResponse>(
        requestType: RequestType<TRequest, TResponse>,
        handler: (request: TRequest, cancellation: CancellationToken) => Promise<TResponse>
    ) {
        this._service.onRequest(requestType.name, (args: any[], cancellation: CancellationToken) =>
            handler(args[0], cancellation)
        );
    }

    @log()
    private onAvailabilityChanged(available: boolean) {
        // TODO
    }

    @log()
    private async onGitCommandRequest(
        request: GitCommandRequest,
        cancellation: CancellationToken
    ): Promise<GitCommandResponse> {
        try {
            const data = await git(request.options, ...request.args);
            if (typeof data === 'string') {
                return { data: data };
            }

            return { data: data.toString('binary'), isBuffer: true };
        }
        catch (ex) {
            throw ex;
        }
    }

    @log()
    private async onRepositoriesInFolderRequest(
        request: RepositoriesInFolderRequest,
        cancellation: CancellationToken
    ): Promise<RepositoriesInFolderResponse> {
        const uri = this.convertSharedUriToLocal(Uri.parse(request.folderUri));
        const normalized = Strings.normalizePath(uri.fsPath, { stripTrailingSlash: true }).toLowerCase();

        const repos = [
            ...Iterables.filterMap(await Container.git.getRepositories(), r => {
                if (!r.normalizedPath.startsWith(normalized)) return undefined;

                const vslsUri = this.convertLocalUriToShared(r.folder.uri);
                return {
                    folderUri: vslsUri.toString(true),
                    path: vslsUri.path,
                    root: r.root,
                    closed: r.closed
                };
            })
        ];

        return {
            repositories: repos
        };
    }

    @log()
    private async onWorkspaceFileExistsRequest(
        request: WorkspaceFileExistsRequest,
        cancellation: CancellationToken
    ): Promise<WorkspaceFileExistsResponse> {
        return { exists: await Container.git.fileExists(request.repoPath, request.fileName, request.options) };
    }

    @log()
    private async onWorkspacePathsRequest(
        request: WorkspacePathsRequest,
        cancellation: CancellationToken
    ): Promise<WorkspacePathsResponse> {
        const paths = [];
        if (workspace.workspaceFolders !== undefined) {
            for (const f of workspace.workspaceFolders) {
                paths.push({
                    localUri: f.uri.toString(true),
                    sharedUri: this.convertLocalUriToShared(f.uri).toString(true)
                });
            }
        }

        return { paths: paths };
    }

    private convertLocalUriToShared(localUri: Uri) {
        let sharedUri = this._api.convertLocalUriToShared(localUri);

        const localPath = localUri.path;
        const sharedPath = sharedUri.path;
        if (sharedPath.endsWith(localPath)) {
            if (sharedPath.length === localPath.length) {
                const folder = workspace.getWorkspaceFolder(localUri)!;
                sharedUri = sharedUri.with({ path: `/~${folder.index}` });
            }
            else {
                sharedUri = sharedUri.with({ path: sharedPath.substr(0, sharedPath.length - localPath.length) });
            }
        }
        else if (!sharedPath.startsWith('/~')) {
            const folder = workspace.getWorkspaceFolder(localUri)!;
            sharedUri = sharedUri.with({ path: `/~${folder.index}${sharedPath}` });
        }

        return sharedUri;
    }

    private convertSharedUriToLocal(sharedUri: Uri) {
        if (vslsUriRootRegex.test(sharedUri.path)) {
            sharedUri = sharedUri.with({ path: `${sharedUri.path}/` });
        }

        const localUri = this._api.convertSharedUriToLocal(sharedUri);

        const localPath = localUri.path;
        const sharedPath = sharedUri.path;
        if (localPath.endsWith(sharedPath)) {
            return localUri.with({ path: localPath.substr(0, localPath.length - sharedPath.length) });
        }
        return localUri;
    }
}
