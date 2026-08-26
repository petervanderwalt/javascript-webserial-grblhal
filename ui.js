// UI State Management Module
// Handles connection state, button states, and UI updates

class UIManager {
    constructor() {
        this.statusInterval = null;
        this.unlockInProgress = false;
    }

    getUnlockButton() {
        return document.querySelector('button[title="Unlock ($X)"]');
    }

    setUnlockPending() {
        this.unlockInProgress = true;
        const btn = this.getUnlockButton();
        if (btn) {
            btn.disabled = true;
            btn.classList.add('opacity-50', 'pointer-events-none');
        }
        this.renderUnlockButton('unlocking');
    }

    clearUnlockPending() {
        this.unlockInProgress = false;
    }

    renderUnlockButton(mode) {
        const btn = this.getUnlockButton();
        if (!btn) return;

        btn.classList.remove(
            'btn-secondary',
            '!bg-red-600',
            '!text-white',
            'animate-pulse',
            '!border-red-500',
            'shockwave',
            '!bg-amber-900/20',
            '!text-amber-400/30',
            '!text-amber-400',
            '!border-amber-700/20',
            '!border-amber-700/30',
            '!opacity-100'
        );

        if (mode === 'alarm') {
            btn.innerHTML = '<i data-lucide="unlock" style="width:12px;height:12px"></i> Unlock';
            btn.classList.add('!bg-red-600', '!text-white', 'shockwave', '!border-red-500');
        } else if (mode === 'unlocking') {
            btn.innerHTML = '<i data-lucide="loader-circle" style="width:12px;height:12px"></i> Unlocking...';
            btn.classList.add('!bg-amber-900/20', '!text-amber-400', '!border-amber-700/30', '!opacity-100');
        } else {
            btn.innerHTML = '<i data-lucide="unlock" style="width:12px;height:12px"></i> Unlock';
            btn.classList.add('!bg-amber-900/20', '!text-amber-400/30', '!border-amber-700/20', '!opacity-100');
        }

        if (window.lucide) window.lucide.createIcons();
    }

    /**
     * Update UI based on connection state
     * @param {boolean} state - Connected state
     * @param {Object} ws - WebSerial instance
     * @param {Object} sdHandler - SD card handler
     */
    updateConnectionState(state, ws, sdHandler) {
        const btn = document.getElementById('btn-connect');
        const resetBtn = document.getElementById('btn-reset');

        if (state) {
            if (resetBtn) {
                resetBtn.classList.remove('opacity-50', 'pointer-events-none');
                resetBtn.disabled = false;
            }

            // Update Connect Button to Disconnect
            btn.innerHTML = '<i data-lucide="plug"></i> Disconnect';
            btn.className = "btn btn-secondary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0 !bg-red-500 !text-white hover:!bg-red-600";
            if (window.lucide) window.lucide.createIcons();

            // Update Status Pill
            document.getElementById('connection-dot').classList.replace('bg-red-500', 'bg-green-500');
            document.getElementById('connection-text').textContent = 'Online';

            // Start status polling
            const pollingRate = ws.type === 'websocket' ? 500 : 250;
            this.statusInterval = setInterval(() => ws.sendRealtime('?'), pollingRate);

            // Init progress tracking — advances on each 'ok' response
            var initSteps = [
                { label: 'Alarm Code Definitions Loaded', icon: 'alert-triangle' },
                { label: 'Error Code Definitions Loaded', icon: 'x-circle' },
                { label: 'Setting Groups Loaded', icon: 'folder-tree' },
                { label: 'Settings Info Loaded', icon: 'list' },
                { label: 'Grbl Settings Loaded', icon: 'settings' },
                { label: 'Parameters Loaded', icon: 'sliders' },
                { label: 'Firmware Build Info Loaded', icon: 'info' },
                { label: 'CNC Connected', icon: 'plug' }
            ];
            window.lineProcessor.startInitTracking(initSteps, function(idx, step) {
                if (window.showToast) window.showToast(step.label, step.icon, 'success');
            }, function(idx, step) {
                if (window.showToast) window.showToast('Failed: ' + step.label, 'plug-zap', 'error');
                if (window.ws && window.ws.disconnect) window.ws.disconnect();
            }, 5000);

            setTimeout(() => ws.sendCommand('$EA'), 500);
            setTimeout(() => ws.sendCommand('$EE'), 1000);
            setTimeout(() => sdHandler.probeAvailabilityOnBoot(), 1500);
            setTimeout(() => ws.sendCommand('$EG'), 2000);
            setTimeout(() => ws.sendCommand('$ES'), 2500);
            setTimeout(() => ws.sendCommand('$$'), 3000);
            setTimeout(() => ws.sendCommand('$#'), 3500);
            setTimeout(() => ws.sendCommand('$I+'), 4000);
            setTimeout(() => {
                if (window.troubleshooting?.primeStartupDiscovery) {
                    window.troubleshooting.primeStartupDiscovery();
                }
            }, 4250);
            setTimeout(() => {
                window.userRequestedStatus = true;
                ws.sendRealtime('\x87');
            }, 4500);
        } else {
            if (this.statusInterval) clearInterval(this.statusInterval);
            if (window.lineProcessor) window.lineProcessor.cancelInitTracking();
            btn.innerHTML = 'Connect';
            btn.className = "btn btn-primary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0";

            document.getElementById('connection-dot').classList.replace('bg-green-500', 'bg-red-500');
            document.getElementById('connection-text').textContent = 'Offline';

            if (resetBtn) {
                resetBtn.classList.add('opacity-50', 'pointer-events-none');
                resetBtn.disabled = true;
            }

            this.applyStateLock('offline');
        }
    }


