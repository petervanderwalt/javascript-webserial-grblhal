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
        
        // Listen for machine becoming idle so we can safely refresh if it was deferred (e.g., due to an Alarm on connect)
        window.addEventListener('machine-idle', () => {
            if (this.refreshPending) {
                this.refreshPending = false;
                console.log("SD Refresh: Machine is now Idle. Running deferred SD scan...");
                this.refresh();
            }
        });
    }

    /**
     * Main handler for incoming serial lines.
     * Returns true if the line was consumed by SD logic.
     */
    processLine(line) {
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
            this._addSdFile(line);
            return true;
        }
        if (line.startsWith('[DIR:')) {
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

        // Clean Body
        document.querySelector('#sd-table tbody').innerHTML = '';

        const table = document.getElementById('sd-table');
        // FORCE table to fit screen: Remove min-width and add table-fixed
        table.classList.remove('min-w-[500px]');
        table.classList.add('w-full', 'table-fixed');

        // Configure Headers for Fixed Layout
        const headers = document.querySelectorAll('#sd-table thead th');
        if (headers.length >= 3) {
            // Header 0 (Filename): Auto width
            headers[0].className = 'px-4 py-3 font-bold text-left w-auto';
            // Header 1 (Size): Hidden on mobile
            headers[1].className = 'hidden md:table-cell px-6 py-4 font-bold w-32';
            // Header 2 (Actions): Fixed width on mobile (120px) to ensure buttons fit
            headers[2].className = 'px-2 py-3 font-bold text-right w-[120px] md:w-auto';
        }

        document.getElementById('sd-current-path').textContent = this.path;
        this.fileCount = 0;
        this.files = {}; // Clear cache
        document.getElementById('sd-badge').classList.add('hidden');

        // Try HTTP first if available
        if (this.ws.httpBaseUrl) {
            try {
                let p = this.path;
                if (!p.startsWith('/')) p = '/' + p;
                const url = `${this.ws.httpBaseUrl}/sdfiles?path=${encodeURIComponent(p)}&action=list`;
                const response = await fetch(url);
                if (response.ok) {
                    const data = await response.json();
                    if (data.status === 'ok' && data.files) {
                        // Sort: Directories first, then alphabetical
                        data.files.sort((a, b) => {
                            if (a.size === -1 && b.size !== -1) return -1;
                            if (a.size !== -1 && b.size === -1) return 1;
                            return a.name.localeCompare(b.name);
                        });

                        data.files.forEach(f => {
                            if (f.size === -1) {
                                this._addSdDir(`[DIR:${f.name}]`);
                            } else {
                                this._addSdFile(`[FILE:${f.name}|SIZE:${f.size}]`);
                            }
                        });
                        return; // Successfully listed via HTTP
                    }
                }
            } catch (e) {
                console.warn("HTTP SD listing failed, falling back to serial:", e);
            }
        }

        this.ws.sendCommand('$F+');
    }

    upLevel() {
        if (this.path === "/") return;
        const p = this.path.split('/');
        p.pop();
        this.path = p.join('/') || "/";
        this.refresh();
    }

    enterDir(dirName) {
        this.path = this.path === "/" ? `/${dirName}` : `${this.path}/${dirName}`;
        this.refresh();
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
            reporter.showConfirm('Delete File', `Are you sure you want to delete ${fileName} from the SD card?`, processDelete);
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
                reporter.showConfirm('Download File', `Load ${fileName} for preview and simulation?`, processPreview);
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
                `Do you want to load ${fileName} into the 3D Viewer before running?`,
                () => { // Yes: Load
                    this.pendingRunFile = fileName;
                    this.preview(fileName, true);
                },
                () => { // No: Ask to run directly
                    reporter.showConfirm(
                        'Run Directly?',
                        `Run ${fileName} directly from SD card without preview?`,
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
        const fullPath = content[0];
        const name = fullPath.split('/').pop();

        // Parse Size
        const sizePart = content.find(p => p.startsWith('SIZE:'));
        let sizeDisplay = '-';
        let bytes = 0;

        if (sizePart) {
            bytes = parseInt(sizePart.split(':')[1]);
            sizeDisplay = this._formatBytes(bytes);
            this.files[name] = bytes; // Store for progress calculation
        }

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
            <button class="btn-ghost p-1.5 md:px-3 md:w-36 flex items-center justify-center md:justify-end gap-2 text-grey-dark hover:text-black" onclick="window.sdHandler.runMacro('${pNum}')" title="Run macro">
                <i class="bi bi-gear-wide-connected text-lg md:text-base"></i>
                <span class="hidden md:inline">Run macro</span>
            </button>`;
        } else {
            runActionBtn = `
            <button class="btn-ghost p-1.5 md:px-3 md:w-36 flex items-center justify-center md:justify-end gap-2 text-green-600 hover:text-green-800" onclick="window.sdHandler.runFile('${name}')" title="Run">
                <i class="bi bi-play-fill text-xl md:text-base"></i>
                <span class="hidden md:inline">Run File</span>
            </button>`;
        }

        // Generate Safe ID for progress selection (base64 encoded to handle special chars)
        const safeId = btoa(name).replace(/=/g, '');

        const row = `
          <tr class="hover:bg-grey-light border-b border-grey-light last:border-b-0 transition-colors group" data-filename="${name}">
              <td class="px-4 py-2 md:px-6 md:py-3 font-medium text-grey-dark align-middle truncate overflow-hidden">
                  <div class="flex flex-col justify-center w-full">
                      <div class="flex items-center gap-2 truncate">
                          <i class="bi bi-file-earmark-code text-grey shrink-0"></i>
                          <span class="truncate" title="${name}">${name}</span>
                      </div>

                      <!-- Progress Bar (Hidden by default) -->
                      <div id="sd-prog-${safeId}" class="hidden w-full max-w-[200px] mt-1.5 ml-6 md:ml-0 bg-grey-light rounded-full h-1">
                        <div class="bg-primary h-1 rounded-full transition-all duration-200" style="width: 0%"></div>
                      </div>

                      <span class="text-[10px] text-grey opacity-80 font-mono mt-0.5 md:hidden ml-6">${sizeDisplay}</span>
                  </div>
              </td>

              <td class="hidden md:table-cell px-6 py-3 text-grey font-mono text-xs whitespace-nowrap w-32">${sizeDisplay}</td>

              <td class="px-1 md:px-6 py-2 md:py-3 text-right align-middle w-[120px] md:w-auto">
                  <div class="flex justify-end gap-0 md:gap-2">
                      <button class="btn-ghost p-1.5 md:w-24 flex items-center justify-center md:justify-end gap-2 text-grey-dark hover:text-red-600" onclick="window.sdHandler.delete('${name}')" title="Delete">
                        <i class="bi bi-trash text-lg md:text-base"></i>
                        <span class="hidden md:inline">Delete</span>
                      </button>

                      <button class="btn-ghost p-1.5 md:w-24 flex items-center justify-center md:justify-end gap-2 text-grey-dark" onclick="window.sdHandler.preview('${name}')" title="Preview">
                        <i class="bi bi-eye text-lg md:text-base"></i>
                        <span class="hidden md:inline">Preview</span>
                      </button>

                      ${runActionBtn}
                  </div>
              </td>
          </tr>`;

        document.querySelector('#sd-table tbody').insertAdjacentHTML('beforeend', row);
    }

    _toggleProgressUI(fileName, show) {
        const safeId = btoa(fileName).replace(/=/g, '');
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

        const safeId = btoa(this.downloadingFile).replace(/=/g, '');
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
        const content = line.replace('[DIR:', '').replace(']', '');
        const name = content.split('/').pop();
        const tbody = document.querySelector('#sd-table tbody');

        const row = document.createElement('tr');
        row.className = "hover:bg-grey-light border-b border-grey-light cursor-pointer transition-colors group";
        row.onclick = (e) => {
            if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'I' && e.target.tagName !== 'SPAN') {
                this.enterDir(name);
            }
        };

        row.innerHTML = `
          <td class="px-4 py-3 md:px-6 md:py-3 font-bold text-grey-dark align-middle truncate overflow-hidden">
              <div class="flex items-center gap-2 truncate">
                  <i class="bi bi-folder-fill text-primary opacity-70 shrink-0"></i>
                  <span class="truncate" title="${name}">${name}</span>
              </div>
          </td>

          <td class="hidden md:table-cell px-6 py-3 text-grey text-xs w-32">-</td>

          <td class="px-2 md:px-6 py-3 text-right align-middle w-[120px] md:w-auto">
              <div class="flex justify-end">
                  <button class="btn btn-secondary text-xs py-1 px-3" onclick="window.sdHandler.enterDir('${name}')">Open</button>
              </div>
          </td>`;

        tbody.insertBefore(row, tbody.firstChild);
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
            this.viewer.processGCodeString(cleanContent);
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

    async startUpload(file, onComplete = null) {
        if (!file) return;
        const name = file.name.replace(/\s/g, '_');
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);

        const processUpload = async () => {
            const fp = this.path === '/' ? name : `${this.path}/${name}`;

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

            this.term.writeln('\x1b[35m[YMODEM] Initializing Transfer...\x1b[0m');

            // Use sendCommand for the initial setup to ensure flow control is respected
            await this.ws.sendCommand(`$FY=${fp}`);
            console.log("Sent $FY command, waiting for controller to signal start (C character)...");
        };

        if (reporter) {
            reporter.showConfirm('SD Upload', `Upload ${name} (${this._formatBytes(file.size)}) to SD card?`, processUpload);
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
        if (y.state === 1) {
            console.log(`[YMODEM] State 1: Waiting for C_CHAR. Received byte: ${b}`);
            if (b === C_CHAR) {
                console.log("[YMODEM] Received C_CHAR, sending packet 0");
                await this._sendPacket0();
                y.state = 2;
                console.log("[YMODEM] State transition: 1 -> 2");
            }
        } else if (y.state === 2) {
            console.log(`[YMODEM] State 2: Waiting for second C_CHAR. Received byte: ${b}`);
            if (b === C_CHAR) {
                console.log("[YMODEM] Received second C_CHAR, sending first data packet");
                y.packetNum = 1;
                await this._sendNextDataPacket();
                y.state = 3;
                console.log("[YMODEM] State transition: 2 -> 3");
            }
        } else if (y.state === 3) {
            console.log(`[YMODEM] State 3: Data transfer. Received byte: ${b}`);
            if (b === ACK) {
                console.log(`[YMODEM] Received ACK for packet ${y.packetNum}. Offset: ${y.offset}`);
                y.offset += 1024;
                const pct = Math.min(100, Math.round((y.offset / y.fileSize) * 100));
                document.getElementById('upload-progress-bar').style.width = `${pct}%`;
                document.getElementById('upload-pct').textContent = `${pct}%`;

                if (y.offset < y.fileSize) {
                    y.packetNum++;
                    await this._sendNextDataPacket();
                } else {
                    await this.ws.writeRaw(new Uint8Array([EOT]));
                    y.state = 4;
                }
            } else if (b === NAK) {
                await this._sendNextDataPacket();
            } else if (b === CAN) {
                this._abortYmodem('Cancelled');
            }
        } else if (y.state === 4) {
            if (b === NAK) {
                await this.ws.writeRaw(new Uint8Array([EOT]));
            } else if (b === ACK) {
                y.state = 5;
            }
        } else if (y.state === 5) {
            if (b === C_CHAR) {
                await this._sendNullPacket();
                y.state = 6;
            }
        } else if (y.state === 6) {
            if (b === ACK) {
                this._finishYmodem();
            }
        }
    }

    async _sendPacket0() {
        const nameEnc = new TextEncoder().encode(this.ymodem.fileName);
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