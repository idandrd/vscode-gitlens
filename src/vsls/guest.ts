'use strict';
import { CancellationToken, Disposable, Uri, WorkspaceFolder } from 'vscode';
import { LiveShare, SharedServiceProxy } from 'vsls';
import { GitCommandOptions, Repository, RepositoryChange } from '../git/git';
import { debug, Iterables, log, Strings } from '../system';
import { VslsHostService } from './host';
import {
    GitCommandRequestType,
    RepositoriesInFolderRequestType,
    RepositoryProxy,
    RequestType,
    WorkspaceFileExistsRequestType,
    WorkspacePathsRequestType
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

    private _localPathsRegex: RegExp | undefined;
    private _localToSharedPaths: Map<string, string> | undefined;
    private _sharedPathsRegex: RegExp | undefined;
    private _sharedToLocalPaths: Map<string, string> | undefined;

    @log()
    async cachePathMapping() {
        if (this._localToSharedPaths === undefined || this._sharedToLocalPaths === undefined) {
            const response = await this.sendRequest(WorkspacePathsRequestType, {});
            this._localToSharedPaths = new Map<string, string>();
            this._sharedToLocalPaths = new Map<string, string>();

            let localPath;
            let sharedPath;
            for (const p of response.paths) {
                localPath = Strings.normalizePath(Uri.parse(p.localUri).fsPath);
                sharedPath = Strings.normalizePath(Uri.parse(p.sharedUri).fsPath);

                this._localToSharedPaths.set(localPath, sharedPath);
                this._sharedToLocalPaths.set(sharedPath, localPath);
            }

            let localPaths = Iterables.join(this._sharedToLocalPaths.values(), '|');
            localPaths = localPaths.replace(/(\/|\\)/g, '[\\\\/|\\\\]');
            this._localPathsRegex = new RegExp(`(${localPaths})`, 'gi');

            let sharedPaths = Iterables.join(this._localToSharedPaths.values(), '|');
            sharedPaths = sharedPaths.replace(/(\/|\\)/g, '[\\\\/|\\\\]');
            this._sharedPathsRegex = new RegExp(`(${sharedPaths})`, 'gi');
        }
    }

    @log()
    async git<TOut extends string | Buffer>(options: GitCommandOptions, ...args: any[]) {
        await this.cachePathMapping();

        const cwd = Strings.normalizePath(options.cwd || '', { addLeadingSlash: true });
        const localCwd = this._sharedToLocalPaths!.get(cwd);
        if (localCwd !== undefined) {
            options.cwd = localCwd;
        }

        let files = false;
        let i = -1;
        for (const arg of args) {
            i++;
            if (arg === '--') {
                files = true;
                continue;
            }

            if (!files) continue;

            if (typeof arg === 'string') {
                // If we are the "root" workspace, then we need to remove the leading slash off the path (otherwise it will not be treated as a relative path)
                if (leadingSlashRegex.test(arg[0]) && cwd === '/~0') {
                    args.splice(i, 1, arg.substr(1));
                }

                if (this._sharedPathsRegex!.test(arg)) {
                    args.splice(
                        i,
                        1,
                        Strings.normalizePath(arg).replace(this._sharedPathsRegex!, (match, shared) => {
                            const local = this._sharedToLocalPaths!.get(shared);
                            return local != null ? local : shared;
                        })
                    );
                }
            }
        }

        const response = await this.sendRequest(GitCommandRequestType, { options: options, args: args });

        if (response.isBuffer) {
            return new Buffer(response.data, 'binary') as TOut;
        }

        if (this._localPathsRegex !== undefined && response.data.length > 0) {
            const data = response.data.replace(this._localPathsRegex, (match, local) => {
                const shared = this._localToSharedPaths!.get(local);
                return shared != null ? shared : local;
            });

            return data as TOut;
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
        if (this._sharedPathsRegex!.test(repoPath)) {
            repoPath = Strings.normalizePath(repoPath).replace(this._sharedPathsRegex!, (match, shared) => {
                const local = this._sharedToLocalPaths!.get(shared);
                return local != null ? local : shared;
            });
        }

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
