// UI State Management Module
// Handles connection state, button states, and UI updates

class UIManager {
    constructor() {
        this.statusInterval = null;
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
            btn.innerHTML = '<i class="bi bi-usb-plug-fill"></i> Disconnect';
            btn.className = "btn btn-secondary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0 !bg-red-500 !text-white hover:!bg-red-600";

            // Update Status Pill
            document.getElementById('connection-dot').classList.replace('bg-red-500', 'bg-green-500');
            document.getElementById('connection-text').textContent = 'Online';

            // Start status polling
            const pollingRate = ws.type === 'websocket' ? 500 : 250;
            this.statusInterval = setInterval(() => ws.sendRealtime('?'), pollingRate);

            setTimeout(() => ws.sendCommand('$EA'), 500);
            setTimeout(() => ws.sendCommand('$EE'), 1000);
            setTimeout(() => sdHandler.refresh(), 1500);
            setTimeout(() => ws.sendCommand('$EG'), 2000);
            setTimeout(() => ws.sendCommand('$ES'), 2500);
            setTimeout(() => ws.sendCommand('$$'), 3000);
            setTimeout(() => ws.sendCommand('$#'), 3500);
            setTimeout(() => ws.sendCommand('$I+'), 4000);
            setTimeout(() => {
                window.userRequestedStatus = true;
                ws.sendRealtime('\x87');
            }, 4500);
        } else {
            if (this.statusInterval) clearInterval(this.statusInterval);
            btn.textContent = 'Connect';
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
        const runControls = '#run-job-btn, #run-sd-btn';
        const macroControls = '#macros-view button, #probe-panel-content button, #probe-panel-content input, #sd-tools button';
        const txtConsole = '#console-input-area input, #console-input';
        const unlockBtn = 'button[title="Unlock ($X)"]';

        if (state === 'offline') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, true);
            setDisabled(unlockBtn, true);
            
            // Completely disable specific outer blocks remaining from previous UI styles
            document.querySelectorAll('#machine-controls, #settings-toolbar, #sd-breadcrumb').forEach(el => {
                el.classList.add('opacity-50', 'pointer-events-none');
            });
        } 
        else if (state === 'alarm') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false); // Keep console alive to query settings out of alarm
            
            setDisabled(unlockBtn, false);
            const btn = document.querySelector(unlockBtn);
            if (btn) {
                btn.classList.remove('btn-secondary');
                btn.classList.add('!bg-red-600', '!text-white', 'animate-pulse', '!border-red-500');
            }
            
            // Clean up general offline locks if they were present
            document.querySelectorAll('#machine-controls, #settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else if (state === 'run' || state === 'jog' || state === 'homing') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false); // Keep console to send realtime intercepts
            
            setDisabled(unlockBtn, true);
            const btn = document.querySelector(unlockBtn);
            if (btn) {
                btn.classList.remove('!bg-red-600', '!text-white', 'animate-pulse', '!border-red-500');
                btn.classList.add('btn-secondary');
            }
            document.querySelectorAll('#machine-controls, #settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else if (state === 'hold' || state === 'door' || state === 'sleep') {
            setDisabled(jogControls, true);
            setDisabled(runControls, true);
            setDisabled(macroControls, true);
            setDisabled(txtConsole, false);
            
            setDisabled(unlockBtn, true);
            const btn = document.querySelector(unlockBtn);
            if (btn) {
                btn.classList.remove('!bg-red-600', '!text-white', 'animate-pulse', '!border-red-500');
                btn.classList.add('btn-secondary');
            }
            document.querySelectorAll('#machine-controls, #settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));
        }
        else { 
            // Idle Space
            setDisabled(jogControls, false);
            setDisabled(macroControls, false);
            setDisabled(txtConsole, false);
            
            setDisabled(unlockBtn, false);
            const btn = document.querySelector(unlockBtn);
            if (btn) {
                btn.classList.remove('!bg-red-600', '!text-white', 'animate-pulse', '!border-red-500');
                btn.classList.add('btn-secondary');
            }
            
            document.querySelectorAll('#machine-controls, #settings-toolbar, #sd-breadcrumb').forEach(el => el.classList.remove('opacity-50', 'pointer-events-none'));

            this.updateRunButtonsState();
        }
    }

    /**
     * Update Run button states based on SD file context
     */
    updateRunButtonsState() {
        const runJobBtn = document.getElementById('run-job-btn');
        const runSdBtn = document.getElementById('run-sd-btn');

        if (window.currentSDFile) {
            if (runJobBtn) {
                runJobBtn.classList.add('opacity-50', 'pointer-events-none');
                runJobBtn.disabled = true;
                runJobBtn.title = "Streaming disabled for SD files. Use 'Run from SD'";
            }
            if (runSdBtn) {
                runSdBtn.classList.remove('opacity-50', 'pointer-events-none');
                runSdBtn.disabled = false;
                runSdBtn.classList.replace('!bg-secondary', '!bg-primary');
                runSdBtn.classList.replace('!text-white', '!text-secondary-dark');
                runSdBtn.innerHTML = `<i class="bi bi-sd-card-fill text-lg"></i> Run from SD`;
            }
        } else {
            if (window.ws && window.ws.isConnected && runJobBtn) {
                runJobBtn.classList.remove('opacity-50', 'pointer-events-none');
                runJobBtn.disabled = false;
                runJobBtn.title = "Run Job (Stream)";
            }
            if (runSdBtn) {
                runSdBtn.classList.replace('!bg-primary', '!bg-secondary');
                runSdBtn.classList.replace('!text-secondary-dark', '!text-white');
                runSdBtn.innerHTML = `<i class="bi bi-sd-card-fill text-lg"></i> Run from SD`;
            }
        }
    }
}

// Export singleton instance
window.uiManager = new UIManager();
