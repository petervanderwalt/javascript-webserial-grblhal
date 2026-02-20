// Editor Integration Module
// Handles editor-related functions and SD card integration

class EditorIntegration {
    /**
     * Apply changes from editor to viewer
     */
    applyEditorChanges() {
        if (!window.editor) return;
        const content = window.editor.getValue();
        window.currentGCodeContent = content;

        window.viewer.processGCodeString(content);
        window.switchTab('viewer-view');
        window.term.writeln("\x1b[32m[Editor] Job updated from editor.\x1b[0m");
    }

    /**
     * Download editor content as file
     */
    downloadFromEditor() {
        if (!window.editor) return;
        const content = window.editor.getValue();
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = document.getElementById('editor-file-name').innerText || 'edited_job.gcode';
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Upload editor content to SD card
     */
    uploadEditorToSD() {
        if (!window.editor) return;
        const content = window.editor.getValue();
        const defaultName = document.getElementById('editor-file-name').innerText !== "No file loaded"
            ? document.getElementById('editor-file-name').innerText
            : "edited.gcode";

        window.reporter.showPrompt('Upload to SD Card', 'Enter filename for SD Card:', defaultName, (filename) => {
            if (!filename) return;

            const file = new File([content], filename, { type: "text/plain" });
            window.switchTab('sd-view');
            window.sdHandler.startUpload(file);
        });
    }

    /**
     * Run from SD card (smart function - context aware)
     */
    runFromSD() {
        // Case 1: File is already on SD (Context Aware)
        if (window.currentSDFile) {
            window.reporter.showConfirm('Run from SD', `Run ${window.currentSDFile} directly from SD card?`, () => {
                // Start SD Print
                window.ws.sendCommand(`$F=${window.currentSDFile}`);
                // UI will update via status reports
            });
            return;
        }

        // Case 2: Upload Editor Content then Run
        if (!window.editor) return;
        const content = window.editor.getValue();
        const defaultName = document.getElementById('editor-file-name').innerText !== "No file loaded"
            ? document.getElementById('editor-file-name').innerText
            : "job.gcode";

        window.reporter.showPrompt('Upload & Run', 'Upload this job to SD card and run it?', defaultName, (filename) => {
            if (!filename) return;
            const file = new File([content], filename, { type: "text/plain" });

            // Switch to SD view to show progress
            window.switchTab('sd-view');

            // Start Upload with Callback
            window.sdHandler.startUpload(file, (uploadedName) => {
                // On Success, Ask to Run
                const fullPath = window.sdHandler.path === '/' ? uploadedName : `${window.sdHandler.path}/${uploadedName}`;
                setTimeout(() => {
                    window.reporter.showConfirm('Run Now?', `Upload complete. Run ${uploadedName} now?`, () => {
                        window.ws.sendCommand(`$F=${fullPath}`);
                    });
                }, 500);
            });
        });
    }

    /**
     * Setup file input listeners
     */
    setupFileInputListeners() {
        // G-code file input
        document.getElementById('gcode-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            document.getElementById('editor-file-name').innerText = file.name;

            const reader = new FileReader();
            reader.onload = (evt) => {
                const content = evt.target.result;
                window.currentGCodeContent = content;
                window.currentSDFile = null; // Clear SD context for local files
                window.uiManager.updateRunButtonsState();

                window.viewer.processGCodeString(window.currentGCodeContent);

                // Update Editor
                if (window.editor) {
                    window.editor.setValue(content);
                    const lineCount = window.editor.getValue().split('\\n').length;
                    document.getElementById('editor-line-count').innerText = lineCount;
                }

                e.target.value = '';
            };
            reader.readAsText(file);
        });

        // SD upload input
        document.getElementById('sd-upload-input').addEventListener('change', (e) => {
            window.sdHandler.startUpload(e.target.files[0]);
            e.target.value = '';
        });
    }
}

// Export singleton instance
window.editorIntegration = new EditorIntegration();

// Expose global functions for HTML onclick handlers
window.applyEditorChanges = () => window.editorIntegration.applyEditorChanges();
window.downloadFromEditor = () => window.editorIntegration.downloadFromEditor();
window.uploadEditorToSD = () => window.editorIntegration.uploadEditorToSD();
window.runFromSD = () => window.editorIntegration.runFromSD();
