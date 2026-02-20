// Line Processor Module
// Handles processing of incoming serial lines and routing to appropriate handlers

class LineProcessor {
    /**
     * Process a line from serial input
     * @param {string} line - Line to process
     */
    processLine(line) {
        if (!line) return;
        line = line.trim();

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
                }
            } else {
                if (window.viewer) {
                    window.viewer.isPositiveSpace = false;
                    window.viewer.renderMachineBox();
                    window.viewer.updateGridBounds();
                    window.viewer.renderCoolGrid();
                }
            }
            window.term.writeln(line);
            return;
        }

        // SD card handler
        if (window.sdHandler.processLine(line)) return;

        // Settings handler
        if (window.grblSettings.handleLine(line)) {
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

                    window.viewer.resetCamera();
                }, 500);
            }
            return; // We parsed it, skip further handlers
        }

        // Reporter (errors/alarms)
        const report = window.reporter.handleLine(line);
        if (report) {
            if (typeof report === 'string') window.term.writeln(report);
            return;
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
