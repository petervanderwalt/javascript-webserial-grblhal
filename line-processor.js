// Line Processor Module
// Handles processing of incoming serial lines and routing to appropriate handlers

class LineProcessor {
    constructor() {
        this._initSteps = null;
        this._initCallback = null;
        this._initFailCallback = null;
        this._initTimeout = null;
        this._initIdx = 0;
    }

    /**
     * Start tracking init command progress.
     * Advances one step per 'ok' response received.
     * Each step gets its own timeout — if it expires, onStepFail fires and tracking stops.
     * @param {Array} steps - Array of {label, icon} steps
     * @param {Function} onProgress - Called for each step (idx, step)
     * @param {Function} onStepFail - Called with (idx, step) if that step times out
     * @param {number} stepTimeoutMs - Timeout per step
     */
    startInitTracking(steps, onProgress, onStepFail, stepTimeoutMs) {
        this._initSteps = steps;
        this._initCallback = onProgress;
        this._initFailCallback = onStepFail;
        this._stepTimeout = stepTimeoutMs || 3000;
        this._initIdx = -1;
        this._scheduleStepTimeout();
    }

    _scheduleStepTimeout() {
        if (this._initTimeout) clearTimeout(this._initTimeout);
        if (!this._initSteps) return;
        var idx = this._initIdx + 1;
        if (idx >= this._initSteps.length) return;
        var step = this._initSteps[idx];
        this._initTimeout = setTimeout(() => {
            if (!this._initSteps) return;
            this._initSteps = null;
            this._initCallback = null;
            if (this._initFailCallback) this._initFailCallback(idx, step);
            this._initFailCallback = null;
        }, this._stepTimeout);
    }

    _advanceInit() {
        if (!this._initSteps || !this._initCallback) return;
        if (this._initTimeout) clearTimeout(this._initTimeout);
        this._initTimeout = null;
        this._initIdx++;
        if (this._initIdx >= this._initSteps.length) {
            this._initSteps = null;
            this._initCallback = null;
            this._initFailCallback = null;
            return;
        }
        var step = this._initSteps[this._initIdx];
        if (this._initCallback) this._initCallback(this._initIdx, step);
        if (this._initIdx >= this._initSteps.length - 1) {
            this._initSteps = null;
            this._initCallback = null;
            this._initFailCallback = null;
        } else {
            this._scheduleStepTimeout();
        }
    }

    cancelInitTracking() {
        if (this._initTimeout) clearTimeout(this._initTimeout);
        this._initTimeout = null;
        this._initSteps = null;
        this._initCallback = null;
        this._initFailCallback = null;
    }

    /**
     * Process a line from serial input
     * @param {string} line - Line to process
     */
    processLine(line) {
        if (!line) return;
        line = line.trim();

        // Advance init tracking on each 'ok' response
        if (this._initSteps && line === 'ok') {
            this._advanceInit();
            // Don't return — let other handlers process the line too
        }

        // Probe result
        if (line.startsWith('[PRB:')) {
            window.term.writeln(line);
            window.probeHandler.handleProbeResult(line);
            return;
        }

        // Options (homing configuration)
        if (line.startsWith('[OPT:')) {
            const optString = line.split(':')[1].split(',')[0];
            if (optString.includes('Z')) {
                console.log("Homing Force Origin (Positive Space) detected");
                if (window.viewer) {
                    window.viewer.isPositiveSpace = true;
                    window.viewer.renderMachineBox();
                    window.viewer.updateGridBounds();
                    window.viewer.renderCoolGrid();
                    window.viewer.setCameraView('Iso');
                }
            } else {
                if (window.viewer) {
                    window.viewer.isPositiveSpace = false;
                    window.viewer.renderMachineBox();
                    window.viewer.updateGridBounds();
                    window.viewer.renderCoolGrid();
                    window.viewer.setCameraView('Iso');
                }
            }
            window.term.writeln(line);
            return;
        }

        // $I+ version/board info (captured by config wizard)
        if (window.configWizard && window.configWizard.handleLine(line)) return;

        // SD card handler
        if (window.sdHandler.processLine(line)) {
            window.term.writeln(line);
            return;
        }

        // Settings handler
        if (window.grblSettings.handleLine(line)) {
            window.term.writeln(line);
            // Debounce the viewer updates so we don't recalculate 3D bounds for every single setting parsed
            if (window.viewer && window.grblSettings.settings['130'] && window.grblSettings.settings['131'] && window.grblSettings.settings['132']) {
                if (window._viewerSettingsUpdateTimeout) clearTimeout(window._viewerSettingsUpdateTimeout);
                window._viewerSettingsUpdateTimeout = setTimeout(() => {
                    window.viewer.setMachineLimits(
                        parseFloat(window.grblSettings.settings['130'].val),
                        parseFloat(window.grblSettings.settings['131'].val),
                        parseFloat(window.grblSettings.settings['132'].val)
                    );

                    if (window.grblSettings.settings['23']) {
                        window.viewer.setHomingDirMask(parseInt(window.grblSettings.settings['23'].val));
                    }

                    window.spoilboardGrid?.syncAutoDimensions?.({ silent: true });

                    // Smoothly animate and frame the work area using Default Reset view instead of Iso
                    window.viewer.resetCamera();
                }, 500);
            }
            return; // We parsed it, skip further handlers
        }

        // Reporter (errors/alarms)
        const report = window.reporter.handleLine(line);
        if (report) {
            if (typeof report === 'string') window.term.writeln(report);
            // Don't return for active alarm/error reports — job controller needs to see them
            if (line.toLowerCase().startsWith('alarm:') || line.toLowerCase().startsWith('error:')) {
                // Fall through to job controller
            } else {
                return;
            }
        }

        // Status reports
        if (line.startsWith('<')) {
            if (window.userRequestedStatus) {
                window.term.writeln(line);
                window.userRequestedStatus = false;
            }

            window.droHandler.parseStatus(line);
            if (window.viewer) {
                window.viewer.updateWCS(window.droHandler.wco);
                if (window.droHandler.wpos) {
                    window.viewer.updateToolPosition(window.droHandler.wpos[0], window.droHandler.wpos[1], window.droHandler.wpos[2]);
                }
                if (window.droHandler.spindleSpeed !== undefined) {
                    window.viewer.setSpindleSpeed(window.droHandler.spindleSpeed);
                }
            }
            return;
        }

        // Job controller (streaming ok/error responses)
        if (window.jobController.processLine(line)) return;

        // Default: write to terminal
        window.term.writeln(line);
    }
}

// Export singleton instance
window.lineProcessor = new LineProcessor();
