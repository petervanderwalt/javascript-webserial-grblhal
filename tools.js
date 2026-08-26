import { registerModal } from './modal.js';

/* --- START OF FILE tools.js --- */

export class ToolsHandler {
    constructor(ws, term, store) {
        this.ws = ws;
        this.term = term;
        this.store = store;

        this.tools = {};
        this.activeToolId = null; // The tool currently loaded in spindle (from status report)
        this._previousToolId = null; // Previous tool before last change
        this.selectedToolId = null; // The tool selected in the UI for editing
        this.mtcActive = false;
        this.renderTimeout = null;

        // TLO measurement state
        this.tloReferenceZ = null; // Machine Z of reference tool
        this.tloReferenceTool = null; // Tool number of reference
        this.tloPreviousZ = null; // Machine Z of most recently measured tool
        this.tloPreviousTool = null; // Tool number of previous measurement
        this.mtcModal = registerModal('tool-change-modal', { closeOnBackdrop: false, closeOnEscape: false });

        this.initUI();
    }

    initUI() {
        const numInput = document.getElementById('edit-tool-num');
        if (numInput) {
            numInput.addEventListener('input', (e) => {
                document.getElementById('edit-tool-id-display').textContent = e.target.value || '?';
            });
        }
    }

    switchToolsTab(targetId, btn) {
        // Hide all contents
        document.querySelectorAll('.tools-tab-content').forEach(el => el.classList.add('hidden'));
        // Show target
        document.getElementById(targetId).classList.remove('hidden');

        if (targetId === 'tab-tool-spoilboard') {
            window.spoilboardGrid?.syncAutoDimensions?.({ silent: true });
            window.spoilboardGrid?.updateCoordinateInfo?.();
        }

        // Reset buttons
        document.querySelectorAll('.tools-tab-btn').forEach(el => {
            el.classList.replace('text-primary-dark', 'text-grey');
            el.classList.replace('border-primary', 'border-transparent');
        });

        // Active button
        btn.classList.replace('text-grey', 'text-primary-dark');
        btn.classList.replace('border-transparent', 'border-primary');

    }

    refresh() {
        if (!this.ws.isConnected) return;
        this.term.writeln('\x1b[34m[Tools] Fetching table ($#)...\x1b[0m');
        this.ws.sendCommand('$#');
    }

    handleLine(line) {
        if (!line) return;
        line = line.trim();

        // 1. PARSE TOOL REPORT (Configuration)
        // Format: [T:1|0.000,0.000,0.000,0.000|0.000|6,0,0||1]
        if (line.startsWith('[T:') && line.includes('|')) {
            try {
                // Remove brackets
                const content = line.substring(1, line.length - 1); // "T:1|0.0,0.0...|..."
                const parts = content.split('|');

                // Part 0: ID "T:1"
                const idStr = parts[0].split(':')[1];
                const id = parseInt(idStr);
                if (isNaN(id)) return;

                // Part 1: Offsets "0.000,0.000,0.000"
                const offsetParts = parts[1].split(',');
                // Default structure usually X,Y,Z or X,Y,Z,A etc.
                const x = parseFloat(offsetParts[0]) || 0;
                const y = parseFloat(offsetParts[1]) || 0;
                const z = parseFloat(offsetParts[2]) || 0;

                // Part 2: Radius "0.000"
                const r = parseFloat(parts[2]) || 0;

                // Store
                this.tools[id] = { x, y, z, r };
                this.triggerRender();
                return;
            } catch (e) {
                console.error("Error parsing extended tool line", line, e);
            }
        }

        // Format: Legacy [T1:0.000,0.000,0.000]
        const legacyMatch = line.match(/^\[T(\d+):([^\]]+)\]$/);
        if (legacyMatch) {
            const id = parseInt(legacyMatch[1]);
            const params = legacyMatch[2].split(',');
            this.tools[id] = {
                x: parseFloat(params[0]) || 0,
                y: parseFloat(params[1]) || 0,
                z: parseFloat(params[2]) || 0,
                r: (params.length > 3 ? parseFloat(params[3]) : 0)
            };
            this.triggerRender();
            return;
        }

