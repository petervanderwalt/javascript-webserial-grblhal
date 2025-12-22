export class GrblSettings {
    constructor(ws, term) {
        this.ws = ws;
        this.term = term;

        // Data Store
        this.groups = {};       // Map: id -> { id, label, parentId }
        this.settings = {};     // Map: id -> { id, val, label, unit, type, format, min, max, groupId, desc }
        this.pendingChanges = {}; // Map: id -> newValue

        // UI State
        this.activeGroupId = null;
        this.searchQuery = "";
        this.tableContainer = null;
        this.renderTimeout = null;
    }

    init(containerId) {
        this.tableContainer = document.getElementById(containerId);
        if(!this.tableContainer) return;
        this.renderEmpty();
    }

    // --- Commands ---

    fetchSettings() {
        this.term.writeln('\x1b[34m> Discovering GrblHAL Settings...\x1b[0m');

        // Reset Logic
        this.groups = {};
        this.settings = {};
        this.pendingChanges = {};
        this.activeGroupId = null;
        this.searchQuery = "";

        // 1. Get Groups ($EG)
        this.ws.sendCommand('$EG');

        // 2. Get Settings Structure ($ES)
        setTimeout(() => this.ws.sendCommand('$ES'), 200);

        // 3. Get Detailed Descriptions ($ESH)
        setTimeout(() => this.ws.sendCommand('$ESH'), 600);

        // 4. Get Values ($$)
        setTimeout(() => this.ws.sendCommand('$$'), 1000);
    }

    saveChanges() {
        const ids = Object.keys(this.pendingChanges);
        if (ids.length === 0) {
            alert("No changes to save.");
            return;
        }

        if (!confirm(`Save ${ids.length} changed settings to EEPROM?`)) return;

        ids.forEach(id => {
            const val = this.pendingChanges[id];
            this.ws.sendCommand(`$${id}=${val}`);
        });

        this.pendingChanges = {};
        this.render();

        // Refresh values after a moment
        setTimeout(() => this.ws.sendCommand('$$'), 1500);
    }

    backup() {
        const payload = {
            timestamp: new Date().toISOString(),
            settings: {}
        };
        for(const [id, s] of Object.entries(this.settings)) {
            payload.settings[id] = s.val;
        }
        const data = JSON.stringify(payload, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `grblhal_backup_${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    restore(file) {
        if(!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const json = JSON.parse(e.target.result);
                const data = json.settings || json;
                let count = 0;
                for (const [id, val] of Object.entries(data)) {
                    if (val !== undefined && this.settings[id]) {
                        this.ws.sendCommand(`$${id}=${val}`);
                        count++;
                    }
                }
                this.term.writeln(`\x1b[32m> Restored ${count} settings.\x1b[0m`);
                setTimeout(() => this.ws.sendCommand('$$'), 2000);
            } catch(err) {
                alert("Error parsing settings JSON file.");
            }
        };
        reader.readAsText(file);
    }

    // --- Parser ---

    handleLine(line) {
        // 1. Groups
        if (line.startsWith('[SETTINGGROUP:')) {
            const content = line.slice(14, -1);
            const parts = content.split('|');
            const id = parts[0];

            this.groups[id] = {
                id: id,
                parentId: parts[1],
                label: parts[2]
            };

            if (this.activeGroupId === null) {
                this.activeGroupId = id;
            }
            return true;
        }

        // 2. Settings Structure
        if (line.startsWith('[SETTING:')) {
            const content = line.slice(9, -1);
            const parts = content.split('|');

            const id = parts[0];
            const type = parseInt(parts[4]);

            this.settings[id] = {
                id: id,
                groupId: parts[1] || '0',
                label: parts[2],
                unit: parts[3],
                type: type,
                format: parts[5],
                min: parts[6],
                max: parts[7],
                val: parts[8],
                desc: this.settings[id]?.desc || ''
            };

            if(this.activeGroupId === null) this.activeGroupId = parts[1];

            this.debounceRender();
            return true;
        }

        // 3. Descriptions ($ESH)
        if (/^\d+\t/.test(line)) {
            const parts = line.trim().split(/\t+/);
            const id = parts[0];

            if (this.settings[id]) {
                const desc = parts.find(p => p.length > 20 && p.includes(' '));
                if(desc) this.settings[id].desc = desc;
            }
            return true;
        }

        // 4. Standard Values ($$)
        if (line.startsWith('$')) {
            const parts = line.split('=');
            if (parts.length === 2) {
                const id = parts[0].substring(1);
                if (isNaN(parseFloat(id))) return false;

                const val = parts[1].trim();

                if (this.settings[id]) {
                    this.settings[id].val = val;
                } else {
                    this.settings[id] = { id: id, val: val, groupId: '0', label: 'Unknown' };
                }

                this.debounceRender();
                return true;
            }
        }

        return false;
    }

    debounceRender() {
        if (this.renderTimeout) clearTimeout(this.renderTimeout);
        this.renderTimeout = setTimeout(() => this.render(), 100);
    }

    setActiveGroup(id) {
        this.activeGroupId = id;
        this.searchQuery = ""; // Clear search when picking a group
        this.render();
    }

    setSearchQuery(query) {
        this.searchQuery = query;
        this.render();
        // Restore focus to input after render
        setTimeout(() => {
            const input = document.getElementById('settings-search-input');
            if(input) {
                input.focus();
                // Move cursor to end
                const len = input.value.length;
                input.setSelectionRange(len, len);
            }
        }, 0);
    }

    // --- Rendering ---

    renderEmpty() {
        this.tableContainer.innerHTML = `
            <div class="flex flex-col items-center justify-center h-64 text-grey">
                <i class="bi bi-sliders text-4xl mb-2"></i>
                <p>Click "Refresh" to load settings.</p>
            </div>
        `;
    }

    render() {
        if (!this.tableContainer) return;

        // Restore Scroll Position Logic
        const sidebar = document.getElementById('settings-sidebar');
        const mainPanel = document.getElementById('settings-main-panel');
        const prevSidebarScroll = sidebar ? sidebar.scrollTop : 0;
        const prevMainScroll = mainPanel ? mainPanel.scrollTop : 0;

        // --- Prepare Data ---

        let settingsToDisplay = [];
        let displayTitle = "";

        if (this.searchQuery.trim().length > 0) {
            // SEARCH MODE
            const q = this.searchQuery.toLowerCase();
            settingsToDisplay = Object.values(this.settings).filter(s => {
                return s.id.includes(q) ||
                       (s.label && s.label.toLowerCase().includes(q)) ||
                       (s.desc && s.desc.toLowerCase().includes(q)) ||
                       String(s.val).toLowerCase().includes(q);
            });
            displayTitle = `Search Results (${settingsToDisplay.length})`;
        } else {
            // GROUP MODE
            settingsToDisplay = Object.values(this.settings).filter(s => s.groupId == this.activeGroupId);
            const activeGroup = this.groups[this.activeGroupId];
            displayTitle = activeGroup ? activeGroup.label : 'Unknown Group';
        }

        // Sort Settings
        settingsToDisplay.sort((a, b) => parseFloat(a.id) - parseFloat(b.id));

        // Sort Groups for Sidebar
        const sortedGroups = Object.values(this.groups).sort((a, b) => parseInt(a.id) - parseInt(b.id));

        // --- Build HTML ---
        // Layout: Side-by-side on all screens
        let html = `<div class="flex flex-row h-[calc(100vh-220px)] border border-grey-light rounded-lg bg-white overflow-hidden shadow-sm">`;

        // --- Left Sidebar ---
        // Width: 110px on mobile, 25% on desktop
        html += `<div id="settings-sidebar" class="w-[110px] md:w-1/4 bg-grey-bg border-r border-grey-light flex flex-col shrink-0">`;

        // Search Box
        html += `
            <div class="p-2 border-b border-grey-light bg-white sticky top-0 z-20">
                <div class="relative">
                    <i class="bi bi-search absolute left-1.5 top-1.5 text-grey text-[10px] md:text-xs"></i>
                    <input type="text" id="settings-search-input"
                        class="w-full pl-6 pr-1 py-1 text-[10px] md:text-xs border border-grey-light rounded bg-grey-bg focus:bg-white focus:border-primary outline-none transition-colors"
                        placeholder="Search..."
                        value="${this.searchQuery}"
                        oninput="window.grblSettings.setSearchQuery(this.value)">
                </div>
            </div>
            <div class="overflow-y-auto flex-1 p-1 md:p-2 space-y-0.5 md:space-y-1">
        `;

        if (sortedGroups.length === 0) {
            html += `<div class="text-xs text-grey p-2">No groups</div>`;
        } else {
            sortedGroups.forEach(g => {
                const isActive = (g.id == this.activeGroupId) && (this.searchQuery === "");
                const activeClass = isActive
                    ? 'bg-white text-primary-dark border-l-4 border-primary shadow-sm'
                    : 'text-grey-dark hover:bg-grey-light/50 border-l-4 border-transparent';

                const isSubGroup = g.parentId && g.parentId !== '0';
                const indent = isSubGroup ? 'ml-2 md:ml-4' : '';

                // Compact button style
                html += `
                    <button onclick="window.grblSettings.setActiveGroup('${g.id}')"
                        class="w-full text-left px-2 py-2 text-[10px] md:text-xs font-bold rounded-r transition-all truncate ${activeClass} ${indent}" title="${g.label}">
                        ${g.label}
                    </button>
                `;
            });
        }

        // Ungrouped
        const hasUngrouped = Object.values(this.settings).some(s => !this.groups[s.groupId]);
        if(hasUngrouped) {
             const isActive = ('ungrouped' == this.activeGroupId) && (this.searchQuery === "");
             const activeClass = isActive ? 'bg-white text-primary-dark border-l-4 border-primary shadow-sm' : 'text-grey-dark hover:bg-grey-light/50 border-l-4 border-transparent';
             html += `
                <button onclick="window.grblSettings.setActiveGroup('ungrouped')"
                    class="w-full text-left px-2 py-2 text-[10px] md:text-xs font-bold rounded-r transition-all ${activeClass} border-t border-grey-light mt-1">
                    Other
                </button>
            `;
        }
        html += `</div></div>`; // End Sidebar

        // --- Right Panel ---
        html += `<div id="settings-main-panel" class="flex-1 overflow-y-auto bg-white relative w-0">`; // w-0 to allow flex grow

        if (settingsToDisplay.length === 0) {
            html += `
                <div class="flex flex-col items-center justify-center h-full text-grey opacity-50">
                    <i class="bi bi-inbox text-4xl mb-2"></i>
                    <p class="text-sm">No settings found</p>
                </div>`;
        } else {
            // Header
            html += `
                <div class="bg-grey-bg px-2 md:px-4 py-2 border-b border-grey-light font-bold text-secondary-dark sticky top-0 z-20 shadow-sm flex items-center gap-2 text-xs md:text-sm">
                    ${this.searchQuery ? '<i class="bi bi-search"></i>' : '<i class="bi bi-folder2-open"></i>'}
                    <span class="truncate">${displayTitle}</span>
                </div>
            `;

            html += `
                <table class="w-full text-left text-sm table-fixed">
                    <thead class="bg-surface text-grey uppercase text-[9px] md:text-[10px] tracking-wider border-b border-grey-light sticky top-8 z-10 shadow-sm">
                        <tr>
                            <th class="px-1 md:px-4 py-2 w-8 md:w-16 bg-surface text-center md:text-left">$</th>
                            <th class="px-1 md:px-4 py-2 bg-surface w-auto">Description</th>
                            <th class="px-1 md:px-4 py-2 w-16 md:w-1/3 bg-surface">Val</th>
                            <th class="px-1 md:px-4 py-2 w-8 md:w-20 bg-surface">Unit</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-grey-light">`;

            settingsToDisplay.forEach(s => {
                const isModified = this.pendingChanges[s.id] !== undefined;
                const displayValue = isModified ? this.pendingChanges[s.id] : s.val;
                const rowClass = isModified ? 'bg-yellow-50' : 'hover:bg-grey-bg';

                html += `
                    <tr class="${rowClass} transition-colors group">
                        <!-- ID: Fixed 32px width -->
                        <td class="px-0.5 md:px-4 py-2 md:py-3 font-mono text-secondary-dark font-bold text-[10px] md:text-xs align-top pt-3 md:pt-4 text-center md:text-left break-all">$${s.id}</td>

                        <!-- Desc: Auto width -->
                        <td class="px-1 md:px-4 py-2 md:py-3 align-top">
                            <div class="text-grey-dark font-bold text-[11px] md:text-xs leading-tight">${s.label}</div>
                            ${s.desc ? `<div class="hidden md:block text-[10px] text-grey mt-1 leading-tight max-w-md">${s.desc.replace(/\\n/g, '<br>')}</div>` : ''}
                        </td>

                        <!-- Value: Fixed 64px on mobile, dynamic on desktop -->
                        <td class="px-0.5 md:px-4 py-2 md:py-3 align-top">
                            ${this._renderInput(s, displayValue)}
                            ${isModified ? '<div class="text-[9px] md:text-[10px] text-primary-dark font-bold mt-0.5 text-right animate-pulse">Save?</div>' : ''}
                        </td>

                        <!-- Unit: Fixed 32px width -->
                        <td class="px-0.5 md:px-4 py-2 md:py-3 text-[9px] md:text-xs text-grey align-top pt-3 md:pt-4 break-all leading-tight">${s.unit || '-'}</td>
                    </tr>
                `;
            });
            html += `</tbody></table>`;
        }

        html += `</div>`; // End Right Panel
        html += `</div>`; // End Main Flex

        this.tableContainer.innerHTML = html;

        // Restore Scroll Positions
        const newSidebar = document.getElementById('settings-sidebar');
        if (newSidebar && !this.searchQuery) {
            const sbContainer = newSidebar.querySelector('.overflow-y-auto');
            if(sbContainer) sbContainer.scrollTop = prevSidebarScroll;
        }
    }

    _renderInput(s, val) {
        // 0: Boolean
        if (s.type === 0 || s.type === 'bool') {
            const checked = (val == '1' || val === 'on' || val === true);
            return `
                <div class="flex justify-end md:justify-start">
                <label class="inline-flex items-center cursor-pointer">
                    <input type="checkbox" class="sr-only peer"
                        onchange="window.grblSettings.update('${s.id}', this.checked ? 1 : 0)"
                        ${checked ? 'checked' : ''}>
                    <div class="relative w-7 md:w-9 h-4 md:h-5 bg-grey-light peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 md:after:h-4 after:w-3 md:after:w-4 after:transition-all peer-checked:bg-green-600"></div>
                </label>
                </div>
            `;
        }

        // 1: Bitmask (Checkbox List)
        if (s.type === 1 || s.type === 'mask') {
            const intVal = parseInt(val) || 0;
            if (!s.format) return `<input type="number" class="input-field h-7 md:h-8 px-1 text-xs" value="${val}" onchange="window.grblSettings.update('${s.id}', this.value)">`;

            const options = s.format.split(',');
            // Stacked vertical on mobile
            let html = `<div class="flex flex-col gap-1 border border-grey-light rounded p-1 bg-grey-bg/30">`;

            options.forEach((label, index) => {
                if(!label || label.toUpperCase() === 'N/A') return;
                const bitMask = 1 << index;
                const isSet = (intVal & bitMask) !== 0;

                html += `
                    <label class="inline-flex items-center gap-1 cursor-pointer hover:bg-white rounded px-0.5 transition-colors">
                        <input type="checkbox" class="rounded text-primary focus:ring-primary h-3 w-3 border-grey-light"
                            onchange="window.grblSettings.updateMask('${s.id}', ${bitMask}, this.checked)"
                            ${isSet ? 'checked' : ''}>
                        <span class="text-[9px] md:text-[11px] text-grey-dark leading-none pt-0.5 truncate">${label}</span>
                    </label>
                `;
            });
            html += `</div>`;
            return html;
        }

        // 3: Enum (Select)
        if (s.type === 3 && s.format) {
            const options = s.format.split(',');
            let html = `<select class="input-field h-7 md:h-8 text-[10px] md:text-xs w-full bg-white border-grey-light shadow-sm px-0.5" onchange="window.grblSettings.update('${s.id}', this.value)">`;

            options.forEach((label, index) => {
                html += `<option value="${index}" ${val == index ? 'selected' : ''}>${label}</option>`;
            });
            html += `</select>`;
            return html;
        }

        // 5: Float / Integer
        if (s.type === 5 || s.type === 'float' || !s.type) {
            return `
                <input type="number" class="input-field h-7 md:h-8 text-[11px] md:text-xs font-mono w-full px-1"
                    value="${val}"
                    step="any"
                    ${s.min ? `min="${s.min}"` : ''}
                    ${s.max ? `max="${s.max}"` : ''}
                    onchange="window.grblSettings.update('${s.id}', this.value)">
            `;
        }

        // Fallback String
        return `
            <input type="text" class="input-field h-7 md:h-8 text-[11px] md:text-xs font-mono w-full px-1"
                value="${val}"
                onchange="window.grblSettings.update('${s.id}', this.value)">
        `;
    }

    update(id, newVal) {
        if (String(this.settings[id].val) !== String(newVal)) {
            this.pendingChanges[id] = newVal;
        } else {
            delete this.pendingChanges[id];
        }
        this.render();
    }

    updateMask(id, bitMask, isChecked) {
        let currentVal = parseInt(
            this.pendingChanges[id] !== undefined ? this.pendingChanges[id] : this.settings[id].val
        ) || 0;

        if (isChecked) {
            currentVal |= bitMask;
        } else {
            currentVal &= ~bitMask;
        }

        this.update(id, currentVal);
    }
}
