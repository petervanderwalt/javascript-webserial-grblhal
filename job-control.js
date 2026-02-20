// Job Control Module
// Handles G-code streaming, job progress, pause/resume/stop

class JobController {
    constructor() {
        this.gcodeStreamer = {
            lines: [],
            index: 0,
            active: false,
            paused: false
        };
        this.jobStartTime = 0;
        this.sdJobActive = false;

        this.setupEventListeners();
    }

    setupEventListeners() {
        // SD Job Progress Listeners
        window.addEventListener('sd-status', (e) => {
            const { pct, filename } = e.detail;

            // If SD job just started (or we just noticed it)
            if (!this.sdJobActive && !this.gcodeStreamer.active) {
                this.sdJobActive = true;
                this.startJobUI();
                window.term.writeln("\\x1b[35m[SD Job] Detected active SD print.\\x1b[0m");
            }

            if (this.sdJobActive) {
                this.updateJobProgressUI(pct, filename ? `File: ${filename}` : 'Standard Job');
            }
        });

        window.addEventListener('sd-job-complete', () => {
            if (this.sdJobActive) {
                window.term.writeln("\\x1b[32m[SD Job] Complete/Idle.\\x1b[0m");
                this.resetJobUI();
                // Also ensure we are not in Hold
                const pauseBtn = document.getElementById('pause-job-btn');
                if (pauseBtn.innerText.includes('Resume')) {
                    // Reset pause button visual state if it was paused
                    pauseBtn.innerHTML = '<i class="bi bi-pause-fill text-lg"></i> Pause';
                    pauseBtn.className = "overlay-btn !bg-yellow-100 !text-yellow-800 border-yellow-300 shadow-lg";
                }
            }
        });
    }

    /**
     * Run the current job loaded in the viewer
     */
    runCurrentJob() {
        if (!window.currentGCodeContent || this.gcodeStreamer.active) {
            window.reporter.showAlert('No G-Code', 'No G-Code loaded in the viewer to run!');
            return;
        }
        window.reporter.showConfirm('Run Job', 'Are you sure you want to run the job currently loaded in the 3D viewer?', () => {
            this.gcodeStreamer.lines = window.currentGCodeContent.split('\\n').filter(line => line.trim().length > 0);
            this.gcodeStreamer.index = 0;
            this.gcodeStreamer.active = true;
            this.gcodeStreamer.paused = false;

            document.getElementById('run-job-btn').classList.add('hidden');
            document.getElementById('job-active-controls').classList.remove('hidden');
            document.getElementById('job-active-controls').classList.add('flex');

            // Show job progress overlay
            document.getElementById('job-progress-overlay').classList.remove('hidden');
            this.jobStartTime = Date.now();

            window.term.writeln("\\x1b[35m[Job Stream] Starting...\\x1b[0m");
            this.advanceGCodeStream();
        });
    }

    /**
     * Pause or resume the current job
     */
    pauseJob() {
        if (!this.gcodeStreamer.active) return;
        const btn = document.getElementById('pause-job-btn');
        this.gcodeStreamer.paused = !this.gcodeStreamer.paused;

        if (this.gcodeStreamer.paused) {
            window.ws.sendRealtime('!');
            btn.innerHTML = '<i class="bi bi-play-fill text-lg"></i> Resume';
            btn.classList.replace('!bg-yellow-100', '!bg-green-100');
            btn.classList.replace('!text-yellow-800', '!text-green-800');
            btn.classList.replace('border-yellow-300', 'border-green-300');
            window.term.writeln("\\x1b[33m[Job Stream] Paused.\\x1b[0m");
        } else {
            window.ws.sendRealtime('~');
            btn.innerHTML = '<i class="bi bi-pause-fill text-lg"></i> Pause';
            btn.classList.replace('!bg-green-100', '!bg-yellow-100');
            btn.classList.replace('!text-green-800', '!text-yellow-800');
            btn.classList.replace('border-green-300', 'border-yellow-300');
            window.term.writeln("\\x1b[32m[Job Stream] Resuming...\\x1b[0m");
        }
    }

    /**
     * Stop the current job
     */
    stopJob() {
        if (!this.gcodeStreamer.active) return;
        window.reporter.showConfirm('Stop Job', 'Stop Job? This will reset the machine.', () => {
            window.ws.sendRealtime('\\x18');
            this.abortGCodeStream("User Stopped");
        });
    }

