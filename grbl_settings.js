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
        if (!this.tableContainer) return;
        this.renderEmpty();
    }

    hasLoadedData() {
        return Object.keys(this.groups).length > 0 || Object.keys(this.settings).length > 0;
    }

    syncEmptyState() {
        if (!this.tableContainer || this.hasLoadedData()) return;
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
            const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
            if (reporter) {
                reporter.showAlert('No Changes', 'No changes to save.');
            }
            return;
        }

        const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
        if (!reporter) {
            console.error('Reporter not available for modal');
            return;
        }
        reporter.showConfirm('Save Settings', `Save ${ids.length} changed setting(s) to EEPROM?`, () => {

            ids.forEach(id => {
                const val = this.pendingChanges[id];
                this.ws.sendCommand(`$${id}=${val}`);
            });

            this.pendingChanges = {};
            this.render();

            // Refresh values after a moment
            setTimeout(() => this.ws.sendCommand('$$'), 1500);
        });
    }

    backup() {
        const payload = {
            timestamp: new Date().toISOString(),
            settings: {}
        };
        for (const [id, s] of Object.entries(this.settings)) {
            payload.settings[id] = s.val;
        }
        const data = JSON.stringify(payload, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `grblhal_backup_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    restore(file) {
        if (!file) return;
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
            } catch (err) {
                const reporter = window.reporter || (window.AlarmsAndErrors ? new window.AlarmsAndErrors(this.ws) : null);
                if (reporter) {
                    reporter.showAlert('Parse Error', 'Error parsing settings JSON file.');
                }
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

            // Force 744 and 745 to be axis bitmasks
            if (id === '744' || id === '745') {
                this.settings[id].type = 1; // 1 = Bitmask
                if (!this.settings[id].format) {
                    // Try to borrow axis names format from $23 (Homing dir invert), or default
                    this.settings[id].format = (this.settings['23'] && this.settings['23'].format)
                        ? this.settings['23'].format
                        : 'X,Y,Z,A,B,C';
                }
            }

            if (this.activeGroupId === null) this.activeGroupId = parts[1];

            this.debounceRender();
            return true;
        }

        // 3. Descriptions ($ESH)
        if (/^\d+\t/.test(line)) {
            const parts = line.trim().split(/\t+/);
            const id = parts[0];

            if (this.settings[id]) {
                const desc = parts.find(p => p.length > 20 && p.includes(' '));
                if (desc) this.settings[id].desc = desc;
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
        // Use a longer debounce so we don't block the UI thread constantly while reading hundreds of settings
        this.renderTimeout = setTimeout(() => {
            requestAnimationFrame(() => this.render());
        }, 500);
    }

    setActiveGroup(id) {
        console.log('[setActiveGroup]', id, 'pending:', Object.keys(this.pendingChanges).length);
        this.activeGroupId = id;
        this.searchQuery = "";
        requestAnimationFrame(() => this.render());
    }

    setSearchQuery(query) {
        this.searchQuery = query;
        this.render();
        setTimeout(() => {
            const input = document.getElementById('settings-search-input');
            if (input) {
                input.focus();
                const len = input.value.length;
                input.setSelectionRange(len, len);
            }
        }, 0);
    }

    // --- Helpers ---

    getGroupStats(groupId) {
        // Recursive search with cycle detection
        const getAllChildGroupIds = (pid, visited = new Set()) => {
            // Prevent infinite recursion if cycles exist
            if (visited.has(pid)) return [];
            visited.add(pid);

            let ids = [pid];
            // Filter children: must match parentId AND NOT be the parentId itself
            const children = Object.values(this.groups).filter(g => g.parentId == pid && g.id != pid);

            children.forEach(c => {
                ids = ids.concat(getAllChildGroupIds(c.id, visited));
            });
            return ids;
        };

        const allDescendants = getAllChildGroupIds(groupId);

        // Count direct subgroups (excluding self)
        const subgroupCount = Object.values(this.groups).filter(g => g.parentId == groupId && g.id != groupId).length;

        // Count all settings that belong to any group in the descendant tree
        const totalSettings = Object.values(this.settings).filter(s => allDescendants.includes(s.groupId)).length;

        return { subgroups: subgroupCount, settings: totalSettings };
    }

    // --- Rendering ---

    renderEmpty() {
        const isConnected = !!this.ws?.isConnected;
        const icon = isConnected ? 'sliders-horizontal' : 'plug-zap';
        const title = isConnected ? 'Settings Not Loaded' : 'Not Connected';
        const message = isConnected ? 'Click "Refresh" to load settings.' : 'Please connect to load settings...';

        this.tableContainer.innerHTML = `
            <div class="flex items-center justify-center h-64">
                <div class="flex flex-col items-center gap-2 text-center text-grey">
                    <i data-lucide="${icon}" class="w-8 h-8 text-grey"></i>
                    <span class="font-bold text-secondary-dark">${title}</span>
                    <span class="text-xs text-grey">${message}</span>
                </div>
            </div>
        `;

        if (window.lucide) window.lucide.createIcons();
    }

    render() {
        if (!this.tableContainer) return;

        // Restore Scroll Position Logic
        const sidebar = document.getElementById('settings-sidebar');
        const prevSidebarScroll = sidebar ? sidebar.querySelector('.overflow-y-auto').scrollTop : 0;

        // --- Prepare Data ---

        let settingsToDisplay = [];
        let displayTitle = "";
        let childGroups = [];

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
            const activeGroup = this.groups[this.activeGroupId];
            displayTitle = activeGroup ? activeGroup.label : (this.activeGroupId === 'ungrouped' ? 'Other' : 'Settings');

            // 1. Direct Settings
            settingsToDisplay = Object.values(this.settings).filter(s => s.groupId == this.activeGroupId);

            // 2. Subgroups
            childGroups = Object.values(this.groups)
                .filter(g => g.parentId == this.activeGroupId)
                .sort((a, b) => parseInt(a.id) - parseInt(b.id));
        }

        settingsToDisplay.sort((a, b) => parseFloat(a.id) - parseFloat(b.id));
        const sortedGroups = Object.values(this.groups).sort((a, b) => parseInt(a.id) - parseInt(b.id));

        // --- Build HTML ---
        let html = `<div class="flex flex-row h-[calc(100vh-220px)] border border-grey-light rounded-lg bg-white overflow-hidden">`;

        // --- Left Sidebar ---
        html += `<div id="settings-sidebar" class="w-[140px] md:w-1/3 flex flex-col shrink-0">`;
        html += `
            <div class="p-0 sticky top-0 z-20">
                <div class="settings-sidebar-search-card">
                    <label for="settings-search-input" class="ooznest-label settings-sidebar-search-label">Search</label>
                    <div class="relative">
                        <input type="text" id="settings-search-input"
                            class="w-full pl-6 pr-2 py-2 text-[10px] md:text-xs border border-grey-light rounded bg-grey-bg focus:bg-white focus:border-primary outline-none transition-colors"
                            placeholder="Search settings..."
                            value="${this.searchQuery}"
                            oninput="window.grblSettings.setSearchQuery(this.value)">
                    </div>
                </div>
            </div>
            <div class="overflow-y-auto flex-1 bg-grey-bg p-2 md:p-3 space-y-2">
        `;

        if (sortedGroups.length === 0) {
            html += `<div class="text-xs text-grey p-2">No groups</div>`;
        } else {
            sortedGroups.forEach(g => {
                const isActive = (g.id == this.activeGroupId) && (this.searchQuery === "");
                const isSubGroup = g.parentId && g.parentId !== '0';
                const indent = isSubGroup ? 'ml-4 md:ml-6 pl-4 md:pl-6' : '';
                const prefix = isSubGroup ? '- ' : '';
                const pendingCount = this._getPendingCount(g.id);
                html += `
                    <button onclick="window.grblSettings.setActiveGroup('${g.id}')"
                        class="settings-nav-item ${isActive ? 'is-active' : ''} w-full text-left px-3 py-3 text-[10px] md:text-xs font-bold rounded-lg transition-all relative"
                        title="${g.label}">
                        <span class="truncate pr-6 ${indent}">${prefix}${g.label}</span>
                        ${pendingCount > 0 ? `<span class="settings-nav-badge absolute right-2 top-1/2 -translate-y-1/2 text-[10px] md:text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">${pendingCount}</span>` : ''}
                    </button>
                `;
            });
        }

        const hasUngrouped = Object.values(this.settings).some(s => !this.groups[s.groupId]);
        if (hasUngrouped) {
            const isActive = ('ungrouped' == this.activeGroupId) && (this.searchQuery === "");
            const pendingCount = this._getPendingCount('ungrouped');
            html += `
                <button onclick="window.grblSettings.setActiveGroup('ungrouped')"
                    class="settings-nav-item ${isActive ? 'is-active' : ''} w-full text-left px-3 py-3 text-[10px] md:text-xs font-bold rounded-lg transition-all relative mt-2">
                    <span class="truncate pr-6">Other</span>
                    ${pendingCount > 0 ? `<span class="settings-nav-badge absolute right-2 top-1/2 -translate-y-1/2 text-[10px] md:text-xs font-bold px-1.5 py-0.5 rounded-full leading-none">${pendingCount}</span>` : ''}
                </button>
            `;
        }
        html += `</div></div>`;

        // --- Right Panel ---
        html += `<div id="settings-main-panel" class="flex-1 overflow-y-auto bg-white relative w-0 flex flex-col min-h-0">`;

        // Header
        html += `
            <div class="px-4 py-2.5 border-b border-grey-light sticky top-0 z-20 flex items-center gap-2">
                ${this.searchQuery ? '<i data-lucide="search" style="width:14px;height:14px"></i>' : '<i data-lucide="folder" style="width:14px;height:14px"></i>'}
                <h3 class="font-bold text-secondary-dark text-xs uppercase tracking-wider truncate">${displayTitle}</h3>
            </div>
        `;

        // Content Area
        let hasContent = false;
        const subcategoryPanelClass = settingsToDisplay.length > 0
            ? 'p-4 bg-white border-b border-grey-light'
            : 'p-4 bg-white border-b border-grey-light flex-1';

        // 1. Render Subgroups (if any)
        if (childGroups.length > 0) {
            hasContent = true;
            html += `<div class="${subcategoryPanelClass}">`;
            html += `<h4 class="text-[10px] font-bold text-grey uppercase tracking-wider mb-2">Subcategories</h4>`;
            html += `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">`;

            childGroups.forEach(g => {
                const stats = this.getGroupStats(g.id);
                // "3 Subgroups • 45 Settings" or just "12 Settings"
                let metaText = `${stats.settings} Settings`;
                if (stats.subgroups > 0) metaText = `${stats.subgroups} Subgroups • ` + metaText;

                const subPending = this._getPendingCount(g.id);
                html += `
                    <button onclick="window.grblSettings.setActiveGroup('${g.id}')"
                        class="flex flex-col items-start p-3 bg-white border border-grey-light rounded-lg hover:border-primary hover:shadow-md hover:-translate-y-0.5 transition-all text-left group">
                        <span class="font-bold text-secondary-dark group-hover:text-primary-dark text-xs flex items-center gap-2">
                            <i data-lucide="folder" style="width:14px;height:14px"></i> ${g.label}
                            ${subPending > 0 ? `<span class="bg-primary text-white text-[11px] font-bold px-1.5 py-0.5 rounded-full">${subPending}</span>` : ''}
                        </span>
                        <span class="text-[9px] font-bold text-grey uppercase mt-1">${metaText}</span>
                    </button>
                `;
            });
            html += `</div></div>`;
        }

        // 2. Render Settings Table (if any)
        if (settingsToDisplay.length > 0) {
            hasContent = true;
            html += `
                <table class="w-full text-left text-sm">
                    <thead class="bg-white text-grey uppercase text-[9px] md:text-[10px] tracking-wider border-b border-grey-light sticky top-0 z-10">
                        <tr>
                            <th class="px-1 md:px-4 py-2 w-8 md:w-16 bg-surface text-center md:text-left">$</th>
                            <th class="px-1 md:px-4 py-2 bg-surface w-auto">Description</th>
                            <th class="px-1 md:px-4 py-2 w-16 md:w-1/3 bg-surface">Value</th>
                            <th class="px-1 md:px-4 py-2 w-16 md:w-28 bg-surface whitespace-nowrap">Unit</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-grey-light">`;

            settingsToDisplay.forEach(s => {
                const isModified = this.pendingChanges[s.id] !== undefined;
                const displayValue = isModified ? this.pendingChanges[s.id] : s.val;
                const rowClass = isModified ? 'bg-yellow-50' : 'hover:bg-grey-bg';

                // Enrichment for Event Plugin settings ($760-$769)
                let enrichmentHtml = '';
                const idNum = parseInt(s.id);
                if (idNum >= 760 && idNum <= 769) {
                    enrichmentHtml = this._getEventPluginEnrichment(s);
                }

                html += `
                    <tr class="${rowClass} transition-colors group">
                        <td class="px-0.5 md:px-4 py-2 md:py-3 font-mono text-secondary-dark font-bold text-[10px] md:text-xs align-top text-center md:text-left break-all leading-tight">
                            <div class="pt-2 leading-tight">$${s.id}</div>
                        </td>
                        <td class="px-1 md:px-4 py-2 md:py-3 align-top">
                            <div class="pt-2 text-grey-dark font-bold text-[11px] md:text-xs leading-tight">${s.label}</div>
                            ${s.desc ? `<div class="hidden md:block text-[10px] text-grey mt-1 leading-tight max-w-md">${s.desc.replace(/\\n/g, '<br>')}</div>` : ''}
                            ${enrichmentHtml}
                        </td>
                        <td class="px-0.5 md:px-4 py-2 md:py-3 align-top">
                            ${this._renderInput(s, displayValue)}
                            ${isModified ? '<div class="text-[9px] md:text-[10px] text-primary-dark font-bold mt-0.5 text-right animate-pulse">Save?</div>' : ''}
                        </td>
                        <td class="px-0.5 md:px-4 py-2 md:py-3 text-[9px] md:text-xs text-grey align-top whitespace-nowrap leading-tight">
                            <div class="pt-2 leading-tight">${s.unit || '-'}</div>
                        </td>
                    </tr>
                `;
            });
            html += `</tbody></table>`;
        }

        // 3. True Empty State
        if (!hasContent) {
            html += `
                <div class="flex flex-col items-center justify-center h-64 text-grey opacity-50">
                    <i data-lucide="inbox" style="width:14px;height:14px"></i>
                    <p class="text-sm">No settings or subcategories found here.</p>
                </div>`;
        }

        html += `</div></div>`; // End Panel & Main Flex

        this.tableContainer.innerHTML = html;

        // Restore Scroll Positions
        const newSidebar = document.getElementById('settings-sidebar');
        if (newSidebar && !this.searchQuery) {
            const sbContainer = newSidebar.querySelector('.overflow-y-auto');
            if (sbContainer) sbContainer.scrollTop = prevSidebarScroll;
        }

        this._updateSaveButton();
        if (window.lucide) window.lucide.createIcons();
    }

    _updateSaveButton() {
        const btn = document.querySelector('#settings-view .btn-primary');
        if (!btn) return;
        const count = Object.keys(this.pendingChanges).length;
        btn.innerHTML = count > 0
            ? `<i data-lucide="save" style="width:14px;height:14px"></i> Save (${count})`
            : `<i data-lucide="save" style="width:14px;height:14px"></i> Save`;
        btn.disabled = count === 0;
        if (window.lucide) window.lucide.createIcons();
    }

    _getEventPluginEnrichment(s) {
        // Cross-reference Event Plugin settings ($760-$769) with pin data from troubleshooting
        const trouble = window.troubleshooting;
        if (!trouble || !trouble.pinDefsByPin || Object.keys(trouble.pinDefsByPin).length === 0) return '';

        const val = s.val;
        if (!val || val === '-1' || val === '') return '';

        // Check if the value is a pin number
        const pinDef = trouble.pinDefsByPin[val];
        if (!pinDef) return '';

        // Check if this function is already assigned to another pin
        const assignedElsewhere = Object.entries(trouble.pinDefsByPin)
            .filter(([pin, def]) => pin !== val && def.label === pinDef.label)
            .map(([pin]) => `P${pin}`);

        let html = `<div class="flex flex-wrap gap-1 mt-1.5 text-[10px]">`;
        html += `<span class="font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">${pinDef.hw}</span>`;
        html += `<span class="font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">P${val}</span>`;
        if (pinDef.func) {
            html += `<span class="font-bold px-1.5 py-0.5 rounded bg-green-50 text-green-700 border border-green-200">${pinDef.func}</span>`;
        }
        if (pinDef.label !== s.label) {
            html += `<span class="text-grey italic">as ${pinDef.label}</span>`;
        }
        if (assignedElsewhere.length) {
            html += `<span class="font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">Also assigned: ${assignedElsewhere.join(', ')}</span>`;
        }
        html += '</div>';
        return html;
    }

    _renderInput(s, val) {
        // 0: Boolean
        if (s.type === 0 || s.type === 'bool') {
            const checked = (val == '1' || val === 'on' || val === true);
            return `
                <div class="flex justify-end md:justify-start">
                <label class="inline-flex items-center cursor-pointer">
                    <input type="checkbox" class="sr-only peer"
                        oninput="window.grblSettings.update('${s.id}', this.checked ? 1 : 0)"
                        ${checked ? 'checked' : ''}>
                    <div class="relative w-7 md:w-9 h-4 md:h-5 bg-grey-light peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 md:after:h-4 after:w-3 md:after:w-4 after:transition-all peer-checked:bg-green-600"></div>
                </label>
                </div>
            `;
        }

        // 1: Bitmask (Checkbox List)
        if (s.type === 1 || s.type === 'mask') {
            const intVal = parseInt(val) || 0;
            if (!s.format) return `<input type="number" class="input-field h-7 md:h-8 px-1 text-xs" value="${val}" oninput="window.grblSettings.update('${s.id}', this.value)">`;

            const options = s.format.split(',');
            // Stacked vertical on mobile
            let html = `<div class="flex flex-col gap-1 border border-grey-light rounded p-1 bg-grey-bg">`;

            options.forEach((label, index) => {
                if (!label || label.toUpperCase() === 'N/A') return;
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

        // 2: Exclusive bitfield (like bitmask but bit 0 gates all others)
        if (s.type === 2) {
            const intVal = parseInt(val) || 0;
            if (!s.format) return `<input type="number" class="input-field h-7 md:h-8 px-1 text-xs" value="${val}" oninput="window.grblSettings.update('${s.id}', this.value)">`;

            const options = s.format.split(',');
            const bit0Set = (intVal & 1) !== 0;
            let html = `<div class="flex flex-col gap-1 border border-grey-light rounded p-1 bg-grey-bg">`;

            options.forEach((label, index) => {
                if (!label || label.toUpperCase() === 'N/A') return;
                const bitMask = 1 << index;
                const isSet = (intVal & bitMask) !== 0;
                const disabled = index > 0 && !bit0Set ? 'disabled' : '';

                html += `
                    <label class="inline-flex items-center gap-1 cursor-pointer hover:bg-white rounded px-0.5 transition-colors ${disabled ? 'opacity-40' : ''}">
                        <input type="checkbox" class="rounded text-primary focus:ring-primary h-3 w-3 border-grey-light"
                            onchange="window.grblSettings.updateMask('${s.id}', ${bitMask}, this.checked)"
                            ${isSet ? 'checked' : ''} ${disabled}>
                        <span class="text-[9px] md:text-[11px] text-grey-dark leading-none pt-0.5 truncate">${label}</span>
                    </label>
                `;
            });
            html += `</div>`;
            return html;
        }

        // 4: Axis mask (Checkbox List for X, Y, Z, A, B, C)
        if (s.type === 4) {
            const intVal = parseInt(val) || 0;
            let labels;
            if (s.format) {
                if (/^\d+$/.test(s.format)) {
                    labels = ['X', 'Y', 'Z', 'A', 'B', 'C'].slice(0, parseInt(s.format));
                } else {
                    labels = s.format.split(',').map(l => l.trim());
                }
            } else {
                labels = ['X', 'Y', 'Z', 'A', 'B', 'C'];
            }
            let html = `<div class="flex flex-col gap-1 border border-grey-light rounded p-1 bg-grey-bg">`;
            labels.forEach((label, index) => {
                if (!label || label.toUpperCase() === 'N/A') return;
                const bitMask = 1 << index;
                const isSet = (intVal & bitMask) !== 0;
                html += `
                    <label class="inline-flex items-center gap-1 cursor-pointer hover:bg-white rounded px-0.5 transition-colors">
                        <input type="checkbox" class="rounded text-primary focus:ring-primary h-3 w-3 border-grey-light"
                            onchange="window.grblSettings.updateMask('${s.id}', ${bitMask}, this.checked)"
                            ${isSet ? 'checked' : ''}>
                        <span class="text-[9px] md:text-[11px] text-grey-dark leading-none pt-0.5 truncate font-mono font-bold">${label}</span>
                    </label>
                `;
            });
            html += `</div>`;
            return html;
        }

        // 3: Enum (Select)
        if (s.type === 3 && s.format) {
            const options = s.format.split(',');
            let html = `<select class="oz-select oz-select--compact text-[10px] md:text-xs w-full" oninput="window.grblSettings.update('${s.id}', this.value)">`;

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
                    oninput="window.grblSettings.update('${s.id}', this.value)">
            `;
        }

        // Fallback String
        return `
            <input type="text" class="input-field h-7 md:h-8 text-[11px] md:text-xs font-mono w-full px-1"
                value="${val}"
                oninput="window.grblSettings.update('${s.id}', this.value)">
        `;
    }

    _getPendingCount(groupId) {
        let count = 0;
        for (const sid of Object.keys(this.pendingChanges)) {
            if (this.settings[sid] && String(this.settings[sid].groupId) === String(groupId)) {
                count++;
            }
        }
        return count;
    }

    _updateSidebarBadges() {
        const sidebar = document.getElementById('settings-sidebar');
        if (!sidebar) return;
        const buttons = sidebar.querySelectorAll('button');
        buttons.forEach(btn => {
            const match = btn.getAttribute('onclick')?.match(/setActiveGroup\('(\w+)'\)/);
            if (!match) return;
            const groupId = match[1];
            const count = this._getPendingCount(groupId);
            const existingBadge = btn.querySelector('.absolute.right-1');
            if (count > 0) {
                if (existingBadge) {
                    existingBadge.textContent = String(count);
                } else {
                    const badge = document.createElement('span');
                    badge.className = 'absolute right-1 top-1/2 -translate-y-1/2 bg-primary text-white text-[10px] md:text-xs font-bold px-1.5 py-0.5 rounded-full leading-none';
                    badge.textContent = String(count);
                    btn.appendChild(badge);
                }
            } else {
                if (existingBadge) existingBadge.remove();
            }
        });
    }

    update(id, newVal) {
        if (String(this.settings[id].val) !== String(newVal)) {
            this.pendingChanges[id] = newVal;
        } else {
            delete this.pendingChanges[id];
        }
        this._updateSaveButton();
        this._updateSidebarBadges();
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
