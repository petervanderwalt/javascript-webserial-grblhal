(function () {
    'use strict';

    class UI {
        constructor() {
            // --- UI Element References ---
            this.fileInput = document.getElementById('file-input');
            this.viewerContainer = document.getElementById('viewer-container');
            this.loadingOverlay = document.getElementById('loading-overlay');
            this.loadingText = document.getElementById('loading-text');
            this.statusPanel = document.getElementById('status-panel');
            this.addToolpathBtn = document.getElementById('add-toolpath-btn');
            this.toolpathList = document.getElementById('toolpath-list');
            this.toolpathEditor = document.getElementById('toolpath-editor');
            this.generatePreviewBtn = document.getElementById('generate-preview-btn');
            this.generateGcodeBtn = document.getElementById('generate-gcode-btn');
            this.gcodeOutput = document.getElementById('gcode-output');
        }

        // --- Loading and Status ---

        showLoading(message) {
            this.loadingText.textContent = message;
            this.loadingOverlay.classList.remove('hidden');
        }

        hideLoading() {
            this.loadingOverlay.classList.add('hidden');
        }

        updateStatus(message) {
            this.statusPanel.innerHTML = `<p>${message}</p>`;
        }

        // --- Toolpath List and Editor ---

        renderToolpathList(toolpaths, activeIndex) {
            if (toolpaths.length > 0) {
                this.generatePreviewBtn.disabled = false;
            } else {
                this.generatePreviewBtn.disabled = true;
                this.generateGcodeBtn.disabled = true;
                this.hideToolpathEditor();
            }

            this.toolpathList.innerHTML = toolpaths.map((tp, index) => `
                <div id="tp-item-${index}"
                     class="toolpath-item p-2 rounded-md cursor-pointer hover:bg-grey-background ${index === activeIndex ? 'bg-primary-light' : ''}"
                     onclick="window.setActiveToolpath(${index})">
                    <p class="font-bold text-sm">${tp.name}</p>
                    <p class="text-xs text-grey">${tp.geometries.length} geometries assigned</p>
                </div>
            `).join('');
        }

        renderToolpathEditor(toolpath, onUpdate, onAddGeometries) {
            if (!toolpath) {
                this.hideToolpathEditor();
                return;
            }

            const operations = [
                "CNC: Vector (path outside)",
                "CNC: Vector (path inside)",
                "CNC: Pocket"
            ];

            this.toolpathEditor.innerHTML = `
                <div>
                    <label class="input-label">Operation</label>
                    <select id="camOperation" class="input-field">
                        ${operations.map(op => `<option ${toolpath.camOperation === op ? 'selected' : ''}>${op}</option>`).join('')}
                    </select>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div><label class="input-label">Tool Dia (mm)</label><input id="camToolDia" type="number" class="input-field" value="${toolpath.camToolDia}"></div>
                    <div><label class="input-label">Feed Rate</label><input id="camFeedrate" type="number" class="input-field" value="${toolpath.camFeedrate}"></div>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div><label class="input-label">Plunge Rate</label><input id="camPlungerate" type="number" class="input-field" value="${toolpath.camPlungerate}"></div>
                    <div><label class="input-label">Z-Step (mm)</label><input id="camZStep" type="number" class="input-field" value="${toolpath.camZStep}"></div>
                </div>
                <div>
                    <label class="input-label">Final Z-Depth (mm)</label>
                    <input id="camZDepth" type="number" class="input-field" value="${toolpath.camZDepth}">
                </div>
                <button id="add-geo-btn" class="btn btn-secondary w-full mt-2"><i class="bi bi-plus-square-dotted"></i> Add Selected Geometry</button>
            `;
            this.toolpathEditor.classList.remove('hidden');

            // Wire up event listeners
            document.getElementById('add-geo-btn').onclick = onAddGeometries;

            this.toolpathEditor.querySelectorAll('input, select').forEach(el => {
                el.onchange = (e) => {
                    const value = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
                    onUpdate(e.target.id, value);
                };
            });
        }

        hideToolpathEditor() {
            this.toolpathEditor.innerHTML = '';
            this.toolpathEditor.classList.add('hidden');
        }

        // --- G-Code Output ---

        updateGcodeButtons(enabled) {
            this.generateGcodeBtn.disabled = !enabled;
        }

        displayGcode(gcode) {
            this.gcodeOutput.value = gcode;
            this.gcodeOutput.classList.remove('hidden');
        }
    }

    // Attach the class to the global window object
    window.UI = UI;

})();
