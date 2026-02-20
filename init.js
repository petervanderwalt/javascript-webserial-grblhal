// Main Initialization Module
// Coordinates initialization of all modules and sets up event listeners

export function initializeApp(ws, store, viewer, reporter, term) {
    // Make store globally available
    window.store = store;

    // Initialize console
    window.consoleManager.initTerminal();

    // Initialize jogging
    window.joggingController.init();

    // Setup file input listeners
    window.editorIntegration.setupFileInputListeners();

    // Setup console input listeners
    window.consoleManager.setupInputListeners();

    // Setup camera/viewer event listeners
    window.cameraControls.setupEventListeners();

    // Setup window resize handler
    window.addEventListener('resize', () => {
        if (window.fitAddon) window.fitAddon.fit();
        if (window.viewer) window.viewer.resize();
    });

    // Setup tab shown handler
    window.addEventListener('tab-shown', (e) => {
        if (e.detail.id === 'viewer-view') {
            requestAnimationFrame(() => {
                if (window.viewer) {
                    window.viewer.resize();
                    if (window.viewer.controls.target.length() === 0) window.viewer.resetCamera();
                }
            });
        }
        if (e.detail.id === 'settings-view' && ws.isConnected) {
            if (Object.keys(window.grblSettings.settings).length === 0) {
                window.grblSettings.fetchSettings();
            }
        }
        if (e.detail.id === 'tools-view') {
            if (window.toolsHandler) window.toolsHandler.refresh();
        }
    });

    // Setup gcode-loaded event (from surfacing wizard, etc.)
    window.addEventListener('gcode-loaded', (e) => {
        window.currentGCodeContent = e.detail;
        window.currentSDFile = null;
        window.uiManager.updateRunButtonsState();

        if (window.editor) {
            window.editor.setValue(e.detail);
            const lineCount = window.editor.getValue().split('\\n').length;
            document.getElementById('editor-line-count').innerText = lineCount;
            document.getElementById('editor-file-name').innerText = "Surfacing_Job.gcode";
        }
    });

    // Unit syncing
    const unitToggle = document.getElementById('unitToggle');
    unitToggle.addEventListener('change', () => {
        const units = unitToggle.checked ? 'mm' : 'inch';
        if (window.viewer) window.viewer.setUnits(units);
    });

    window.addEventListener('viewer-units-changed', (e) => {
        const isMm = e.detail.units === 'mm';
        if (unitToggle.checked !== isMm) {
            unitToggle.checked = isMm;
            window.store.set('general.units', e.detail.units);
        }
    });

    // Note: connect/disconnect/line handlers are registered in index.html to avoid duplicates
}

// Helper functions exposed globally
window.sendCmd = function (cmd) { window.ws.sendCommand(cmd); };
window.sendRealtime = function (c) { window.ws.sendRealtime(c); };
window.requestFullStatus = function () {
    window.userRequestedStatus = true;
    window.ws.sendRealtime('\x87');
};
window.clearTerminal = function () { if (window.term) window.term.clear(); };
