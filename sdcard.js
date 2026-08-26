const SOH = 0x01, STX = 0x02, EOT = 0x04, ACK = 0x06, NAK = 0x15, CAN = 0x18, C_CHAR = 0x43;
export class SDCardHandler {
    constructor(ws, term, viewer, callbacks) {
        this.ws = ws;
        this.term = term;
        this.viewer = viewer;

        // Callbacks: { onDownloadComplete(content, filename), pausePolling(), resumePolling(), switchToViewer() }
        this.callbacks = callbacks;

        this.path = "/";
        this.fileCount = 0;
        this.files = {}; // Map filename -> size (bytes)
        this.listedEntries = []; // Current directory listing for troubleshooting/export
        this.renderedDirPaths = new Set();
        this.folderChildren = new Map();

        // Download State
        this.isDownloading = false;
        this.downloadingFile = null; // Track current file being downloaded
        this.downloadTotal = 0;      // Total bytes expected
        this.downloadBuffer = "";
        this.downloadTimeout = null;
        this.downloadLineCount = 0;
        this.pendingRunFile = null; // Track file to run after download

        // YMODEM State
        this.ymodem = {
            active: false,
            state: 0,
            fileBytes: null,
            fileName: "",
            fileSize: 0,
            packetNum: 0,
            offset: 0
        };

        this.refreshPending = false;
        this._mountProbe = null;
        this._suppressNextSdError60 = false;
        this._formatting = false;
        this._formatSawCompletionMessage = false;
        this._mkdirPending = null;
        this._rmdirPending = null;

        // Listen for machine becoming idle so we can safely refresh if it was deferred (e.g., due to an Alarm on connect)
        window.addEventListener('machine-idle', () => {
            if (this.refreshPending) {
                this.refreshPending = false;
                console.log("SD Refresh: Machine is now Idle. Running deferred SD scan...");
                this.refresh();
            }
        });

        if (this.ws?.on) {
            this.ws.on('connect', () => {
                if (!window.sdMounted && this.fileCount === 0) {
                    this.path = "/";
                    this._prepareListing();
                }
            });

            this.ws.on('disconnect', () => {
                this._setMounted(false, { silent: true, reason: 'disconnected' });
                this.path = "/";
                this._prepareListing();
            });
        }
    }

    /**
     * Main handler for incoming serial lines.
     * Returns true if the line was consumed by SD logic.
     */
    processLine(line) {
        if (this._mkdirPending) {
            const lowerLine = line.toLowerCase();
            if (line === 'ok') {
                const pending = this._mkdirPending;
                this._mkdirPending = null;
                if (window.showToast) window.showToast(`Folder Created`, 'folder-plus', 'success');
                setTimeout(() => this.goToPath(pending.refreshPath), 150);
                return true;
            }

            if (lowerLine.startsWith('error:') || lowerLine.includes('directory create failed')) {
                this._mkdirPending = null;
                if (window.showToast) window.showToast('Folder Create Failed', 'triangle-alert', 'error');
                return false;
            }
        }

        if (this._rmdirPending) {
            const lowerLine = line.toLowerCase();
            if (line === 'ok') {
                const pending = this._rmdirPending;
                this._rmdirPending = null;
                if (window.showToast) window.showToast('Folder Deleted', 'folder-minus', 'success');
                setTimeout(() => this.goToPath(pending.refreshPath), 150);
                return true;
            }

            if (lowerLine.startsWith('error:') || lowerLine.includes('directory remove failed')) {
                this._rmdirPending = null;
                if (window.showToast) window.showToast('Folder Delete Failed', 'triangle-alert', 'error');
                return false;
            }
        }

        if (this._formatting) {
            if (line.includes('File system format failed') || line.toLowerCase() === 'error:85') {
                this._finishFormat(false);
                return false;
            }

            if (line === '[MSG:]') {
                this._formatSawCompletionMessage = true;
                return false;
            }

            if (line === 'ok' && this._formatSawCompletionMessage) {
                this._finishFormat(true);
                return false;
            }
        }

        if (this._suppressNextSdError60 && line.toLowerCase() === 'error:60') {
            this._suppressNextSdError60 = false;
            return true;
        }

        if (this._mountProbe) {
            if (line.includes('Failed to initialize SD card')) {
                this._mountProbe.failed = true;
                return true;
            }

            if (line.includes('SD Card mount failed')) {
                this._setMounted(false, { silent: this._getMountProbeSilent('failure'), reason: 'mount-failed' });
                this._showNoSdCardMessage();
                this._mountProbe = null;
                this._suppressNextSdError60 = true;
                return true;
            }

            if (line.toLowerCase() === 'error:60') {
                this._setMounted(false, { silent: this._getMountProbeSilent('failure'), reason: 'mount-failed' });
                this._showNoSdCardMessage();
                this._mountProbe = null;
                return true;
            }

            if (line === 'ok') {
                const probe = this._mountProbe;
                const failed = !!probe.failed;
                const silent = this._getMountProbeSilent(failed ? 'failure' : 'success');
                this._mountProbe = null;
                if (failed) {
                    this._setMounted(false, { silent, reason: 'mount-failed' });
                    this._showNoSdCardMessage();
                    return true;
                }

                this._setMounted(true, { silent, reason: 'mount-ok' });
                if (probe.listAfterMount) {
                    this._requestSerialList();
                }
                return true;
            }
        }

        // 1. Download Mode
        if (this.isDownloading) {
            // Ignore realtime status reports during download
            if (line.startsWith('<')) return true;

            // console.log("SD Download Line:", line);

            // Check for 'ok' on its own line OR appended to end (e.g. "%ok")
            if (line.trim() === 'ok' || line.endsWith('ok')) {
                // Remove 'ok' from the line if it's appended
                if (line.endsWith('ok') && line.trim() !== 'ok') {
                    const content = line.substring(0, line.lastIndexOf('ok'));
                    if (content.trim().length > 0) {
                        this.downloadBuffer += content + "\n";
                        this.downloadLineCount++;
                    }
                }

                if (this.downloadBuffer.length > 0) {
                    if (this.downloadTimeout) clearTimeout(this.downloadTimeout);
                    this._finishDownload();
                    return true;
                }
            }

            if (line === 'ok' && this.downloadBuffer.length === 0) return true;

            this.downloadBuffer += line + "\n";
            this.downloadLineCount++;

            // Update UI Progress (throttle slightly)
            if (this.downloadLineCount % 10 === 0) {
                this._updateDownloadProgress();
            }

            if (this.downloadTimeout) clearTimeout(this.downloadTimeout);
            this.downloadTimeout = setTimeout(() => {
                console.warn("Download finished due to timeout. The 'ok' confirmation was not received.");
                this._finishDownload();
            }, 1000);

            return true;
        }

        // 2. File Listing
        if (line.startsWith('[FILE:')) {
            this._setMounted(true);
            this._addSdFile(line);
            return true;
        }
        if (line.startsWith('[DIR:')) {
            this._setMounted(true);
            this._addSdDir(line);
            return true;
        }

        return false;
    }

