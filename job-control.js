// Job Control Module
// Handles G-code streaming, job progress, pause/resume/stop

class JobController {
    constructor() {
        this.gcodeStreamer = {
            lines: [],
            index: 0,
            active: false,
            paused: false,
            waitingMTC: false,
            pending: []
        };
        this.jobStartTime = 0;
        this.sdJobActive = false;
        this._elapsedTimer = null;

        this.setupEventListeners();
    }

    _hasActiveJob() {
        return this.gcodeStreamer.active || this.sdJobActive;
    }

    _getFlow() {
        const ws = window.ws;
        if (!ws) return null;
        return ws.type === 'webserial' ? ws.webSerial : ws.flowControl;
    }

    _updateBufferUI() {
        const flow = this._getFlow();
        if (!flow || !flow.sentBuffer) return;
        const bufSize = flow.rxBufSize || 128;
        const used = flow.sentBuffer.reduce((s, l) => s + l.length, 0);
        const pct = bufSize > 1 ? (Math.min(used, bufSize - 1) / (bufSize - 1)) * 100 : 0;
        const bar = document.getElementById('job-buffer-bar');
        if (bar) bar.style.width = `${pct}%`;
    }

    _resetStreamState() {
        this.gcodeStreamer.lines = [];
        this.gcodeStreamer.index = 0;
        this.gcodeStreamer.active = false;
        this.gcodeStreamer.paused = false;
        this.gcodeStreamer.waitingMTC = false;
        this.gcodeStreamer.pending = [];
    }

    _dequeuePending() {
        return this.gcodeStreamer.pending.shift() || null;
    }

    setupEventListeners() {
        // Listen for alarm being cleared (state transition Alarm -> Idle)
        window.addEventListener('machine-alarm-cleared', () => {
            if (this.gcodeStreamer.active) {
                this.abortGCodeStream('Alarm cleared');
            } else {
                this.resetJobUI();
            }
        });

        window.addEventListener('sd-status', (e) => {
            const { pct, filename } = e.detail;

            if (!this.sdJobActive && !this.gcodeStreamer.active) {
                this.sdJobActive = true;
                this.gcodeStreamer.paused = false;
                this.startJobUI();
                window.term.writeln('\x1b[35m[SD Job] Detected active SD print.\x1b[0m');
            }

            if (this.sdJobActive) {
                this.updateJobProgressUI(pct, filename ? `File: ${filename}` : 'Standard Job');
            }
        });

        window.addEventListener('sd-job-complete', () => {
            if (this.sdJobActive) {
                window.term.writeln('\x1b[32m[SD Job] Complete/Idle.\x1b[0m');
                this.resetJobUI();
                const pauseBtn = document.getElementById('pause-job-btn');
                if (pauseBtn && pauseBtn.innerText.includes('Resume')) {
                    pauseBtn.innerHTML = '<i data-lucide="pause" style="width:14px;height:14px"></i> Pause';
                    pauseBtn.className = 'overlay-btn !bg-yellow-100 !text-yellow-800 border-yellow-300 shadow-lg';
                }
            }
        });
    }

    runCurrentJob() {
        if (!window.ws || !window.ws.isConnected) {
            if (window.showToast) window.showToast('Cannot run job - not connected', 'plug-zap', 'error');
            return;
        }
        if (!window.currentGCodeContent || this.gcodeStreamer.active) {
            window.reporter.showAlert('No G-Code', 'No G-Code loaded in the viewer to run!');
            return;
        }

        window.reporter.showConfirm('Run Job', 'Are you sure you want to run the job currently loaded in the 3D viewer?', () => {
            this._resetStreamState();
            this.gcodeStreamer.lines = window.currentGCodeContent
                .split('\n')
                .map((line, idx) => ({
                    command: line.trim(),
                    sourceLine: idx + 1
                }))
                .filter(entry => entry.command.length > 0)
                .map((entry, streamIndex) => ({ ...entry, streamIndex }));
            this.gcodeStreamer.active = true;

            const rj = document.getElementById('run-job-btn');
            rj.classList.add('hidden');
            rj.querySelector('div:last-child')?.classList.add('hidden');
            const jac = document.getElementById('job-active-controls');
            if (jac) {
                jac.classList.remove('hidden');
                jac.classList.add('flex');
            }

            document.getElementById('job-progress-overlay').classList.remove('hidden');
            this.jobStartTime = Date.now();

            window.term.writeln('\x1b[35m[Job Stream] Starting...\x1b[0m');

            if (window.ws.backendWs) {
                window.ws.backendWs.send(JSON.stringify({
                    type: 'updateJob',
                    active: true,
                    currentLine: 0,
                    totalLines: this.gcodeStreamer.lines.length,
                    pct: 0
                }));
            }

            this.advanceGCodeStream();
        });
    }

