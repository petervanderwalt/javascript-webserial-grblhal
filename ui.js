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
        const disabledIds = ['machine-controls', 'console-input-area', 'run-job-btn', 'run-sd-btn', 'sd-tools', 'sd-breadcrumb', 'settings-toolbar', 'probe-panel-content'];

        if (state) {
            // Remove disabling classes
            disabledIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.remove('opacity-50', 'pointer-events-none');
            });
            if (resetBtn) resetBtn.classList.remove('opacity-50', 'pointer-events-none');

            // Update Connect Button to Disconnect
            btn.innerHTML = '<i class="bi bi-usb-plug-fill"></i> Disconnect';
            btn.className = "btn btn-secondary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0 !bg-red-500 !text-white hover:!bg-red-600";

            // Update Status Pill
            document.getElementById('connection-dot').classList.replace('bg-red-500', 'bg-green-500');
            document.getElementById('connection-text').textContent = 'Online';

            // Update Run button states in case we just connected with file loaded
            this.updateRunButtonsState();

            // Initialization Sequence - Delay to allow board to fully boot
            setTimeout(() => {
                window.userRequestedStatus = true;
                ws.sendRealtime('\\x87'); // Get extended status including alarm state
                this.statusInterval = setInterval(() => ws.sendRealtime('?'), 100);
            }, 1000);

            // Then send initialization commands (delayed further so board is ready)
            setTimeout(() => ws.sendCommand('$EE'), 2000);  // Error codes first (safe)
            setTimeout(() => ws.sendCommand('$EA'), 2500);  // Alarm codes (safe)
            setTimeout(() => ws.sendCommand('$EG'), 3000);  // Setting groups (safe)
            setTimeout(() => ws.sendCommand('$ES'), 3500);  // Setting enumerations (safe)
            setTimeout(() => ws.sendCommand('$$'), 4000);  // Settings (safe)
            setTimeout(() => ws.sendCommand('$#'), 4500);  // Parameters (safe)
            setTimeout(() => ws.sendCommand('$I+'), 5000);  // Build info (safe)
            setTimeout(() => sdHandler.refresh(), 5500);  // SD card (may fail in alarm)
        } else {
            if (this.statusInterval) clearInterval(this.statusInterval);
            btn.textContent = 'Connect';
            btn.className = "btn btn-primary flex-1 h-9 text-xs shadow-none border border-white/10 px-2 py-0";

            document.getElementById('connection-dot').classList.replace('bg-green-500', 'bg-red-500');
            document.getElementById('connection-text').textContent = 'Offline';

            if (resetBtn) resetBtn.classList.add('opacity-50', 'pointer-events-none');

            document.getElementById('dro-alarm-btn')?.classList.add('hidden');

            disabledIds.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.classList.add('opacity-50', 'pointer-events-none');
            });
        }
    }

    /**
     * Update Run button states based on SD file context
     */
    updateRunButtonsState() {
        const runJobBtn = document.getElementById('run-job-btn');
        const runSdBtn = document.getElementById('run-sd-btn');

        if (window.currentSDFile) {
            // SD Context: Disable Streaming, Highlight SD Run
            runJobBtn.classList.add('opacity-50', 'pointer-events-none');
            runJobBtn.title = "Streaming disabled for SD files. Use 'Run from SD'";

            // Highlight SD Button
            runSdBtn.classList.remove('opacity-50', 'pointer-events-none');
            runSdBtn.classList.replace('!bg-secondary', '!bg-primary');
            runSdBtn.classList.replace('!text-white', '!text-secondary-dark');
            runSdBtn.innerHTML = `<i class="bi bi-sd-card-fill text-lg"></i> Run from SD`;

        } else {
            // Local Context: Enable Streaming, Reset SD Run
            if (window.ws && window.ws.isConnected) runJobBtn.classList.remove('opacity-50', 'pointer-events-none');
            runJobBtn.title = "Run Job (Stream)";

            // Reset SD Button to default (Upload & Run)
            runSdBtn.classList.replace('!bg-primary', '!bg-secondary');
            runSdBtn.classList.replace('!text-secondary-dark', '!text-white');
            runSdBtn.innerHTML = `<i class="bi bi-sd-card-fill text-lg"></i> Run from SD`;
        }
    }
}

// Export singleton instance
window.uiManager = new UIManager();
