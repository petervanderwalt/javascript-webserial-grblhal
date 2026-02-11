/* --- START OF FILE tools.js --- */

export class ToolsHandler {
    constructor(ws, term, store) {
        this.ws = ws;
        this.term = term;
        this.store = store;

        this.tools = {};
        this.activeToolId = null; // The tool currently loaded in spindle (from status report)
        this.selectedToolId = null; // The tool selected in the UI for editing
        this.mtcActive = false;
        this.renderTimeout = null;

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
        const badge = document.getElementById('tool-count-badge');
        const navBadge = document.getElementById('tools-badge');

        if (!tbody) return;

        tbody.innerHTML = '';
        const ids = Object.keys(this.tools).map(Number).sort((a, b) => a - b);

        if (badge) badge.textContent = ids.length;
        if (navBadge) {
            navBadge.textContent = ids.length;
            if (ids.length > 0) navBadge.classList.remove('hidden');
        }

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

        document.getElementById('tool-change-modal').classList.remove('hidden');

        // SEND ACK (0xA3) to allow jogging/macros
        this.ws.sendRealtime(String.fromCharCode(0xA3));
        this.term.writeln(`\x1b[33m[MTC] Tool Change Detected. Sending ACK (0xA3).\x1b[0m`);
    }

    endMTC() {
        if (!this.mtcActive) return;
        this.mtcActive = false;
        document.getElementById('tool-change-modal').classList.add('hidden');
        this.term.writeln(`\x1b[32m[MTC] Tool Change Complete.\x1b[0m`);
    }

    resumeToolChange() {
        this.ws.sendRealtime('~'); // Cycle Start to finish MTC
    }
}