    // --- Actions ---

    async refresh() {
        // Prevent SD refresh if machine is in an Alarm state (Error 79)
        const stateEl = document.getElementById('machine-state');
        if (stateEl && stateEl.textContent.toLowerCase().includes('alarm')) {
            console.warn("Skipping SD card refresh: Machine is in an Alarm state. Will run when Idle.");
            this.refreshPending = true;
            return;
        }

        this.refreshPending = false;
        this._prepareListing();

        if (window.sdMounted) {
            this._requestSerialList();
            return;
        }

        this.mountAndList({ silent: false });
    }

    probeAvailabilityOnBoot() {
        this._prepareListing();
        window.sdMounted = false;
        if (window.syncSdUploadBtn) window.syncSdUploadBtn();
        this._mountProbe = { silentSuccess: false, silentFailure: true, listAfterMount: true };
        this.ws.sendCommand('$FM');
    }

    mountAndList(options = {}) {
        this._mountProbe = {
            silent: !!options.silent,
            listAfterMount: true
        };
        this.ws.sendCommand('$FM');
    }

    _getMountProbeSilent(result) {
        if (!this._mountProbe) return false;
        if (result === 'success' && this._mountProbe.silentSuccess !== undefined) {
            return !!this._mountProbe.silentSuccess;
        }
        if (result === 'failure' && this._mountProbe.silentFailure !== undefined) {
            return !!this._mountProbe.silentFailure;
        }
        return !!this._mountProbe.silent;
    }

    _prepareListing() {
        const tbody = document.querySelector('#sd-table tbody');
        if (tbody) tbody.innerHTML = '';

        const table = document.getElementById('sd-table');
        if (table) {
            table.classList.remove('min-w-[500px]');
            table.classList.add('w-full', 'table-fixed');
        }

        const headers = document.querySelectorAll('#sd-table thead th');
        if (headers.length >= 3) {
            headers[0].className = 'px-4 py-3 font-bold text-left';
            headers[1].className = 'w-[64px] px-2 py-3 font-bold whitespace-nowrap';
            headers[2].className = 'w-[120px] px-1 py-3 font-bold text-right whitespace-nowrap';
        }

        this._renderBreadcrumb();

        this.fileCount = 0;
        this.files = {};
        this.listedEntries = [];
        this.renderedDirPaths = new Set();
        this.folderChildren = new Map();

        const badge = document.getElementById('sd-badge');
        if (badge) badge.classList.add('hidden');

        if (!this.ws?.isConnected) {
            this._showConnectMessage();
        }
    }

    _showNoSdCardMessage() {
        const tbody = document.querySelector('#sd-table tbody');
        if (!tbody) return;
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="px-6 py-12 text-center text-grey">
                    <div class="flex flex-col items-center gap-2">
                        <i data-lucide="hard-drive" class="w-8 h-8 text-grey"></i>
                        <span class="font-bold text-secondary-dark">SD Card Not Found</span>
                        <span class="text-xs text-grey">Disconnect and power down. Insert a SD Card, then power on and reconnect.</span>
                    </div>
                </td>
            </tr>`;
        if (window.lucide) window.lucide.createIcons();
    }

    _showConnectMessage() {
        const tbody = document.querySelector('#sd-table tbody');
        if (!tbody) return;
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="px-6 py-12 text-center text-grey">
                    <div class="flex flex-col items-center gap-2">
                        <i data-lucide="plug-zap" class="w-8 h-8 text-grey"></i>
                        <span class="font-bold text-secondary-dark">Not Connected</span>
                        <span class="text-xs text-grey">Please connect to load files...</span>
                    </div>
                </td>
            </tr>`;
        if (window.lucide) window.lucide.createIcons();
    }

    _requestSerialList() {
        this.ws.sendCommand('$F+');
    }