    pauseJob() {
        if (!this._hasActiveJob()) return;
        const btn = document.getElementById('pause-job-btn');
        if (!btn) return;
        this.gcodeStreamer.paused = !this.gcodeStreamer.paused;

        if (this.gcodeStreamer.paused) {
            window.ws.sendRealtime('!');
            btn.innerHTML = '<i data-lucide="play" style="width:14px;height:14px"></i> Resume';
            btn.classList.replace('!bg-yellow-100', '!bg-green-100');
            btn.classList.replace('!text-yellow-800', '!text-green-800');
            btn.classList.replace('border-yellow-300', 'border-green-300');
            window.term.writeln(this.sdJobActive
                ? '\x1b[33m[SD Job] Paused.\x1b[0m'
                : '\x1b[33m[Job Stream] Paused.\x1b[0m');
        } else {
            window.ws.sendRealtime('~');
            btn.innerHTML = '<i data-lucide="pause" style="width:14px;height:14px"></i> Pause';
            btn.classList.replace('!bg-green-100', '!bg-yellow-100');
            btn.classList.replace('!text-green-800', '!text-yellow-800');
            btn.classList.replace('border-green-300', 'border-yellow-300');
            window.term.writeln(this.sdJobActive
                ? '\x1b[32m[SD Job] Resuming...\x1b[0m'
                : '\x1b[32m[Job Stream] Resuming...\x1b[0m');
        }
    }

    stopJob() {
        if (!this._hasActiveJob()) return;
        window.reporter.showConfirm('Stop Job', 'Stop Job? This will reset the machine.', () => {
            window.ws.sendRealtime('\x18');
            if (this.gcodeStreamer.active) {
                this.abortGCodeStream('User Stopped');
            } else {
                this.sdJobActive = false;
                this.gcodeStreamer.paused = false;
                this.resetJobUI();
                window.term.writeln('\x1b[31m[SD Job] Stopped by user.\x1b[0m');
            }
        });
    }

    advanceGCodeStream() {
        if (!this.gcodeStreamer.active || this.gcodeStreamer.paused) return;

        const flow = this._getFlow();
        if (!flow) {
            console.warn('advanceGCodeStream: flow is undefined - sending without limit!');
        }
        let sentAny = false;

        while (this.gcodeStreamer.index < this.gcodeStreamer.lines.length) {
            const entry = this.gcodeStreamer.lines[this.gcodeStreamer.index];
            const line = entry.command;
            const canSend = flow ? flow.canSend(line) : false;
            if (flow && !canSend) break;

            this.gcodeStreamer.pending.push(entry);
            window.ws.sendCommand(line);
            this.gcodeStreamer.index++;
            sentAny = true;
        }

        if (sentAny) {
            this._updateBufferUI();
            const pct = Math.round((this.gcodeStreamer.index / this.gcodeStreamer.lines.length) * 100);
            const label = `Line ${this.gcodeStreamer.index} of ${this.gcodeStreamer.lines.length}`;
            this.updateJobProgressUI(pct, label);

            if (window.ws.backendWs) {
                window.ws.backendWs.send(JSON.stringify({
                    type: 'updateJob',
                    active: true,
                    currentLine: this.gcodeStreamer.index,
                    totalLines: this.gcodeStreamer.lines.length,
                    pct
                }));
            }
        }
    }

    _checkStreamComplete() {
        if (this.gcodeStreamer.index < this.gcodeStreamer.lines.length) return;
        const flow = this._getFlow();
        if (!flow || flow.isDrained()) {
            this._updateBufferUI();
            this.finishGCodeStream();
        }
    }

    finishGCodeStream() {
        this._resetStreamState();
        window.term.writeln('\x1b[32m[Job Stream] Complete.\x1b[0m');
        this.resetJobUI();

        if (window.ws.backendWs) {
            window.ws.backendWs.send(JSON.stringify({ type: 'updateJob', active: false }));
        }
    }

    abortGCodeStream(error) {
        this._resetStreamState();
        window.term.writeln(`\x1b[31m[Job Stream] Aborted: ${error}\x1b[0m`);
        this.resetJobUI();

        if (window.ws.backendWs) {
            window.ws.backendWs.send(JSON.stringify({ type: 'updateJob', active: false }));
        }
    }