    /**
     * Apply button state locks based on Grbl machine state
     * @param {string} state - Grbl state (Idle, Alarm, Run, Hold, etc) or 'offline'
     */
    applyStateLock(state) {
        state = (state || 'offline').toLowerCase().split(':')[0];

        if (state !== 'alarm' && this.unlockInProgress) {
            this.clearUnlockPending();
        }

        const setDisabled = (selector, isDisabled) => {
            document.querySelectorAll(selector).forEach(el => {
                if (!el) return;
                el.disabled = isDisabled;
                if (isDisabled) {
                    el.classList.add('opacity-50', 'pointer-events-none');
                } else {
                    el.classList.remove('opacity-50', 'pointer-events-none');
                }
            });
        };

        // UI Control Selectors
        const jogControls = '.jog-btn, .jog-btn-extra, .dro-zero-btn, .dro-sub-btn, #stepSize, #jogContinuous';
        const runControls = '#run-job-btn';
        const macroControls = '#macros-view button, #probe-panel-content, #probe-panel-content button, #probe-panel-content input';
        const txtConsole = '#console-input-area, #cmdInput, #btnSend';
        const unlockBtn = 'button[title="Unlock ($X)"]';
        const ensureSdTabEnabled = () => {
            const sdTabBtn = document.getElementById('sd-tab-btn');
            if (!sdTabBtn) return;
            sdTabBtn.disabled = false;
            sdTabBtn.classList.remove('opacity-50', 'pointer-events-none');
        };
        const syncJogModeState = () => {
            if (window.joggingController?.syncModeState) window.joggingController.syncModeState();
        };

        if (state === 'offline') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, true);
            setDisabled(unlockBtn, true);
            this.renderUnlockButton('default');

            // Completely disable specific outer blocks remaining from previous UI styles
            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => {
                el.classList.add('opacity-50', 'pointer-events-none');
            });
        }
        else if (state === 'alarm') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false); // Keep console alive to query settings out of alarm

            // Keep HOME button enabled during alarm (needed for homing-lock recovery)
            setDisabled('#home-all-btn', false);
            document.querySelectorAll('.dro-home-btn').forEach(el => {
                el.disabled = false;
                el.classList.remove('opacity-50', 'pointer-events-none');
            });

            if (this.unlockInProgress) {
                setDisabled(unlockBtn, true);
                this.renderUnlockButton('unlocking');
            } else {
                setDisabled(unlockBtn, false);
                this.renderUnlockButton('alarm');
            }

            // Clean up general offline locks if they were present
            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else if (state === 'run' || state === 'jog' || state === 'homing') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false); // Keep console to send realtime intercepts

            setDisabled(unlockBtn, true);
            this.renderUnlockButton('default');
            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else if (state === 'hold' || state === 'door' || state === 'sleep') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false);

            setDisabled(unlockBtn, true);
            this.renderUnlockButton('default');
            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else {
            // Idle Space
            setDisabled(jogControls, false);
            setDisabled(macroControls, false);
            setDisabled(txtConsole, false);

            setDisabled(unlockBtn, true);
            this.renderUnlockButton('default');

            document.querySelectorAll('#settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));

            this.updateRunButtonsState();
        }

        ensureSdTabEnabled();
        syncJogModeState();
    }

    /**
     * Update Run button states based on SD file context
     */
    updateRunButtonsState() {
        const runJobContainer = document.getElementById('run-job-btn');
        const runJobBtn = runJobContainer?.querySelector('button');

        if (window.currentSDFile) {
            if (runJobContainer) {
                runJobContainer.classList.add('opacity-50', 'pointer-events-none');
                runJobContainer.title = "Streaming disabled for SD files. Use SD option in dropdown";
            }
            if (runJobBtn) runJobBtn.disabled = true;
        } else {
            if (window.ws && window.ws.isConnected && runJobContainer) {
                runJobContainer.classList.remove('opacity-50', 'pointer-events-none');
                runJobContainer.title = "Run Job (Stream)";
            }
            if (runJobBtn) runJobBtn.disabled = false;
        }
    }
}

// Export singleton instance
window.uiManager = new UIManager();