    _normalizePath(path) {
        const raw = String(path || '/').replace(/\\/g, '/').trim();
        if (!raw || raw === '/') return '/';

        const parts = raw.split('/').filter(Boolean);
        return `/${parts.join('/')}`;
    }

    _joinPath(basePath, entryName) {
        const base = this._normalizePath(basePath);
        const child = String(entryName || '').replace(/^\/+|\/+$/g, '');
        if (!child) return base;
        return base === '/' ? `/${child}` : `${base}/${child}`;
    }

    _getParentPath(fullPath) {
        const normalized = this._normalizePath(fullPath);
        if (normalized === '/') return '/';

        const parts = normalized.split('/').filter(Boolean);
        return parts.length <= 1 ? '/' : `/${parts.slice(0, -1).join('/')}`;
    }

    _getRelativeParts(fullPath) {
        const normalized = this._normalizePath(fullPath);
        const currentPath = this._normalizePath(this.path);

        if (currentPath === '/') return normalized.split('/').filter(Boolean);
        if (!normalized.startsWith(`${currentPath}/`)) return [];

        return normalized.slice(currentPath.length + 1).split('/').filter(Boolean);
    }

    _isVisibleInCurrentPath(fullPath) {
        return this._getParentPath(fullPath) === this._normalizePath(this.path);
    }

    _escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _escapeJsString(value) {
        return String(value ?? '').split('\\').join('\\\\').split("'").join("\\'");
    }

    _ensureFolderMeta(dirPath) {
        const normalized = this._normalizePath(dirPath);
        if (!this.folderChildren.has(normalized)) {
            this.folderChildren.set(normalized, new Set());
        }
        return this.folderChildren.get(normalized);
    }

    _registerFolderChild(parentPath, childPath) {
        const parent = this._normalizePath(parentPath);
        const child = this._normalizePath(childPath);
        if (parent === child) return;

        const children = this._ensureFolderMeta(parent);
        const beforeSize = children.size;
        children.add(child);

        if (children.size !== beforeSize) {
            this._updateDirectoryRow(parent);
        }
    }

    _getFolderChildCount(dirPath) {
        return this._ensureFolderMeta(dirPath).size;
    }

    _isDirectoryEmpty(dirPath) {
        return this._getFolderChildCount(dirPath) === 0;
    }

    _renderDirectoryActions(dirPath) {
        if (!this._isDirectoryEmpty(dirPath)) return '';

        const safePath = this._escapeJsString(dirPath);
        return `
            <button class="macro-card-action-btn" onclick="window.sdHandler.removeDirectory('${safePath}')" title="Delete folder" type="button" aria-label="Delete folder">
                <i data-lucide="trash-2" style="width:12px;height:12px"></i>
            </button>`;
    }

    _renderDirectoryBadge(dirPath) {
        const count = this._getFolderChildCount(dirPath);
        return `<span class="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary/10 text-secondary-dark text-[11px] font-extrabold leading-none shrink-0" title="${count} item${count === 1 ? '' : 's'}">${count}</span>`;
    }

    _updateDirectoryRow(dirPath) {
        const normalized = this._normalizePath(dirPath);
        const row = document.querySelector(`#sd-table tbody tr[data-dirpath="${CSS.escape(normalized)}"]`);
        if (!row) return;

        const badgeSlot = row.querySelector('[data-folder-count]');
        if (badgeSlot) {
            badgeSlot.innerHTML = this._renderDirectoryBadge(normalized);
        }

        const actions = row.querySelector('[data-folder-actions]');
        if (actions) {
            actions.innerHTML = this._renderDirectoryActions(normalized);
        }

        if (window.lucide) lucide.createIcons();
    }

    _ensureDirectoryVisible(dirPath) {
        const normalized = this._normalizePath(dirPath);
        const currentPath = this._normalizePath(this.path);
        if (normalized === currentPath || this.renderedDirPaths.has(normalized)) return;
        if (this._getParentPath(normalized) !== currentPath) return;

        this.renderedDirPaths.add(normalized);
        this._ensureFolderMeta(normalized);
        const name = normalized.split('/').filter(Boolean).pop();
        const tbody = document.querySelector('#sd-table tbody');
        if (!tbody) return;

        this.listedEntries.push({ type: 'dir', name, fullPath: normalized });

        const row = document.createElement('tr');
        row.className = "border-b border-grey-light cursor-pointer group";
        row.onclick = (e) => {
            if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I' && e.target.tagName !== 'SPAN') {
                this.enterDir(name);
            }
        };

        row.innerHTML = `
          <td class="px-4 py-3 md:px-6 md:py-3 text-grey-dark align-middle truncate overflow-hidden">
              <button type="button" class="flex items-center gap-2 truncate w-full text-left text-primary hover:underline" onclick="window.sdHandler.enterDir('${this._escapeJsString(name)}')">
                  <i data-lucide="folder" style="width:14px;height:14px" class="text-primary opacity-70 shrink-0"></i>
                  <span class="truncate" title="${this._escapeHtml(name)}">${this._escapeHtml(name)}</span>
                  <span data-folder-count>${this._renderDirectoryBadge(normalized)}</span>
              </button>
          </td>

          <td class="w-[64px] px-2 py-3 text-grey text-xs whitespace-nowrap">-</td>

          <td class="w-[120px] px-1 py-3 text-right align-middle whitespace-nowrap">
              <div class="macro-card-actions justify-end ml-auto" data-folder-actions style="position: static; opacity: 1;">
                  ${this._renderDirectoryActions(normalized)}
              </div>
          </td>`;