        // 2. PARSE REALTIME STATUS (Active Tool)
        // Format: <Idle|MPos:...|...|T:1|...>
        if (line.startsWith('<')) {
            // Check for Tool Change State
            const stateMatch = line.match(/^<([^|]+)\|/);
            if (stateMatch) {
                const state = stateMatch[1];
                if (state === 'Tool' && !this.mtcActive) {
                    this.startMTC();
                } else if (state !== 'Tool' && this.mtcActive) {
                    this.endMTC();
                }
            }

            // Check for Active Tool ID e.g. "|T:1|"
            // The regex looks for |T: followed by digits
            const activeToolMatch = line.match(/\|T:(\d+)/);
            if (activeToolMatch) {
                const newActiveId = parseInt(activeToolMatch[1]);
                if (this.activeToolId !== newActiveId) {
                    this._previousToolId = this.activeToolId;
                    this.activeToolId = newActiveId;
                    this.triggerRender();
                }
            }
        }
    }

    triggerRender() {
        if (this.renderTimeout) clearTimeout(this.renderTimeout);
        this.renderTimeout = setTimeout(() => this.renderTable(), 50);
    }

    renderTable() {
        const tbody = document.getElementById('tool-table-body');
        const badge = document.getElementById('tools-badge');
        const libBadge = document.getElementById('tool-count-badge');

        if (!tbody) return;

        tbody.innerHTML = '';
        const ids = Object.keys(this.tools).map(Number).sort((a, b) => a - b);

        if (badge) badge.textContent = ids.length;
        if (libBadge) libBadge.textContent = ids.length;

        if (ids.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="p-8 text-center text-grey italic">No defined tools found.<br><span class="text-[10px]">Ensure N_TOOLS > 0 in grblHAL config.</span></td></tr>';
            return;
        }

        ids.forEach(id => {
            const tool = this.tools[id];
            const isSelected = this.selectedToolId === id;
            const isActive = this.activeToolId === id;

            const tr = document.createElement('tr');
            // Styling: Blue for selected (Editing), Green border/bg for Active (In Spindle)
            let classes = "border-b border-grey-light transition-colors cursor-pointer group ";
            if (isSelected) classes += "bg-blue-50 ";
            else if (isActive) classes += "bg-green-50 ";
            else classes += "hover:bg-grey-bg ";

            tr.className = classes;
            tr.onclick = () => this.selectTool(id);

            // Tool ID Column with Active Indicator
            let idHtml = `<span class="font-bold text-secondary-dark">${id}</span>`;
            if (isActive) {
                idHtml = `<div class="flex items-center justify-center gap-2">
                            <div class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                            ${idHtml}
                          </div>`;
            }

            tr.innerHTML = `
                <td class="px-4 py-3 text-center">${idHtml}</td>
                <td class="px-4 py-3 text-right font-mono text-sm text-grey-dark">${tool.z.toFixed(3)}</td>
                <td class="px-4 py-3 text-right font-mono text-sm text-grey-dark">${(tool.r * 2).toFixed(2)}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    selectTool(id) {
        this.selectedToolId = id;
        const tool = this.tools[id];

        document.getElementById('edit-tool-num').value = id;
        document.getElementById('edit-tool-id-display').textContent = id;
        document.getElementById('edit-tool-x').value = tool.x.toFixed(3);
        document.getElementById('edit-tool-y').value = tool.y.toFixed(3);
        document.getElementById('edit-tool-z').value = tool.z.toFixed(3);
        document.getElementById('edit-tool-dia').value = (tool.r * 2).toFixed(2);

        this.renderTable();
    }

    clearFields() {
        this.selectedToolId = null;
        document.getElementById('edit-tool-num').value = '';
        document.getElementById('edit-tool-id-display').textContent = '?';
        document.getElementById('edit-tool-x').value = '';
        document.getElementById('edit-tool-y').value = '';
        document.getElementById('edit-tool-z').value = '';
        document.getElementById('edit-tool-dia').value = '';
        this.renderTable();
    }

    setFromCurrent(axis) {
        if (!window.dro || !window.dro.mpos) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
            if (reporter) {
                reporter.showAlert('No Position', 'No machine position available.');
            }
            return;
        }
        // Use Machine Coordinates for G10 L1
        const pos = window.dro.mpos;

        if (axis === 'X') document.getElementById('edit-tool-x').value = pos[0].toFixed(3);
        if (axis === 'Y') document.getElementById('edit-tool-y').value = pos[1].toFixed(3);
        if (axis === 'Z') document.getElementById('edit-tool-z').value = pos[2].toFixed(3);
    }

    saveTool() {
        const id = document.getElementById('edit-tool-num').value;
        if (!id) {
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
            if (reporter) {
                reporter.showAlert('Tool Number Required', 'Tool Number is required.');
            }
            return;
        }

        const x = parseFloat(document.getElementById('edit-tool-x').value) || 0;
        const y = parseFloat(document.getElementById('edit-tool-y').value) || 0;
        const z = parseFloat(document.getElementById('edit-tool-z').value) || 0;
        const dia = parseFloat(document.getElementById('edit-tool-dia').value) || 0;
        const r = dia / 2;

        const cmd = `G10 L1 P${id} X${x} Y${y} Z${z} R${r}`;
        this.ws.sendCommand(cmd);
        this.term.writeln(`\x1b[32m[Tools] Saved T${id}\x1b[0m`);

        // Refresh after short delay
        setTimeout(() => this.refresh(), 500);
    }

    deleteTool() {
        const id = document.getElementById('edit-tool-num').value;
        if (!id) return;
        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        if (!reporter) {
            console.error('Reporter not available for modal');
            return;
        }
        reporter.showConfirm('Delete Tool', `Delete Tool ${id}?`, () => {
            const cmd = `G10 L1 P${id} X0 Y0 Z0 R0`;
            this.ws.sendCommand(cmd);
            setTimeout(() => this.refresh(), 500);
        });
    }

    // --- MTC Protocol ---
    startMTC() {
        if (this.mtcActive) return;
        console.log("MTC: Tool State Detected");
        this.mtcActive = true;

        // Show current/next tool info in modal
        this._updateMTCToolInfo();

        this.mtcModal?.show();

        // SEND ACK (0xA3) to allow jogging/macros
        this.ws.sendRealtime(String.fromCharCode(0xA3));
        this.term.writeln(`\x1b[33m[MTC] Tool Change Detected. Sending ACK (0xA3).\x1b[0m`);
    }

    _updateMTCToolInfo() {
        const infoEl = document.getElementById('mtc-tool-info');
        const badgeEl = document.getElementById('mtc-tool-badge');
        if (!infoEl) return;
        const nextTool = this.activeToolId;
        const prevTool = this._previousToolId;
        if (nextTool) {
            infoEl.classList.remove('hidden');
            badgeEl.classList.remove('hidden');
            badgeEl.textContent = `T${nextTool}`;
            document.getElementById('mtc-current-tool').textContent = prevTool ? `T${prevTool}` : '—';
            document.getElementById('mtc-next-tool').textContent = `T${nextTool}`;
        }
    }

    endMTC() {
        if (!this.mtcActive) return;
        this.mtcActive = false;
        this.mtcModal?.hide();
        // Clear measurement UI
        const refEl = document.getElementById('tlo-ref-info');
        if (refEl) refEl.classList.add('hidden');
        this.term.writeln(`\x1b[32m[MTC] Tool Change Complete.\x1b[0m`);
        // Resume any paused job stream
        if (window.jobController) window.jobController.resumeMTCStream();
    }

    resumeToolChange() {
        this.ws.sendRealtime('~'); // Cycle Start to finish MTC
    }

    // --- TLO (Tool Length Offset) Measurement ---

    /**
     * Set the reference tool length. Records current machine Z as the baseline.
     * Call after probing or jogging the first tool to a known reference surface.
     */
    setTLOReference() {
        if (!window.dro?.mpos) {
            this.term.writeln(`\x1b[31m[TLO] No machine position available.\x1b[0m`);
            return;
        }
        this.tloReferenceZ = window.dro.mpos[2];
        this.tloReferenceTool = this.activeToolId;
        this.tloPreviousZ = this.tloReferenceZ;
        this.tloPreviousTool = this.tloReferenceTool;
        const label = this.activeToolId ? `T${this.activeToolId}` : '?';
        this.term.writeln(`\x1b[32m[TLO] Reference set: ${label} @ Z=${this.tloReferenceZ.toFixed(3)}\x1b[0m`);
        this._updateTLOUI();
    }

    /**
     * Measure the current tool and compute offset from the previous tool.
     * Call after changing tool and probing/jogging to the same reference surface.
     * Applies G43.1 Z{offset} for the difference.
     */
    measureTLO() {
        if (!window.dro?.mpos) {
            this.term.writeln(`\x1b[31m[TLO] No machine position available.\x1b[0m`);
            return;
        }
        if (this.tloPreviousZ === null) {
            this.term.writeln(`\x1b[33m[TLO] No reference set. Use "Set Ref" first.\x1b[0m`);
            return;
        }

        const currentZ = window.dro.mpos[2];
        const prevZ = this.tloPreviousZ;
        const prevTool = this.tloPreviousTool;

        // Offset = new tool Z - previous tool Z
        const offset = currentZ - prevZ;
        const label = this.activeToolId ? `T${this.activeToolId}` : '?';
        const prevLabel = prevTool ? `T${prevTool}` : 'ref';

        // Check if this uses the reference tool (first measurement after reference)
        const isFirst = (this.tloPreviousZ === this.tloReferenceZ && this.tloPreviousTool === this.tloReferenceTool);

        this.term.writeln(`\x1b[36m[TLO] ${label}: Z=${currentZ.toFixed(3)}, offset from ${prevLabel} = ${offset.toFixed(3)}\x1b[0m`);

        if (isFirst) {
            this.term.writeln(`\x1b[32m[TLO] Reference tool measured. No offset applied (baseline).\x1b[0m`);
        } else {
            // Apply dynamic tool length offset via G43.1
            this.ws.sendCommand(`G43.1 Z${offset.toFixed(3)}`);
            this.term.writeln(`\x1b[32m[TLO] Applied G43.1 Z${offset.toFixed(3)}\x1b[0m`);
        }

        // Update state
        this.tloPreviousZ = currentZ;
        this.tloPreviousTool = this.activeToolId;
        this._updateTLOUI();
    }

    /**
     * Reset all TLO state and cancel any active offset.
     */
    resetTLO() {
        this.tloReferenceZ = null;
        this.tloReferenceTool = null;
        this.tloPreviousZ = null;
        this.tloPreviousTool = null;
        // Cancel dynamic offset
        this.ws.sendCommand('G43.1 Z0');
        this.term.writeln(`\x1b[33m[TLO] Reset. G43.1 Z0 sent.\x1b[0m`);
        this._updateTLOUI();
    }

    /**
     * Jog the Z axis to a given absolute position at slow feed for touch-off.
     * @param {number} z - Target Z in machine coordinates
     * @param {number} [feed=50] - Feed rate
     */
    jogToTouchoff(z, feed) {
        this.ws.sendCommand(`G90 G0 Z${z} F${feed || 50}`);
    }

    _updateTLOUI() {
        const infoEl = document.getElementById('tlo-ref-info');
        if (!infoEl) return;
        if (this.tloReferenceZ !== null) {
            infoEl.classList.remove('hidden');
            const refTool = this.tloReferenceTool ? `T${this.tloReferenceTool}` : '?';
            const prevTool = this.tloPreviousTool ? `T${this.tloPreviousTool}` : 'ref';
            const prevZ = this.tloPreviousZ !== null ? this.tloPreviousZ.toFixed(3) : '—';
            document.getElementById('tlo-ref-tool').textContent = refTool;
            document.getElementById('tlo-ref-z').textContent = this.tloReferenceZ.toFixed(3);
            document.getElementById('tlo-prev-tool').textContent = prevTool;
            document.getElementById('tlo-prev-z').textContent = prevZ;
        } else {
            infoEl.classList.add('hidden');
        }
    }
}