    /**
     * Advance to the next line in the G-code stream
     */
    advanceGCodeStream() {
        if (!this.gcodeStreamer.active) return;
        if (this.gcodeStreamer.index >= this.gcodeStreamer.lines.length) {
            this.finishGCodeStream();
            return;
        }
        const line = this.gcodeStreamer.lines[this.gcodeStreamer.index];
        window.ws.sendCommand(line);
        this.gcodeStreamer.index++;

        // Update job progress
        const pct = Math.round((this.gcodeStreamer.index / this.gcodeStreamer.lines.length) * 100);
        document.getElementById('job-progress-bar').style.width = `${pct}%`;
        document.getElementById('job-progress-pct').textContent = `${pct}%`;
        document.getElementById('job-progress-line').textContent = `Line ${this.gcodeStreamer.index} of ${this.gcodeStreamer.lines.length}`;

        // Update elapsed time
        const elapsed = Math.floor((Date.now() - this.jobStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('job-progress-time').textContent = `Elapsed: ${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Finish the G-code stream
     */
    finishGCodeStream() {
        this.gcodeStreamer.active = false;
        window.term.writeln("\\x1b[32m[Job Stream] Complete.\\x1b[0m");
        this.resetJobUI();
    }

    /**
     * Abort the G-code stream with an error
     */
    abortGCodeStream(error) {
        this.gcodeStreamer.active = false;
        window.term.writeln(`\\x1b[31m[Job Stream] Aborted: ${error}\\x1b[0m`);
        this.resetJobUI();
    }

    /**
     * Reset job UI to initial state
     */
    resetJobUI() {
        // Hide job progress overlay
        document.getElementById('job-progress-overlay').classList.add('hidden');
        document.getElementById('job-progress-bar').style.width = '0%';
        document.getElementById('job-progress-pct').textContent = '0%';
        document.getElementById('job-progress-line').textContent = 'Line 0 of 0';
        document.getElementById('job-progress-time').textContent = 'Elapsed: 0:00';

        // Reset buttons
        document.getElementById('run-job-btn').classList.remove('hidden');
        document.getElementById('job-active-controls').classList.add('hidden');
        document.getElementById('job-active-controls').classList.remove('flex');
        const btn = document.getElementById('pause-job-btn');
        btn.innerHTML = '<i class="bi bi-pause-fill text-lg"></i> Pause';
        btn.className = "overlay-btn !bg-yellow-100 !text-yellow-800 border-yellow-300 shadow-lg";

        this.sdJobActive = false; // Reset SD flag
    }

    /**
     * Start job UI (show progress overlay)
     */
    startJobUI() {
        document.getElementById('run-job-btn').classList.add('hidden');
        document.getElementById('job-active-controls').classList.remove('hidden');
        document.getElementById('job-active-controls').classList.add('flex');
        document.getElementById('job-progress-overlay').classList.remove('hidden');
        this.jobStartTime = Date.now();
    }

    /**
     * Update job progress UI
     */
    updateJobProgressUI(pct, label) {
        document.getElementById('job-progress-bar').style.width = `${pct}%`;
        document.getElementById('job-progress-pct').textContent = `${pct}%`;
        document.getElementById('job-progress-line').textContent = label;

        // Update elapsed time
        const elapsed = Math.floor((Date.now() - this.jobStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('job-progress-time').textContent = `Elapsed: ${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    /**
     * Check if a line should be handled by the job controller
     * @param {string} line - Line from serial
     * @returns {boolean} - True if handled
     */
    processLine(line) {
        if (this.gcodeStreamer.active && (line === 'ok' || line.toLowerCase().startsWith('error:'))) {
            if (line.toLowerCase().startsWith('error:')) this.abortGCodeStream(line);
            else this.advanceGCodeStream();
            return true;
        }
        return false;
    }
}

// Export singleton instance
window.jobController = new JobController();

// Expose global functions for HTML onclick handlers
window.runCurrentJob = () => window.jobController.runCurrentJob();
window.pauseJob = () => window.jobController.pauseJob();
window.stopJob = () => window.jobController.stopJob();