    resetJobUI() {
        document.getElementById('job-progress-overlay').classList.add('hidden');
        document.getElementById('job-progress-bar').style.width = '0%';
        document.getElementById('job-progress-pct').textContent = '0%';
        document.getElementById('job-progress-line').textContent = 'Line 0 of 0';
        document.getElementById('job-progress-time').textContent = 'Elapsed: 0:00';

        document.getElementById('run-job-btn').classList.remove('hidden');
        const jac2 = document.getElementById('job-active-controls');
        if (jac2) {
            jac2.classList.add('hidden');
            jac2.classList.remove('flex');
        }
        const btn = document.getElementById('pause-job-btn');
        if (btn) {
            btn.innerHTML = '<i data-lucide="pause" style="width:14px;height:14px"></i> Pause';
            btn.className = 'overlay-btn !bg-yellow-100 !text-yellow-800 border-yellow-300 shadow-lg';
        }

        const bufBar = document.getElementById('job-buffer-bar');
        if (bufBar) bufBar.style.width = '0%';

        if (this._elapsedTimer) {
            clearInterval(this._elapsedTimer);
            this._elapsedTimer = null;
        }
        this.sdJobActive = false;
    }

    startJobUI() {
        document.getElementById('run-job-btn').classList.add('hidden');
        const jac3 = document.getElementById('job-active-controls');
        if (jac3) {
            jac3.classList.remove('hidden');
            jac3.classList.add('flex');
        }
        document.getElementById('job-progress-overlay').classList.remove('hidden');
        this.jobStartTime = Date.now();
        if (this._elapsedTimer) clearInterval(this._elapsedTimer);
        this._elapsedTimer = setInterval(() => {
            if (!this.gcodeStreamer.active && !this.sdJobActive) return;
            const elapsed = Math.floor((Date.now() - this.jobStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            const el = document.getElementById('job-progress-time');
            if (el) el.textContent = `Elapsed: ${minutes}:${seconds.toString().padStart(2, '0')}`;
        }, 1000);
    }

    updateJobProgressUI(pct, label) {
        document.getElementById('job-progress-bar').style.width = `${pct}%`;
        document.getElementById('job-progress-pct').textContent = `${pct}%`;
        document.getElementById('job-progress-line').textContent = label;

        const elapsed = Math.floor((Date.now() - this.jobStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('job-progress-time').textContent = `Elapsed: ${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    processLine(line) {
        if (!this.gcodeStreamer.active) return false;

        if (line.toLowerCase().startsWith('alarm:')) {
            this._updateBufferUI();
            this._dequeuePending();
            this.abortGCodeStream(line);
            if (window.ws) {
                window.ws.sendRealtime('\x18');
                setTimeout(() => {
                    window.ws.sendCommand('$X');
                }, 3000);
            }
            return true;
        }

        if (line === 'ok') {
            this._updateBufferUI();
            this._dequeuePending();
            this.advanceGCodeStream();
            this._checkStreamComplete();
            return true;
        }

        if (line.toLowerCase().startsWith('error:')) {
            this._updateBufferUI();
            const relatedEntry = this._dequeuePending();
            const isMtcError = line.includes('40') && window.toolsHandler?.mtcActive;
            if (isMtcError) {
                this.gcodeStreamer.waitingMTC = true;
                this.gcodeStreamer.paused = true;
                if (relatedEntry) {
                    this.gcodeStreamer.index = Math.max(0, relatedEntry.streamIndex);
                } else {
                    this.gcodeStreamer.index = Math.max(0, this.gcodeStreamer.index - 1);
                }
                window.term.writeln('\x1b[33m[MTC] Tool change pending - streaming paused, waiting for MTC to complete.\x1b[0m');
            } else {
                this.abortGCodeStream(line);
                if (window.ws) {
                    window.ws.sendRealtime('\x18');
                }
            }
            return true;
        }

        return false;
    }

    resumeMTCStream() {
        if (!this.gcodeStreamer.active || !this.gcodeStreamer.waitingMTC) return;
        this.gcodeStreamer.waitingMTC = false;
        this.gcodeStreamer.paused = false;
        window.term.writeln('\x1b[32m[MTC] Resuming G-code stream.\x1b[0m');
        this.advanceGCodeStream();
    }
}

window.jobController = new JobController();

window.runCurrentJob = () => window.jobController.runCurrentJob();
window.pauseJob = () => window.jobController.pauseJob();
window.stopJob = () => window.jobController.stopJob();