        row.dataset.dirpath = normalized;
        tbody.insertBefore(row, tbody.firstChild);
        if (window.lucide) lucide.createIcons();
    }

    _renderBreadcrumb() {
        const pathEl = document.getElementById('sd-current-path');
        const upLevelBtn = document.getElementById('sd-up-level-btn');
        const currentPath = this._normalizePath(this.path);
        const isConnected = !!this.ws?.isConnected;
        const available = !!(window.sdMounted && isConnected && !window.sdJobActive);

        if (upLevelBtn) {
            upLevelBtn.disabled = !available || currentPath === '/';
        }

        if (!pathEl) {
            if (window.syncSdUploadBtn) window.syncSdUploadBtn();
            return;
        }

        pathEl.innerHTML = '';

        const parts = currentPath.split('/').filter(Boolean);
        const sepText = parts.length > 0 ? '' : '/';
        const makeCrumb = (label, targetPath, isCurrent) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = label;
            btn.disabled = !available || isCurrent;
            btn.className = `truncate ${isCurrent ? 'text-secondary-dark cursor-default' : 'text-primary hover:underline disabled:text-grey disabled:no-underline'}`;
            if (!isCurrent) {
                btn.addEventListener('click', () => this.goToPath(targetPath));
            }
            return btn;
        };

        pathEl.appendChild(makeCrumb(sepText, '/', currentPath === '/'));

        let runningPath = '';
        for (let i = 0; i < parts.length; i++) {
            runningPath = this._joinPath(runningPath || '/', parts[i]);

            const sep = document.createElement('span');
            sep.textContent = ' / ';
            sep.className = 'text-grey';
            pathEl.appendChild(sep);

            pathEl.appendChild(makeCrumb(parts[i], runningPath, i === parts.length - 1));
        }

        if (window.syncSdUploadBtn) window.syncSdUploadBtn();
    }

    _changeDirectory(targetPath) {
        if (!window.isSdActionAvailable || !window.isSdActionAvailable()) {
            if (window.reporter) window.reporter.showAlert('SD Card Unavailable', 'SD Card functions are currently unavailable.');
            return;
        }

        const normalized = this._normalizePath(targetPath);
        this.path = normalized;
        this._renderBreadcrumb();
        this._prepareListing();
        this.ws.sendCommand(`$CWD=${normalized}`);
        setTimeout(() => this._requestSerialList(), 250);
    }

    _setMounted(isMounted, options = {}) {
        window.sdMounted = !!isMounted;
        window.dispatchEvent(new CustomEvent('sd-mount-state', {
            detail: {
                state: isMounted ? 1 : 0,
                silent: !!options.silent,
                reason: options.reason || (isMounted ? 'mounted' : 'unmounted')
            }
        }));
    }

    upLevel() {
        if (this.path === "/") return;
        const p = this.path.split('/');
        p.pop();
        this.goToPath(p.join('/') || '/');
    }

    enterDir(dirName) {
        this.goToPath(this._joinPath(this.path, dirName));
    }

    goToPath(path) {
        const targetPath = this._normalizePath(path);
        if (targetPath === this._normalizePath(this.path)) {
            this.refresh();
            return;
        }

        this._changeDirectory(targetPath);
    }

    createDirectory() {
        if (!window.isSdActionAvailable || !window.isSdActionAvailable()) {
            if (window.reporter) window.reporter.showAlert('SD Card Unavailable', 'SD Card functions are currently unavailable.');
            return;
        }

        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        const defaultName = 'NewFolder';
        const submit = (folderName) => {
            const trimmed = String(folderName || '').trim();
            if (!trimmed) return;

            const fullPath = trimmed.startsWith('/') ? this._normalizePath(trimmed) : this._joinPath(this.path, trimmed);
            this._mkdirPending = { refreshPath: this.path };
            this.ws.sendCommand(`$FMD=${fullPath}`);
        };

        if (reporter) {
            reporter.showPrompt('Create Folder', 'Enter folder name for the current SD directory:', defaultName, submit);
        } else {
            const folderName = prompt('Enter folder name for the current SD directory:', defaultName);
            if (folderName !== null) submit(folderName);
        }
    }

    removeDirectory(dirPath) {
        const normalized = this._normalizePath(dirPath);
        const folderName = normalized.split('/').filter(Boolean).pop() || '/';
        if (!this._isDirectoryEmpty(normalized)) {
            if (window.reporter) {
                window.reporter.showAlert('Folder Not Empty', 'Only empty folders can be deleted.');
            }
            return;
        }

        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        const processDelete = () => {
            this._rmdirPending = { refreshPath: this.path };
            this.ws.sendCommand(`$FRD=${normalized}`);
        };

        if (reporter) {
            reporter.showConfirm('Delete Folder', `Delete ${folderName} from the SD Card?`, processDelete);
        } else if (confirm(`Delete ${folderName}?`)) {
            processDelete();
        }
    }

    delete(fileName) {
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        const fullPath = this.path === '/' ? `/${fileName}` : `${this.path}/${fileName}`;

        const processDelete = async () => {
            if (this.ws.httpBaseUrl) {
                try {
                    let p = this.path;
                    if (!p.startsWith('/')) p = '/' + p;
                    const url = `${this.ws.httpBaseUrl}/sdfiles?path=${encodeURIComponent(p)}&filename=${encodeURIComponent(fileName)}&action=delete`;
                    const response = await fetch(url);
                    if (response.ok) {
                        this.refresh();
                        return;
                    }
                } catch (e) {
                    console.warn("HTTP delete failed:", e);
                }
            }
            this.ws.sendCommand(`$FD=${fullPath}`);
            setTimeout(() => this.refresh(), 1000);
        };

        if (reporter) {
            reporter.showConfirm('Delete File', `Delete ${fileName} from the SD Card?`, processDelete);
        } else if (confirm(`Delete ${fileName}?`)) {
            processDelete();
        }
    }

    async preview(fileName, skipConfirm = false) {
        if (this.isDownloading) return;

        const processPreview = async () => {
            this.isDownloading = true;
            this.downloadingFile = fileName;
            const fullPath = this.path === '/' ? `/${fileName}` : `${this.path}/${fileName}`;
            this.downloadingFullPath = fullPath;
            this.downloadTotal = this.files[fileName] || 0;
            console.log(`Starting download for ${fileName}. Expected size: ${this.downloadTotal} bytes`);

            this.downloadBuffer = "";
            this.downloadLineCount = 0;

            // Show Progress Bar in UI
            this._toggleProgressUI(fileName, true);
            this.term.writeln(`\x1b[33mDownloading ${fullPath}...\x1b[0m`);

            if (this.ws.httpBaseUrl) {
                try {
                    const response = await fetch(`${this.ws.httpBaseUrl}/sd${fullPath}`);
                    if (response.ok) {
                        const content = await response.text();
                        this.downloadBuffer = content;
                        this._finishDownload();
                        return;
                    }
                } catch (e) {
                    console.warn("HTTP download failed, falling back to serial:", e);
                }
            }

            this.ws.sendCommand(`$F<=${fullPath}`);
        };

        if (skipConfirm) {
            processPreview();
        } else {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
            if (reporter) {
                reporter.showConfirm('Download File', `Load ${fileName} for 3D preview?`, processPreview);
            } else if (confirm(`Download ${fileName}?`)) {
                processPreview();
            }
        }
    }

    runFile(fileName) {
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        const fullPath = this.path === '/' ? `/${fileName}` : `${this.path}/${fileName}`;

        if (reporter) {
            reporter.showConfirm(
                'Load to Viewer?',
                `Load ${fileName} into the 3D Preview before running?`,
                () => { // Yes: Load
                    this.pendingRunFile = fileName;
                    this.preview(fileName, true);
                },
                () => { // No: Ask to run directly
                    reporter.showConfirm(
                        'Run Directly?',
                        `Run ${fileName} directly from SD Card without preview?`,
                        () => { // Yes
                            this.ws.sendCommand(`$F=${fullPath}`);
                        },
                        null, // Cancel: Do nothing
                        'Run Now',
                        'Cancel'
                    );
                },
                'Load & View',
                'No'
            );
        } else {
            // Fallback
            const processDirectRun = () => {
                this.ws.sendCommand(`$F=${fullPath}`);
            };

            const processLoadAndView = () => {
                this.pendingRunFile = fileName;
                this.preview(fileName, true);
            };

            if (reporter) {
                reporter.showConfirm('Load & View', `Load ${fileName} to 3D Viewer?`, processLoadAndView, () => {
                    reporter.showConfirm('Run Directly', `Run ${fileName} directly from SD?`, processDirectRun);
                });
            } else if (confirm(`Load ${fileName} to 3D Viewer?`)) {
                processLoadAndView();
            } else if (confirm(`Run ${fileName} directly from SD?`)) {
                processDirectRun();
            }
        }
    }

    runMacro(pNum) {
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        const processMacro = () => {
            this.ws.sendCommand(`G65 P${pNum}`);
            this.term.writeln(`\x1b[36m> Executing Macro: P${pNum}\x1b[0m`);
        };

        if (reporter) {
            reporter.showConfirm('Run Macro', `Execute Macro P${pNum}?`, processMacro);
        } else if (confirm(`Execute Macro P${pNum}?`)) {
            processMacro();
        }
    }

    // --- Internal Parsing ---

    _addSdFile(line) {
        const content = line.replace('[FILE:', '').replace(']', '').split('|');
        const fullPath = this._normalizePath(content[0]);
        this._registerFolderChild(this._getParentPath(fullPath), fullPath);
        const relativeParts = this._getRelativeParts(fullPath);
        if (relativeParts.length > 1) {
            this._ensureDirectoryVisible(this._joinPath(this.path, relativeParts[0]));
            return;
        }
        if (!this._isVisibleInCurrentPath(fullPath)) return;

        const name = fullPath.split('/').pop();

        // Parse Size
        const sizePart = content.find(p => p.startsWith('SIZE:'));
        let sizeDisplay = '-';
        let bytes = 0;

        if (sizePart) {
            bytes = parseInt(sizePart.split(':')[1]);
            if (bytes < 0) {
                this._ensureDirectoryVisible(fullPath);
                return;
            }
            sizeDisplay = this._formatBytes(bytes);
            this.files[fullPath] = bytes; // Store for progress calculation
            this.term.writeln(`  \x1b[2m${name}  (${sizeDisplay})\x1b[0m`);
        }
        this.listedEntries.push({ type: 'file', name, fullPath, bytes, sizeDisplay });

        // Update Badge
        this.fileCount++;
        const badge = document.getElementById('sd-badge');
        badge.textContent = this.fileCount;
        badge.classList.remove('hidden');

        const macroMatch = name.match(/^P(\d+)\.macro$/i);
        let runActionBtn = '';

        if (macroMatch) {
            const pNum = macroMatch[1];
            runActionBtn = `
            <button class="macro-card-action-btn" onclick="window.sdHandler.runMacro('${pNum}')" title="Run macro" type="button" aria-label="Run macro">
                <i data-lucide="settings" style="width:12px;height:12px"></i>
            </button>`;
        } else {
            runActionBtn = `
            <button class="macro-card-action-btn" onclick="window.sdHandler.runFile('${name}')" title="Run" type="button" aria-label="Run file">
                <i data-lucide="play" style="width:12px;height:12px"></i>
            </button>`;
        }

        // Generate Safe ID for progress selection (base64 encoded to handle special chars)
        const safeId = btoa(fullPath).replace(/=/g, '');

        const row = `
          <tr class="border-b border-grey-light last:border-b-0 group" data-filename="${name}" data-fullpath="${fullPath}">
              <td class="px-4 py-2 md:px-6 md:py-3 text-grey-dark align-middle truncate overflow-hidden">
                  <div class="flex flex-col justify-center w-full">
                      <div class="flex items-center gap-2 truncate">
                          <i data-lucide="file-code" style="width:14px;height:14px" class="text-grey shrink-0"></i>
                          <span class="truncate" title="${name}">${name}</span>
                      </div>

                      <div id="sd-prog-${safeId}" class="hidden w-full max-w-[200px] mt-1.5 ml-6 md:ml-0 bg-grey-light rounded-full h-1">
                        <div class="bg-primary h-1 rounded-full transition-all duration-200" style="width: 0%"></div>
                      </div>

                  </div>
              </td>

              <td class="w-[64px] px-2 py-3 text-grey font-mono text-xs whitespace-nowrap">${sizeDisplay}</td>

              <td class="w-[120px] px-1 py-2 text-right align-middle whitespace-nowrap">
                  <div class="macro-card-actions justify-end ml-auto" style="position: static; opacity: 1;">
                      <button class="macro-card-action-btn" onclick="window.sdHandler.delete('${name}')" title="Delete" type="button" aria-label="Delete file">
                        <i data-lucide="trash-2" style="width:12px;height:12px"></i>
                      </button>

                      <button class="macro-card-action-btn" onclick="window.sdHandler.preview('${name}')" title="Preview" type="button" aria-label="Preview file">
                        <i data-lucide="eye" style="width:12px;height:12px"></i>
                      </button>

                      ${runActionBtn}
                  </div>
              </td>
          </tr>`;

        document.querySelector('#sd-table tbody').insertAdjacentHTML('beforeend', row);
        if (window.lucide) lucide.createIcons();
    }

    _toggleProgressUI(fileName, show) {
        const fullPath = this._normalizePath(this.path === '/' ? `/${fileName}` : `${this.path}/${fileName}`);
        const safeId = btoa(fullPath).replace(/=/g, '');
        const container = document.getElementById(`sd-prog-${safeId}`);
        if (container) {
            if (show) {
                container.classList.remove('hidden');
                container.firstElementChild.style.width = '0%';
            } else {
                container.classList.add('hidden');
            }
        }
    }

    _updateDownloadProgress() {
        if (!this.downloadingFile || this.downloadTotal <= 0) {
            // console.warn("Skipping progress update:", this.downloadingFile, this.downloadTotal);
            return;
        }

        const currentBytes = this.downloadBuffer.length;
        const pct = Math.min(100, Math.round((currentBytes / this.downloadTotal) * 100));
        // console.log(`Download Progress: ${currentBytes}/${this.downloadTotal} (${pct}%)`);

        const safeId = btoa(this._normalizePath(this.downloadingFullPath)).replace(/=/g, '');
        const bar = document.querySelector(`#sd-prog-${safeId} > div`);
        if (bar) {
            bar.style.width = `${pct}%`;
        }
    }

    _formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }

    _addSdDir(line) {
        const fullPath = this._normalizePath(line.replace('[DIR:', '').replace(']', ''));
        this._registerFolderChild(this._getParentPath(fullPath), fullPath);
        this._ensureDirectoryVisible(fullPath);
    }

    _finishDownload() {
        // Hide progress before resetting state
        if (this.downloadingFile) {
            this._toggleProgressUI(this.downloadingFile, false);
        }

        this.isDownloading = false;
        const filename = this.downloadingFile; // Capture name
        this.downloadingFile = null;
        this.downloadTotal = 0;

        if (this.downloadTimeout) clearTimeout(this.downloadTimeout);

        // Remove XML-style tags and realtime status reports
        const cleanContent = this.downloadBuffer.replace(/<[^>]*>/g, '').trim();
        const lines = cleanContent.split('\n').filter(l => l.trim().length > 0 && l.trim() !== 'ok');

        if (lines.length === 0) {
            this.term.writeln(`\x1b[31mDownload Failed: No data.\x1b[0m`);
            console.error("SD Download Failed: Buffer empty");
        } else {
            this.term.writeln(`\x1b[32mDownloaded ${lines.length} lines.\x1b[0m`);
            console.log(`SD Download Success: ${lines.length} lines. Calling callbacks...`);
            if (this.callbacks.onDownloadComplete) {
                // Pass filename AND fullPath
                this.callbacks.onDownloadComplete(cleanContent, filename, this.downloadingFullPath);
            }
            this.viewer.processGCodeString(cleanContent, `${filename} parsed`);
            if (this.callbacks.switchToViewer) {
                this.callbacks.switchToViewer();
            }

            // Trigger Run Prompt if this download was initiated by runFile
            if (this.pendingRunFile === filename) {
                this.pendingRunFile = null;
                setTimeout(() => {
                    const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
                    const promptMsg = `File ${filename} loaded. Run now?`;
                    const fullPath = this.path === '/' ? `/${filename}` : `${this.path}/${filename}`;

                    if (reporter) {
                        reporter.showConfirm('Run Job', promptMsg,
                            () => this.ws.sendCommand(`$F=${fullPath}`),
                            null,
                            'Run Job',
                            'Cancel'
                        );
                    } else if (confirm(promptMsg)) {
                        this.ws.sendCommand(`$F=${fullPath}`);
                    }
                }, 500);
            }
        }
    }

    // --- YMODEM Upload ---

    format() {
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);

        const processFormat = () => {
            this.term.writeln('\x1b[33mFormatting SD Card...\x1b[0m');
            this._formatting = true;
            this._formatSawCompletionMessage = false;
            this.ws.sendCommand('$FF=yes');
        };

        if (reporter) {
            reporter.showConfirm('Format SD Card',
                'This will permanently delete ALL files on the SD Card. This cannot be undone.',
                processFormat,
                null,
                'Format',
                'Cancel'
            );
        } else if (confirm('Format the SD Card? This will delete ALL files and cannot be undone.')) {
            processFormat();
        }
    }

    _finishFormat(success) {
        if (!this._formatting) return;
        this._formatting = false;
        this._formatSawCompletionMessage = false;

        if (success) {
            if (window.showToast) window.showToast('SD Card Formatted', 'hard-drive', 'success');
            this.refresh();
        } else {
            if (window.showToast) window.showToast('SD Card Format Failed', 'triangle-alert', 'error');
        }
    }

    async startUpload(file, onComplete = null, options = {}) {
        if (!file) return;
        if (!window.isSdActionAvailable || !window.isSdActionAvailable()) {
            if (window.reporter) window.reporter.showAlert('SD Card Unavailable', 'SD Card functions are currently unavailable.');
            return;
        }
        const name = file.name.replace(/\s/g, '_');
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        const skipConfirm = options.skipConfirm === true;

        const processUpload = async () => {
            const fp = this.path === '/' ? name : `${this.path}/${name}`;
            this.ymodem.fileName = name;
            this.ymodem.onComplete = onComplete;

            if (this.ws.httpBaseUrl) {
                const formData = new FormData();
                formData.append('path', this.path);
                formData.append('file', file, name);

                const xhr = new XMLHttpRequest();
                xhr.open('POST', `${this.ws.httpBaseUrl}/upload`, true);

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        document.getElementById('upload-progress-bar').style.width = `${pct}%`;
                        document.getElementById('upload-pct').textContent = `${pct}%`;
                    }
                };

                xhr.onload = () => {
                    if (xhr.status === 200 || xhr.status === 204) {
                        this.term.writeln(`\x1b[32m[HTTP] Upload of ${name} successful.\x1b[0m`);
                        this._finishYmodem();
                    } else {
                        this._abortYmodem(`Upload failed: ${xhr.statusText} (${xhr.status})`);
                    }
                };

                xhr.onerror = () => this._abortYmodem('Network error during HTTP upload');

                document.getElementById('upload-progress-container').classList.remove('hidden');
                document.getElementById('upload-progress-container').style.display = 'block';
                document.getElementById('upload-progress-bar').style.width = '0%';
                document.getElementById('upload-pct').textContent = '0%';

                this.term.writeln(`\x1b[35m[HTTP] Starting upload: ${fp}...\x1b[0m`);
                xhr.send(formData);
                return;
            }

            // Fallback to YMODEM
            const ab = await file.arrayBuffer();
            const bytes = new Uint8Array(ab);

            if (this.callbacks.pausePolling) this.callbacks.pausePolling();
            this.ws.setRawHandler((data) => this._handleYmodemInput(data));

            this.ymodem = {
                active: true,
                state: 1,
                fileBytes: bytes,
                fileName: name,
                filePath: fp,
                fileSize: bytes.length,
                packetNum: 0,
                offset: 0,
                onComplete: onComplete
            };

            document.getElementById('upload-progress-container').classList.remove('hidden');
            document.getElementById('upload-progress-container').style.display = 'block';
            document.getElementById('upload-progress-container').style.opacity = '1';
            document.getElementById('upload-progress-bar').style.width = '0%';
            document.getElementById('upload-pct').textContent = '0%';

            this.term.writeln('\x1b[35m[YMODEM] Sending file header...\x1b[0m');

            // Sender-initiated: GrblHAL auto-detects SOH/STX via trap_initial_soh.
            // Send packet 0 (SOH + filename + filesize) directly — no $FY command needed.
            await this._sendPacket0();
            console.log("[YMODEM] Sent packet 0, waiting for controller ACK...");
        };

        if (skipConfirm) {
            processUpload();
        } else if (reporter) {
            reporter.showConfirm('SD Upload', `Upload ${name} (${this._formatBytes(file.size)}) to the SD Card`, processUpload);
        } else if (confirm(`Upload ${name} (${this._formatBytes(file.size)})?`)) {
            processUpload();
        }
    }

    _handleYmodemInput(data) {
        for (let i = 0; i < data.length; i++) {
            this._processYmodemByte(data[i]);
        }
    }

    async _processYmodemByte(b) {
        const y = this.ymodem;
        // State 1: After sending packet 0, wait for ACK (then 'C') or just 'C'
        if (y.state === 1) {
            if (b === ACK) {
                y.state = 10;
            } else if (b === C_CHAR) {
                y.state = 2;
                y.packetNum = 1;
                await this._sendNextDataPacket();
            }
        // State 10: Got ACK after packet 0, now wait for 'C'
        } else if (y.state === 10) {
            if (b === C_CHAR) {
                y.state = 2;
                y.packetNum = 1;
                await this._sendNextDataPacket();
            }
        // State 2: Data transfer — wait for ACK/NAK after each data packet
        } else if (y.state === 2) {
            if (b === ACK) {
                y.offset += 1024;
                const pct = Math.min(100, Math.round((y.offset / y.fileSize) * 100));
                document.getElementById('upload-progress-bar').style.width = `${pct}%`;
                document.getElementById('upload-pct').textContent = `${pct}%`;

                if (y.offset < y.fileSize) {
                    y.packetNum++;
                    await this._sendNextDataPacket();
                } else {
                    await this.ws.writeRaw(new Uint8Array([EOT]));
                    y.state = 3;
                }
            } else if (b === NAK) {
                await this._sendNextDataPacket();
            } else if (b === CAN) {
                this._abortYmodem('Cancelled');
            }
        // State 3: After EOT, wait for ACK (then 'C')
        } else if (y.state === 3) {
            if (b === NAK) {
                await this.ws.writeRaw(new Uint8Array([EOT]));
            } else if (b === ACK) {
                y.state = 30;
            }
        // State 30: Got ACK after EOT, now wait for 'C' (prompt for next file)
        } else if (y.state === 30) {
            if (b === C_CHAR) {
                await this._sendNullPacket();
                y.state = 4;
            }
        // State 4: After null packet, wait for ACK → done
        } else if (y.state === 4) {
            if (b === ACK) {
                this._finishYmodem();
            }
        }
    }

    async _sendPacket0() {
        // The plugin receiver opens the path from packet 0 directly, so include the full SD destination path here.
        const nameEnc = new TextEncoder().encode(this.ymodem.filePath);
        const sizeEnc = new TextEncoder().encode(this.ymodem.fileSize.toString());
        const packet = new Uint8Array(128);
        packet.fill(0);
        packet.set(nameEnc, 0);
        packet.set(sizeEnc, nameEnc.length + 1);
        await this._sendPacket(0, packet);
    }

    async _sendNextDataPacket() {
        const remaining = this.ymodem.fileSize - this.ymodem.offset;
        const packet = new Uint8Array(1024);
        packet.fill(0x1A);
        const chunk = this.ymodem.fileBytes.subarray(this.ymodem.offset, this.ymodem.offset + Math.min(remaining, 1024));
        packet.set(chunk, 0);
        await this._sendPacket(this.ymodem.packetNum & 0xFF, packet);
    }

    async _sendNullPacket() {
        const packet = new Uint8Array(128);
        packet.fill(0);
        await this._sendPacket(0, packet);
    }

    async _sendPacket(seq, data) {
        const header = new Uint8Array(3);
        header[0] = data.length > 128 ? STX : SOH;
        header[1] = seq & 0xFF;
        header[2] = (~seq) & 0xFF;
        const crc = this._crc16(data);
        const footer = new Uint8Array([(crc >> 8) & 0xFF, crc & 0xFF]);
        const fullPacket = new Uint8Array(3 + data.length + 2);
        fullPacket.set(header, 0);
        fullPacket.set(data, 3);
        fullPacket.set(footer, 3 + data.length);
        await this.ws.writeRaw(fullPacket);
    }

    _crc16(buffer) {
        let crc = 0;
        for (let byte of buffer) {
            crc = crc ^ (byte << 8);
            for (let i = 0; i < 8; i++) {
                if (crc & 0x8000) {
                    crc = (crc << 1) ^ 0x1021;
                } else {
                    crc = crc << 1;
                }
            }
        }
        return crc & 0xFFFF;
    }

    _finishYmodem() {
        this.ymodem.active = false;
        this.ws.setRawHandler(null);
        this.term.writeln('\x1b[32m[YMODEM] Done.\x1b[0m');

        // Delay hiding to let user read 100%, then fade out
        setTimeout(() => {
            const container = document.getElementById('upload-progress-container');
            if (container) {
                container.style.transition = 'opacity 1s ease-out';
                container.style.opacity = '0';

                // Wait for fade out to finish before hiding and resetting
                setTimeout(() => {
                    container.style.display = 'none';
                    container.style.opacity = '1'; // Reset for next time
                    container.style.transition = ''; // Remove transition
                    document.getElementById('upload-progress-bar').style.width = '0%';
                }, 1000);
            }
        }, 1500);

        if (this.callbacks.resumePolling) this.callbacks.resumePolling();

        if (this.ymodem.onComplete) {
            this.ymodem.onComplete(this.ymodem.fileName);
        }

        setTimeout(() => this.refresh(), 1000);
    }

    _abortYmodem(reason) {
        this.ymodem.active = false;
        this.ws.setRawHandler(null);
        this.term.writeln(`\x1b[31m[YMODEM] Error: ${reason}\x1b[0m`);
        document.getElementById('upload-progress-container').style.display = 'none';
        if (this.callbacks.resumePolling) this.callbacks.resumePolling();
    }
}

