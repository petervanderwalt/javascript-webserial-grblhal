import { registerModal } from './modal.js';

export class ConfigWizard {
    constructor(ws, store) {
        console.log('[ConfigWizard] constructor');
        this.ws = ws;
        this.store = store;
        this.machines = [];
        this.spindles = {};
        this.modbusProtocols = {};
        this.verInfo = null;
        this.optInfo = null;
        this.numInfo = null;
        this.axsInfo = null;
        this.plgInfo = null;
        this.enInfo = null;
        this.boardInfo = null;
        this._collectingVer = false;
        this._verLines = [];
        this._expandedMachineCat = null;
        this.wizardStep = 0;
        this.wizardData = {
            machine: null,
            toolheads: {
                spindle: null,
                vfdModbusEnabled: false,
                vfdModbus: null,
                laser: false
            },
            probeType: 'ooznest',
            plateThickness: 5,
            xyPlateOffset: 10,
            wifiMode: '0',
            wifiSsid: '',
            wifiPsk: '',
            dustShoe: false,
            enclosure: false,
            firmwareFlashed: false
        };
        this.modal = registerModal('config-wizard-overlay', { closeOnBackdrop: true, closeOnEscape: true });
        this.loadMachineJson();
    }

    async loadMachineJson() {
        try {
            const resp = await fetch('./machine.json');
            if (resp.ok) {
                const data = await resp.json();
                this.machines = data.machines || [];
                this.spindles = data.spindles || {};
                this.modbusProtocols = data.modbusProtocols || {};
            }
        } catch (e) {
            console.warn('[ConfigWizard] Failed to load machine.json:', e);
        }
    }

    startCollecting() {
        console.log('[ConfigWizard] startCollecting');
        this._collectingVer = true;
        this._verLines = [];
        this.verInfo = null;
        this.optInfo = null;
        this.numInfo = null;
        this.axsInfo = null;
        this.plgInfo = null;
        this.enInfo = null;
        this.boardInfo = null;
    }

    handleLine(line) {
        if (line.startsWith('[VER:')) {
            this.startCollecting();
            this._parseVerLine(line);
            window.term.writeln(line);
            return true;
        }
        if (!this._collectingVer) return false;

        window.term.writeln(line);
        if (line.startsWith('[OPT:')) {
            this.optInfo = line;
        } else if (line.startsWith('[NUM:')) {
            this.numInfo = line;
        } else if (line.startsWith('[AXS:')) {
            this.axsInfo = line;
        } else if (line.startsWith('[PLG:')) {
            this.plgInfo = line;
        } else if (line.startsWith('[EN:')) {
            this.enInfo = line;
        } else if (line.startsWith('[BOARD:')) {
            this.boardInfo = line.slice(7, -1);
        } else if (line === 'ok') {
            console.log('[ConfigWizard] $I+ collection complete');
            this._collectingVer = false;
            this._onVerComplete();
        }
        return true;
    }

    _isUnconfigured(name) {
        return name && name.toUpperCase() === 'UNCONFIGURED';
    }

    _decodeMachineConfig(configName) {
        if (!configName || !/^WB[A-Z]{7}$/.test(configName)) return null;

        const sizeMap = {
            A: '500 x 500',
            B: '750 x 750',
            C: '750 x 1000',
            D: '1000 x 1000',
            E: '1000 x 1500',
            F: '1500 x 1500',
            G: 'Custom'
        };
        const spindleMap = {
            A: 'WorkBee Router Head',
            B: 'Mafell FM 1000 (Digital)',
            C: 'Mafell FM 1000 (Manual)',
            D: 'VFD (0-10V)',
            E: 'VFD (Modbus)',
            F: 'PWM Laser Module'
        };
        const categoryMap = {
            A: 'Z1+',
            B: 'Z2',
            C: 'Custom'
        };

        const size = sizeMap[configName[2]] || 'Unknown size';
        const dust = configName[3] === 'A' ? 'Dust shoe' : 'No dust shoe';
        const enclosure = configName[4] === 'A' ? 'Enclosure' : 'No Enclosure';
        const spindle = spindleMap[configName[5]] || 'Unknown spindle';
        const laser = configName[6] === 'A' ? 'Laser fitted' : 'No laser';
        const probeMap = {
            A: 'Ooznest XYZ Probe',
            B: 'Custom probe',
            C: 'No probe'
        };
        const probe = probeMap[configName[7]] || 'Unknown probe';
        const category = categoryMap[configName[8]] || 'Unknown machine type';

        return `${category}, ${size}, ${spindle}, ${dust}, ${enclosure}, ${laser}, ${probe}`;
    }

    _onVerComplete() {
        console.log('[ConfigWizard] _onVerComplete', this.verInfo);
        if (!this.verInfo) return;
        this.renderInfoTab();
        if (this._isUnconfigured(this.verInfo.configName)) {
            setTimeout(() => this.showWizard(), 500);
        }
    }

    _parseVerLine(line) {
        this._verLines.push(line);
        const content = line.slice(1, -1);
        const colonIdx = content.indexOf(':');
        if (colonIdx === -1) return;
        const rest = content.slice(colonIdx + 1);
        const secondColon = rest.indexOf(':');
        let version, configName;
        if (secondColon === -1) {
            version = rest;
            configName = '';
        } else {
            version = rest.slice(0, secondColon);
            configName = rest.slice(secondColon + 1);
        }
        this.verInfo = { version, configName };
    }

    // --- Info Tab Rendering ---

    async renderInfoTab() {
        if (window.troubleshootingInfo?.render) {
            await window.troubleshootingInfo.render();
        }
    }

    // --- Wizard Modal ---

    showWizard() {
        console.log('[ConfigWizard] showWizard');
        this.wizardStep = 0;
        this.wizardData.machine = null;
        this.wizardData.toolheads = { spindle: null, vfdModbusEnabled: false, vfdModbus: null, laser: false };
        this.wizardData.dustShoe = false;
        this.wizardData.enclosure = false;
        this.wizardData.wifiMode = '0';
        this.wizardData.wifiSsid = '';
        this.wizardData.wifiPsk = '';
        this.wizardData.firmwareFlashed = false;
        this.wizardData.customWidth = 500;
        this.wizardData.customLength = 500;
        this.wizardData.customDrives = { x: 'belt', y: 'belt', z: 'belt' };
        this.wizardData.customBeltPitch = { x: 2, y: 2, z: 2 };
        this.wizardData.customPulleyTeeth = { x: 20, y: 20, z: 20 };
        this.wizardData.customLead = { x: 5, y: 5, z: 5 };
        this.wizardData.customEndstops = { x: 'min', y: 'min', z: 'min' };
        if (this.modal) {
            console.log('[ConfigWizard] Removing hidden class from overlay');
            this.modal.show();
        } else {
            console.warn('[ConfigWizard] overlay element not found');
        }
        this._renderWizardStep();
    }

    hideWizard() {
        console.log('[ConfigWizard] hideWizard');
        this.modal?.hide();
    }

    _renderWizardStep() {
        console.log('[ConfigWizard] _renderWizardStep step=' + this.wizardStep);
        const container = document.getElementById('config-wizard-body');
        const footer = document.getElementById('config-wizard-footer');
        if (!container) { console.warn('[ConfigWizard] config-wizard-body not found'); return; }
        if (!container || !footer) return;

        const steps = ['Machine', 'Toolhead', 'Probe Plate', 'Dust Shoe', 'Enclosure', 'WiFi Setup', 'Firmware', 'Apply'];
        const totalSteps = steps.length;

        let html = '';
        let footerHtml = '';

        // Step indicator
        html += '<div class="wizard-stepper wizard-stepper--compact mb-6 px-1">';
        steps.forEach((label, i) => {
            const isActive = i === this.wizardStep;
            const isDone = i < this.wizardStep;
            html += `<div class="wizard-stepper__item ${isActive ? 'is-active' : ''} ${isDone ? 'is-complete' : ''}">`;
            if (isDone) {
                html += '<span class="wizard-stepper__circle"><i data-lucide="check" style="width:16px;height:16px"></i></span>';
            } else {
                html += `<span class="wizard-stepper__circle">${i + 1}</span>`;
            }
            html += `<span class="wizard-stepper__label">${label}</span>`;
            html += '</div>';
        });
        html += '</div>';

        // Step content
        html += '<div>';
        switch (this.wizardStep) {
            case 0: html += this._renderMachineStep(); break;
            case 1: html += this._renderRouterStep(); break;
            case 2: html += this._renderProbePlateStep(); break;
            case 3: html += this._renderDustShoeStep(); break;
            case 4: html += this._renderEnclosureStep(); break;
            case 5: html += this._renderWifiSetupStep(); break;
            case 6: html += this._renderFirmwareStep(); break;
            case 7: html += this._renderApplyStep(); break;
        }
        html += '</div>';

        // Navigation buttons
        footerHtml += '<div class="flex w-full justify-between items-center gap-3">';
        if (this.wizardStep > 0) {
            footerHtml += `<button onclick="window.configWizard._prevStep()" class="btn btn-secondary">Back</button>`;
        } else {
            footerHtml += '<div></div>';
        }
        if (this.wizardStep < totalSteps - 1) {
            const disabled = !this._canProceed();
            footerHtml += `<button onclick="window.configWizard._nextStep()" class="btn btn-primary" ${disabled ? 'disabled' : ''}>Continue</button>`;
        } else {
            footerHtml += `<button onclick="window.configWizard._applyConfig()" class="btn btn-primary">Apply Configuration</button>`;
        }
        footerHtml += '</div>';

        container.innerHTML = html;
        footer.innerHTML = footerHtml;
        footer.classList.remove('hidden');
        this._wireStepEvents();
        if (window.lucide) window.lucide.createIcons();
    }

    _renderMachineStep() {
        if (!this.machines.length) {
            return '<div class="text-center py-8"><i data-lucide="refresh-cw" style="width:14px;height:14px"></i><p class="text-sm text-grey mt-2">Loading machines...</p></div>';
        }

        const cats = {
            'z1+': { label: 'WorkBee Z1+', icon: 'bi-tools', items: [] },
            'z2': { label: 'WorkBee Z2', icon: 'bi-tools', items: [] },
            custom: { label: 'Other', icon: 'bi-gear', items: [] }
        };
        this.machines.forEach(m => {
            if (cats[m.category]) cats[m.category].items.push(m);
        });

        let html = '<p class="text-sm text-grey mb-4">Select your CNC machine model:</p>';

        ['z1+', 'z2', 'custom'].forEach(catKey => {
            const cat = cats[catKey];
            if (!cat.items.length) return;

            const isExpanded = this._expandedMachineCat === catKey;
            html += `<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden mb-2">`;
            html += `<div class="config-filter-group__header flex items-center justify-between px-4 py-2.5 border-b border-grey-light cursor-pointer select-none transition-colors" onclick="window.configWizard._toggleMachineCategory('${catKey}')">`;
            html += `<span class="config-filter-group__title">${cat.label}</span>`;
            html += `<i class="config-filter-group__chevron bi ${isExpanded ? 'bi-chevron-up' : 'bi-chevron-down'}"></i>`;
            html += `</div>`;

            if (isExpanded) {
                html += `<div>`;
                cat.items.forEach(m => {
                    if (catKey === 'custom') {
                        const sel = this.wizardData.machine && this.wizardData.machine.id === m.id;
                        html += `<div class="config-filter-choice machine-select-item ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-machine-id="${m.id}">`;
                        html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
                        html += `<span class="config-filter-choice__label">${m.name}</span>`;
                        html += `</div>`;
                        if (sel) {
                            html += '<div class="px-4 pb-3 space-y-2">';
                            ['X', 'Y', 'Z'].forEach(axis => {
                                const lc = axis.toLowerCase();
                                const drive = (this.wizardData.customDrives || {})[lc] || 'belt';
                                const pitch = (this.wizardData.customBeltPitch || {})[lc] || 2;
                                const teeth = (this.wizardData.customPulleyTeeth || {})[lc] || 20;
                                const lead = (this.wizardData.customLead || {})[lc] || 5;
                                const endstop = (this.wizardData.customEndstops || {})[lc] || 'min';
                                html += '<div class="bg-white rounded-xl shadow-soft border border-grey-light p-3">';
                                html += `<div class="font-bold text-xs text-secondary-dark mb-2">${axis} Axis</div>`;
                                html += '<div class="grid grid-cols-2 gap-x-3 gap-y-2">';
                                html += '<div><label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-0.5">Drive</label>';
                                html += `<select onchange="window.configWizard.wizardData.customDrives.${lc}=this.value;window.configWizard._renderWizardStep()" class="ooznest-select oz-select w-full text-xs">`;
                                html += `<option value="belt" ${drive === 'belt' ? 'selected' : ''}>Belt</option>`;
                                html += `<option value="leadscrew" ${drive === 'leadscrew' ? 'selected' : ''}>Leadscrew</option>`;
                                html += '</select></div>';
                                html += '<div><label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-0.5">Travel (mm)</label>';
                                html += `<input type="number" step="1" id="w-custom-travel-${lc}" value="${(this.wizardData.machine.travel || {})[lc] || 0}" placeholder="e.g. 270" class="ooznest-field input-field w-full">`;
                                html += '</div>';
                                if (drive === 'belt') {
                                    html += '<div><label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-0.5">Belt pitch (mm)</label>';
                                    html += `<input type="number" step="0.1" value="${pitch}" onchange="window.configWizard.wizardData.customBeltPitch.${lc}=parseFloat(this.value)||2" class="ooznest-field input-field w-full">`;
                                    html += '</div>';
                                    html += '<div><label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-0.5">Pulley teeth</label>';
                                    html += `<input type="number" step="1" value="${teeth}" onchange="window.configWizard.wizardData.customPulleyTeeth.${lc}=parseInt(this.value)||20" class="ooznest-field input-field w-full">`;
                                    html += '</div>';
                                } else {
                                    html += '<div><label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-0.5">Lead (mm/rev)</label>';
                                    html += `<input type="number" step="0.1" value="${lead}" onchange="window.configWizard.wizardData.customLead.${lc}=parseFloat(this.value)||5" class="ooznest-field input-field w-full">`;
                                    html += '</div><div></div>';
                                }
                                html += '<div class="col-span-2"><label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-0.5">Endstop</label>';
                                html += `<select onchange="window.configWizard.wizardData.customEndstops.${lc}=this.value" class="ooznest-select oz-select w-full text-xs">`;
                                html += `<option value="min" ${endstop === 'min' ? 'selected' : ''}>${axis} min</option>`;
                                html += `<option value="max" ${endstop === 'max' ? 'selected' : ''}>${axis} max</option>`;
                                html += '</select></div>';
                                html += '</div></div>';
                            });
                            html += '</div>';
                        }
                    } else {
                        const sel = this.wizardData.machine && this.wizardData.machine.id === m.id;
                        html += `<div class="config-filter-choice machine-select-item ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-machine-id="${m.id}">`;
                        html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
                        html += `<span class="config-filter-choice__label">${m.name}</span>`;
                        html += `</div>`;
                    }
                });

                // Z2 custom size option
                if (catKey === 'z2') {
                    const isCustomSize = this.wizardData.machine && this.wizardData.machine.id === 'z2-custom';
                    html += `<div class="config-filter-choice machine-select-item ${isCustomSize ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-machine-id="z2-custom">`;
                    html += `<div class="config-filter-choice__control ${isCustomSize ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${isCustomSize ? 'bg-white' : ''}"></div></div>`;
                    html += `<span class="config-filter-choice__label">Custom Size</span>`;
                    html += `</div>`;
                    if (isCustomSize) {
                        html += '<div class="px-4 pb-3 space-y-2">';
                        html += '<label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-0.5">Width (mm)</label>';
                        html += `<input type="number" step="1" id="w-custom-width" value="${this.wizardData.customWidth || 500}" placeholder="e.g. 500" oninput="document.getElementById('w-custom-area').textContent=this.value&&document.getElementById('w-custom-length').value?'('+(Math.max(0,parseInt(this.value)-230))+'×'+(Math.max(0,parseInt(document.getElementById('w-custom-length').value)-230))+'×88mm)':''" class="ooznest-field input-field w-full">`;
                        html += '<label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-0.5 mt-2">Length (mm)</label>';
                        html += `<input type="number" step="1" id="w-custom-length" value="${this.wizardData.customLength || 500}" placeholder="e.g. 500" oninput="document.getElementById('w-custom-area').textContent=document.getElementById('w-custom-width').value&&this.value?'('+(Math.max(0,parseInt(document.getElementById('w-custom-width').value)-230))+'×'+(Math.max(0,parseInt(this.value)-230))+'×88mm)':''" class="ooznest-field input-field w-full">`;
                        html += `<p id="w-custom-area" class="text-[10px] text-grey italic">${this.wizardData.customWidth && this.wizardData.customLength ? `(${Math.max(0, this.wizardData.customWidth - 230)}×${Math.max(0, this.wizardData.customLength - 230)}×88mm)` : ''}</p>`;
                        html += '</div>';
                    }
                }

                html += `</div>`;
            }

            html += `</div>`;
        });

        return html;
    }

    _renderRouterStep() {
        const machine = this.wizardData.machine;
        if (!machine || !machine.routers || !machine.routers.length) {
            return '<p class="text-sm text-grey">No toolhead options for this machine.</p>';
        }

        const th = this.wizardData.toolheads;
        const spindleDefs = {};
        machine.routers.forEach(r => { spindleDefs[r.id] = this.spindles[r.id] || {}; });

        const cats = {
            spindle: { label: 'Spindle / Router', icon: 'bi-tools', items: [] },
            'vfd-modbus': { label: 'VFD Modbus', icon: 'bi-speedometer2', items: [] },
            laser: { label: 'Laser', icon: 'bi-brightness-high', items: [] }
        };

        machine.routers.forEach(r => {
            const def = spindleDefs[r.id] || {};
            let cat = def.category || 'spindle';
            if (cat === 'router') cat = 'spindle';
            if (cats[cat]) cats[cat].items.push(r);
        });

        let html = '<p class="text-sm text-grey mb-4">Select your toolheads:</p>';

        ['spindle', 'vfd-modbus', 'laser'].forEach(catKey => {
            const cat = cats[catKey];
            if (!cat.items.length) return;

            const isExpanded = this._expandedCat === catKey;
            html += `<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden mb-2">`;
            html += `<div class="config-filter-group__header flex items-center justify-between px-4 py-2.5 border-b border-grey-light cursor-pointer select-none transition-colors" onclick="window.configWizard._toggleCategory('${catKey}')">`;
            html += `<span class="config-filter-group__title">${cat.label}</span>`;
            html += `<i class="config-filter-group__chevron bi ${isExpanded ? 'bi-chevron-up' : 'bi-chevron-down'}"></i>`;
            html += `</div>`;

            if (isExpanded) {
                html += `<div>`;
                cat.items.forEach(r => {
                    if (catKey === 'laser') {
                        const checked = th.laser;
                        html += `<label class="config-filter-choice flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer">`;
                        html += `<input type="checkbox" ${checked ? 'checked' : ''} onchange="window.configWizard.wizardData.toolheads.laser = this.checked; window.configWizard._renderWizardStep()" class="accent-primary rounded shrink-0" style="width:16px;height:16px;min-height:16px;padding:0;border:0;box-shadow:none;background:transparent;flex:0 0 auto;">`;
                        html += `<span class="config-filter-choice__label">${r.name}</span>`;
                        html += `</label>`;
                    } else if (catKey === 'vfd-modbus') {
                        const checked = th.vfdModbusEnabled;
                        html += `<label class="config-filter-choice flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer">`;
                        html += `<input type="checkbox" ${checked ? 'checked' : ''} onchange="window.configWizard.wizardData.toolheads.vfdModbusEnabled = this.checked; if(!this.checked)window.configWizard.wizardData.toolheads.vfdModbus=null; window.configWizard._renderWizardStep()" class="accent-primary rounded shrink-0" style="width:16px;height:16px;min-height:16px;padding:0;border:0;box-shadow:none;background:transparent;flex:0 0 auto;">`;
                        html += `<span class="config-filter-choice__label">${r.name}</span>`;
                        html += `</label>`;
                        // Modbus protocol sub-select
                        if (checked) {
                            html += '<div class="px-4 pb-3 bg-grey-bg/30">';
                            html += '<label class="ooznest-label config-filter-subtitle block mb-1.5 mt-1">Modbus Protocol</label>';
                            html += '<div class="grid gap-1">';
                            Object.entries(this.modbusProtocols).forEach(([key, proto]) => {
                                const sel = th.vfdModbus === key;
                                html += `<div class="modbus-select-item config-filter-choice ${sel ? 'is-selected' : ''} flex items-center gap-2 px-2.5 py-1.5 rounded border cursor-pointer transition-all" data-modbus-key="${key}">`;
                                html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-3 h-3 rounded-full flex items-center justify-center"><div class="w-1 h-1 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
                                html += `<span class="config-filter-choice__label config-filter-choice__label--compact">${proto.name}</span>`;
                                html += `<span class="text-[10px] text-grey ml-auto">$$396=${proto['$396']}</span>`;
                                html += `</div>`;
                            });
                            html += '</div></div>';
                        }
                    } else {
                        const selected = th.spindle === r.id;
                        html += `<div class="config-filter-choice ${selected ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer toolhead-option" data-id="${r.id}">`;
                        html += `<div class="config-filter-choice__control ${selected ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${selected ? 'bg-white' : ''}"></div></div>`;
                        html += `<span class="config-filter-choice__label">${r.name}</span>`;
                        html += `</div>`;
                    }
                });
                html += `</div>`;
            }

            html += `</div>`;
        });

        return html;
    }

    _toggleCategory(catKey) {
        this._expandedCat = this._expandedCat === catKey ? null : catKey;
        this._renderWizardStep();
    }

    _toggleMachineCategory(catKey) {
        this._expandedMachineCat = this._expandedMachineCat === catKey ? null : catKey;
        this._renderWizardStep();
    }

    _calcStepsPerMM(axis, machine) {
        if (machine.category !== 'custom') return 400;
        const drive = (machine.customDrives || {})[axis] || 'belt';
        if (drive === 'leadscrew') {
            const lead = (machine.customLead || {})[axis] || 5;
            return Math.round(1600 / lead);
        }
        const pitch = (machine.customBeltPitch || {})[axis] || 2;
        const teeth = (machine.customPulleyTeeth || {})[axis] || 20;
        return Math.round(1600 / (pitch * teeth)) || 40;
    }

    _getMachineConfig(machine) {
        if (!machine || !machine.travel) return '';
        const t = machine.travel;
        const axes = ['x','y','z'];
        const lines = [];
        axes.forEach((axis, i) => {
            const s = this._calcStepsPerMM(axis, machine);
            lines.push(`$${100 + i}=${s.toFixed(3)}`);
        });
        axes.forEach((axis, i) => {
            const val = t[axis] || 0;
            lines.push(`$${130 + i}=${val.toFixed(3)}`);
        });
        ['$140=1.400', '$141=1.400', '$142=1.400'].forEach(line => lines.push(line));
        return this._syncGangedYAxisSteps(lines).join('\n');
    }

    _syncGangedYAxisSteps(lines = []) {
        // Only send $103 if the controller actually supports Y2 (ganged Y)
        if (!window.grblSettings?.settings['103']) return lines;

        const y1Line = lines.find(line => line.startsWith('$101='));
        if (!y1Line) return lines;

        const y1Value = y1Line.split('=')[1];
        const y2Index = lines.findIndex(line => line.startsWith('$103='));
        if (y2Index >= 0) {
            lines[y2Index] = `$103=${y1Value}`;
        } else {
            lines.splice(2, 0, `$103=${y1Value}`);
        }

        return lines;
    }

    _computeToolheadAssignments() {
        const th = this.wizardData.toolheads;
        const result = {};
        const hasSpindle = th.spindle !== null;
        const hasLaser = th.laser;
        const hasModbus = th.vfdModbusEnabled;

        if (!hasSpindle && !hasLaser && !hasModbus) return result;

        const spindleDef = hasSpindle ? this.spindles[th.spindle] : null;
        const laserDef = this.spindles['laser-pwm'];
        const modbusDef = this.spindles['vfd-modbus'];

        if (hasSpindle && spindleDef) {
            result['$395'] = { name: spindleDef.name, value: spindleDef.value };
        }
        if (hasLaser && laserDef) {
            result['$511'] = { name: laserDef.name, value: laserDef.value };
        }
        if (hasModbus && modbusDef) {
            result['$512'] = { name: modbusDef.name, value: modbusDef.value };
        }

        return result;
    }

    _renderProbePlateStep() {
        const s = this.store.data.probe;
        const selected = this.wizardData.probeType;
        let html = '<p class="text-sm text-grey mb-4">Select your probe plate:</p>';
        html += '<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden">';
        html += '<div>';
        [
            { value: 'ooznest', label: 'Ooznest XYZ Probe' },
            { value: 'custom', label: 'Custom Probe' },
            { value: 'none', label: 'No Probe' }
        ].forEach(opt => {
            const sel = selected === opt.value;
            html += `<div class="probe-option config-filter-choice ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-value="${opt.value}">`;
            html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
            html += `<span class="config-filter-choice__label">${opt.label}</span>`;
            html += '</div>';
            if (sel && opt.value === 'custom') {
                html += '<div class="px-4 pb-3 bg-grey-bg/30">';
                html += '<div class="grid grid-cols-2 gap-4">';
                html += '<div>';
                html += '<label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-1">Plate Thickness (mm)</label>';
                html += `<input type="number" step="0.1" id="wizard-plate-thickness" value="${s.plateThickness || 5}" class="ooznest-field input-field w-full">`;
                html += '</div>';
                html += '<div>';
                html += '<label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-1">XY Plate Offset (mm)</label>';
                html += `<input type="number" step="0.1" id="wizard-plate-offset" value="${s.xyPlateOffset || 10}" class="ooznest-field input-field w-full">`;
                html += '</div>';
                html += '</div>';
                html += '</div>';
            }
        });
        html += '</div>';
        html += '</div>';

        // Description
        if (selected === 'ooznest') {
            html += '<p class="text-[10px] text-grey mt-3"><i data-lucide="info" style="width:14px;height:14px"></i> Ooznest XYZ Probe: thickness 10mm, XY offset 10mm. These will be set automatically in your probe settings.</p>';
        } else if (selected === 'custom') {
            html += '<p class="text-[10px] text-grey mt-3"><i data-lucide="info" style="width:14px;height:14px"></i> Enter your custom probe plate dimensions above.</p>';
        } else {
            html += '<p class="text-[10px] text-grey mt-3"><i data-lucide="info" style="width:14px;height:14px"></i> No probe plate will be configured.</p>';
        }

        return html;
    }

    _renderDustShoeStep() {
        const selected = this.wizardData.dustShoe;
        let html = '<p class="text-sm text-grey mb-4">Do you have a dust shoe?</p>';
        html += '<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden">';
        html += '<div>';
        [
            { value: true, label: 'Yes, I have one' },
            { value: false, label: 'No Dust Shoe' }
        ].forEach(opt => {
            const sel = selected === opt.value;
            html += `<div class="dust-shoe-option config-filter-choice ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-value="${opt.value}">`;
            html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
            html += `<span class="config-filter-choice__label">${opt.label}</span>`;
            html += '</div>';
        });
        html += '</div>';
        html += '</div>';
        return html;
    }

    _renderEnclosureStep() {
        const selected = this.wizardData.enclosure;
        let html = '<p class="text-sm text-grey mb-4">Do you have a <a href="https://ooznest.co.uk/product/original-workbee-enclosure/" target="_blank" class="text-primary hover:underline">WorkBee Enclosure</a>? </p>';
        html += '<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden">';
        html += '<div>';
        [
            { value: true, label: 'Yes, WorkBee Enclosure' },
            { value: false, label: 'No Enclosure' }
        ].forEach(opt => {
            const sel = selected === opt.value;
            html += `<div class="enclosure-option config-filter-choice ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-value="${opt.value}">`;
            html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
            html += `<span class="config-filter-choice__label">${opt.label}</span>`;
            html += '</div>';
        });
        html += '</div>';
        html += '</div>';
        return html;
    }

    _renderWifiSetupStep() {
        const isStation = this.wizardData.wifiMode === '1';
        let html = '<p class="text-sm text-grey mb-4">Configure the controller network mode.</p>';
        html += '<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden">';
        html += '<div>';
        [
            { value: '0', label: 'Wifi Off / Ethernet (Optional)' },
            { value: '1', label: 'Wifi Enabled' }
        ].forEach(opt => {
            const sel = this.wizardData.wifiMode === opt.value;
            html += `<div class="wifi-mode-option config-filter-choice ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-value="${opt.value}">`;
            html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
            html += `<span class="config-filter-choice__label">${opt.label}</span>`;
            html += '</div>';
        });
        if (isStation) {
            html += '<div class="px-4 py-3 bg-grey-bg/30 space-y-4">';
            html += '<div>';
            html += '<label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-1.5">Wifi Network Name ($74)</label>';
            html += `<input type="text" maxlength="64" value="${this._escapeHtml(this.wizardData.wifiSsid || '')}" oninput="window.configWizard.wizardData.wifiSsid=this.value" class="ooznest-field input-field w-full" placeholder="WiFi network name">`;
            html += '</div>';
            html += '<div>';
            html += '<label class="ooznest-label block text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-1.5">Wifi Password ($75)</label>';
            html += `<input type="password" minlength="8" maxlength="32" value="${this._escapeHtml(this.wizardData.wifiPsk || '')}" oninput="window.configWizard.wizardData.wifiPsk=this.value" class="ooznest-field input-field w-full" placeholder="8 to 32 characters">`;
            html += '</div>';
            html += '</div>';
        }
        html += '</div>';
        html += '</div>';

        html += '<p class="text-[10px] text-grey">';
        html += isStation
            ? 'Station mode will save the SSID and password to the controller.'
            : 'Use this when networking is handled over Ethernet, or when WiFi should remain disabled.';
        html += '</p>';
        html += '</div>';
        return html;
    }

    _getFirmwareForMachine() {
        const category = this.wizardData.machine?.category;
        if (category === 'z1+') return { key: 'firmwarez1', label: 'WorkBee Z1+' };
        if (category === 'z2') return { key: 'firmwarez2', label: 'WorkBee Z2' };
        return null;
    }

    _renderFirmwareStep() {
        const firmware = this._getFirmwareForMachine();
        if (!firmware) {
            return '<div class="p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-start gap-2"><i data-lucide="info" style="width:14px;height:14px"></i><p class="text-xs text-blue-700">Firmware flashing is not available for custom machines. Continue to review and apply the configuration.</p></div>';
        }

        let html = '<p class="text-sm text-grey mb-4">Flash firmware before applying your configuration.</p>';
        html += '<div class="bg-grey-bg rounded-lg p-4 space-y-3 border border-grey-light">';
        html += `<div class="flex justify-between"><span class="text-xs text-grey">Firmware</span><span class="text-xs font-bold text-secondary-dark">${firmware.label}</span></div>`;
        html += '<p class="text-xs text-grey">Flashing restores the controller settings, so it must finish successfully before this wizard applies your configuration.</p></div>';
        if (this.wizardData.firmwareFlashed) {
            html += '<div class="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-start gap-2"><i data-lucide="check-circle" style="width:14px;height:14px"></i><p class="text-xs text-green-700">Firmware flashed successfully. Continue to review and apply your configuration.</p></div>';
        } else {
            html += '<button id="config-wizard-flash-firmware" class="btn btn-primary mt-4"><i data-lucide="cpu"></i> Flash ' + firmware.label + ' Firmware</button>';
            html += '<p class="text-[10px] text-grey mt-2">The firmware selection is based on the machine selected in this wizard.</p>';
        }
        return html;
    }

    _renderApplyStep() {
        const machine = this.wizardData.machine;
        const th = this.wizardData.toolheads;
        const assignments = this._computeToolheadAssignments();
        const modbusKey = th.vfdModbus;
        const modbusProto = modbusKey ? this.modbusProtocols[modbusKey] : null;
        const wifiLines = this._getWifiConfigLines();

        let html = '<p class="text-sm text-grey mb-4">Review your configuration before applying:</p>';
        html += '<div class="bg-grey-bg rounded-lg p-4 space-y-3 border border-grey-light">';

        if (machine) {
            html += `<div class="flex justify-between"><span class="text-xs text-grey">Machine</span><span class="text-xs font-bold text-secondary-dark">${machine.name}</span></div>`;
        }

        // Toolhead assignments
        if (Object.keys(assignments).length) {
            const labels = { '$395': 'Primary', '$511': 'Secondary', '$512': 'Tertiary' };
            html += '<div class="border-t border-grey-light pt-2"></div>';
            Object.entries(assignments).forEach(([setting, info]) => {
                const label = labels[setting] || setting;
                html += `<div class="flex justify-between"><span class="text-xs text-grey">${label}</span><span class="text-xs font-bold text-secondary-dark">${info.name}</span></div>`;
            });
        }
        if (modbusProto) {
            html += `<div class="flex justify-between"><span class="text-xs text-grey">Modbus Protocol</span><span class="text-xs font-bold text-secondary-dark">${modbusProto.name} ($396=${modbusProto['$396']})</span></div>`;
        }

        html += '<div class="border-t border-grey-light pt-2"></div>';
        const probeLabel = this.wizardData.probeType === 'ooznest'
            ? 'Ooznest XYZ Probe'
            : this.wizardData.probeType === 'custom'
                ? 'Custom'
                : 'None';
        html += `<div class="flex justify-between"><span class="text-xs text-grey">Probe</span><span class="text-xs font-bold text-secondary-dark">${probeLabel}</span></div>`;
        html += `<div class="flex justify-between"><span class="text-xs text-grey">Dust Shoe</span><span class="text-xs font-bold ${this.wizardData.dustShoe ? 'text-green-600' : 'text-grey'}">${this.wizardData.dustShoe ? 'Yes' : 'No'}</span></div>`;
        html += `<div class="flex justify-between"><span class="text-xs text-grey">Enclosure</span><span class="text-xs font-bold ${this.wizardData.enclosure ? 'text-green-600' : 'text-grey'}">${this.wizardData.enclosure ? 'WorkBee Enclosure' : 'No Enclosure'}</span></div>`;
        html += `<div class="flex justify-between"><span class="text-xs text-grey">WiFi Mode</span><span class="text-xs font-bold text-secondary-dark">${this.wizardData.wifiMode === '1' ? 'Wifi Enabled' : 'Wifi Off / Ethernet (Optional)'}</span></div>`;
        if (this.wizardData.wifiMode === '1') {
            html += `<div class="flex justify-between"><span class="text-xs text-grey">Wifi Network Name</span><span class="text-xs font-bold text-secondary-dark">${this._escapeHtml(this.wizardData.wifiSsid || '')}</span></div>`;
        }

        html += '</div>';

        if (machine) {
            const configLines = this._getMachineConfig(machine).split('\n').filter(l => l.trim());
            const totalSettings = configLines.length + wifiLines.length;
            html += `<div class="mt-3"><p class="text-[10px] font-bold text-grey-dark uppercase tracking-wider mb-1">Grbl Settings to apply (${totalSettings} settings)</p>`;
            html += `<div class="bg-white border border-grey-light rounded-lg p-2 max-h-32 overflow-y-auto text-[10px] font-mono text-grey-dark leading-relaxed">`;
            html += configLines.concat(wifiLines).map(l => `<div>${this._escapeHtml(l)}</div>`).join('');
            html += '</div></div>';
        }

        html += '<div class="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">';
        html += '<i data-lucide="triangle-alert" style="width:14px;height:14px"></i>';
        html += '<p class="text-[10px] text-amber-700">This will overwrite your current Grbl settings and perform a soft reset. Make sure you have a backup of your current configuration.</p>';
        html += '</div>';
        html += '<div id="config-wizard-status" class="mt-4"></div>';

        return html;
    }

    _wireStepEvents() {
        // Machine selection
        document.querySelectorAll('.machine-select-item').forEach(el => {
            el.onclick = () => {
                const id = el.dataset.machineId;
                if (id === 'z2-custom') {
                    this.wizardData.customWidth = this.wizardData.customWidth || 500;
                    this.wizardData.customLength = this.wizardData.customLength || 500;
                    const z2Template = this.machines.find(m => m.category === 'z2');
                    this.wizardData.machine = {
                        id: 'z2-custom',
                        name: 'Custom Size',
                        category: 'z2',
                        travel: { x: 0, y: 0, z: 88 },
                        routers: z2Template ? [...z2Template.routers] : []
                    };
                } else {
                    this.wizardData.machine = this.machines.find(m => m.id === id) || null;
                }
                this.wizardData.firmwareFlashed = false;
                this.wizardData.toolheads = { spindle: null, vfdModbusEnabled: false, vfdModbus: null, laser: false };
                this._renderWizardStep();
            };
        });

        // Toolhead selection (radio-style for spindle options)
        document.querySelectorAll('.toolhead-option').forEach(el => {
            el.onclick = () => {
                const id = el.dataset.id;
                this.wizardData.toolheads.spindle = this.wizardData.toolheads.spindle === id ? null : id;
                this._renderWizardStep();
            };
        });

        // Probe selection
        document.querySelectorAll('.probe-option').forEach(el => {
            el.onclick = () => {
                this._onProbeTypeChange(el.dataset.value);
            };
        });

        // Modbus protocol selection
        document.querySelectorAll('.modbus-select-item').forEach(el => {
            el.onclick = () => {
                this.wizardData.toolheads.vfdModbus = el.dataset.modbusKey;
                this._renderWizardStep();
            };
        });

        // Dust shoe selection
        document.querySelectorAll('.dust-shoe-option').forEach(el => {
            el.onclick = () => {
                this.wizardData.dustShoe = el.dataset.value === 'true';
                this._renderWizardStep();
            };
        });

        // Enclosure selection
        document.querySelectorAll('.enclosure-option').forEach(el => {
            el.onclick = () => {
                this.wizardData.enclosure = el.dataset.value === 'true';
                this._renderWizardStep();
            };
        });

        // WiFi mode selection
        document.querySelectorAll('.wifi-mode-option').forEach(el => {
            el.onclick = () => {
                this.wizardData.wifiMode = el.dataset.value;
                this._renderWizardStep();
            };
        });

        const flashButton = document.getElementById('config-wizard-flash-firmware');
        if (flashButton) {
            flashButton.onclick = () => {
                const firmware = this._getFirmwareForMachine();
                if (!firmware || !window.firmwareFlasher) return;
                window.firmwareFlasher.showModal({
                    firmwareKey: firmware.key,
                    lockSelection: true,
                    onFlashComplete: (firmwareKey) => {
                        if (firmwareKey !== this._getFirmwareForMachine()?.key) return;
                        this.wizardData.firmwareFlashed = true;
                        this._renderWizardStep();
                    }
                });
            };
        }
    }

    _canProceed() {
        switch (this.wizardStep) {
            case 0: {
                const m = this.wizardData.machine;
                if (!m) return false;
                if (m.id === 'z2-custom') {
                    const w = parseFloat(document.getElementById('w-custom-width')?.value) || 0;
                    const l = parseFloat(document.getElementById('w-custom-length')?.value) || 0;
                    return w >= 100 && l >= 100;
                }
                if (m.category === 'custom') {
                    const x = parseFloat(document.getElementById('w-custom-travel-x')?.value) || 0;
                    const y = parseFloat(document.getElementById('w-custom-travel-y')?.value) || 0;
                    const z = parseFloat(document.getElementById('w-custom-travel-z')?.value) || 0;
                    return x > 0 && y > 0 && z > 0;
                }
                return true;
            }
            case 1: {
                const th = this.wizardData.toolheads;
                const hasAny = th.spindle !== null || th.vfdModbusEnabled || th.laser;
                if (!hasAny) return false;
                if (th.vfdModbusEnabled && !th.vfdModbus) return false;
                return true;
            }
            case 5: {
                if (this.wizardData.wifiMode !== '1') return true;
                const ssid = (this.wizardData.wifiSsid || '').trim();
                const psk = this.wizardData.wifiPsk || '';
                return ssid.length > 0 && psk.length >= 8 && psk.length <= 32;
            }
            case 6:
                return this.wizardData.machine?.category === 'custom' || this.wizardData.firmwareFlashed;
            default: return true;
        }
    }

    _onProbeTypeChange(value) {
        this.wizardData.probeType = value;
        if (value === 'ooznest') {
            this.wizardData.plateThickness = 5;
            this.wizardData.xyPlateOffset = 10;
        }
        this._renderWizardStep();
    }

    _nextStep() {
        // Capture form values before moving
        if (this.wizardStep === 0) {
            const m = this.wizardData.machine;
            if (m && m.id === 'z2-custom') {
                const width = parseFloat(document.getElementById('w-custom-width')?.value) || 500;
                const length = parseFloat(document.getElementById('w-custom-length')?.value) || 500;
                this.wizardData.customWidth = width;
                this.wizardData.customLength = length;
                const x = Math.max(0, width - 230);
                const y = Math.max(0, length - 230);
                m.travel = { x, y, z: 88 };
                m.name = `${width}×${length}mm`;
            } else if (m && m.category === 'custom') {
                const x = parseFloat(document.getElementById('w-custom-travel-x')?.value) || 0;
                const y = parseFloat(document.getElementById('w-custom-travel-y')?.value) || 0;
                const z = parseFloat(document.getElementById('w-custom-travel-z')?.value) || 0;
                m.travel = { x, y, z };
                // Store custom drive config for later use
                m.customDrives = { ...this.wizardData.customDrives };
                m.customBeltPitch = { ...this.wizardData.customBeltPitch };
                m.customPulleyTeeth = { ...this.wizardData.customPulleyTeeth };
                m.customLead = { ...this.wizardData.customLead };
                m.customEndstops = { ...this.wizardData.customEndstops };
            }
        }
        if (this.wizardStep === 2) {
            if (this.wizardData.probeType === 'custom') {
                const thick = document.getElementById('wizard-plate-thickness');
                const offset = document.getElementById('wizard-plate-offset');
                if (thick) this.wizardData.plateThickness = parseFloat(thick.value) || 5;
                if (offset) this.wizardData.xyPlateOffset = parseFloat(offset.value) || 10;
            } else if (this.wizardData.probeType === 'ooznest') {
                this.wizardData.plateThickness = 5;
                this.wizardData.xyPlateOffset = 10;
            }
        }
        this.wizardStep++;
        this._renderWizardStep();
    }

    _prevStep() {
        if (this.wizardStep > 0) {
            this.wizardStep--;
            this._renderWizardStep();
        }
    }

    async _applyConfig() {
        const machine = this.wizardData.machine;
        if (!machine || !this.ws || !this.ws.isConnected) {
            this._showWizardStatus('Cannot apply config: not connected.', 'error');
            return;
        }
        if (this._getFirmwareForMachine() && !this.wizardData.firmwareFlashed) {
            this._showWizardStatus('Flash firmware successfully before applying configuration.', 'error');
            return;
        }

        // Save probe plate settings
        this.store.set('probe.plateThickness', this.wizardData.plateThickness);
        this.store.set('probe.xyPlateOffset', this.wizardData.xyPlateOffset);
        this.store.set('probe.type', this.wizardData.probeType || 'ooznest');
        this.store.set('configWizardRan', true);
        if (window.probeHandler) window.probeHandler.renderSettings();

        // Save dust shoe and enclosure for future use
        this.store.set('machine.dustShoe', this.wizardData.dustShoe);
        this.store.set('machine.enclosure', this.wizardData.enclosure);
        this.store.set('machine.wifi', JSON.stringify({
            mode: this.wizardData.wifiMode,
            ssid: this.wizardData.wifiSsid
        }));

        // Apply grbl settings
        const configLines = this._getMachineConfig(machine).split('\n').filter(l => l.trim());
        const wifiLines = this._getWifiConfigLines();
        const allConfigLines = configLines.concat(wifiLines);
        this._showWizardStatus(`Applying ${allConfigLines.length} settings...`, 'info');

        try {
            for (let i = 0; i < allConfigLines.length; i++) {
                const line = allConfigLines[i].trim();
                if (!line) continue;
                if (i % 10 === 0) {
                    this._showWizardStatus(`Setting ${i + 1} of ${allConfigLines.length}...`, 'info');
                    await this._sleep(10);
                }
                await this.ws.sendCommand(line);
                await this._sleep(15);
            }

            // Apply toolhead assignments ($395 primary, $511 secondary, $512 tertiary)
            const assignments = this._computeToolheadAssignments();
            for (const [setting, info] of Object.entries(assignments)) {
                await this.ws.sendCommand(`${setting}=${info.value}`);
                await this._sleep(15);
            }

            // Enable probe ($6=1)
            await this.ws.sendCommand('$6=1');
            await this._sleep(15);

            // Apply modbus protocol $396 setting
            const modbusKey = this.wizardData.toolheads.vfdModbus;
            if (modbusKey) {
                const modbusProto = this.modbusProtocols[modbusKey];
                if (modbusProto && modbusProto['$396'] !== undefined) {
                    await this.ws.sendCommand(`$396=${modbusProto['$396']}`);
                    await this._sleep(15);
                }
            }

            // Save machine config name to store
            this.store.set('machine.id', machine.id);
            this.store.set('machine.name', machine.name);
            this.store.set('machine.toolheads', JSON.stringify(this.wizardData.toolheads));

            // Mark configured — send short WB code before soft reset so GRBL saves it to flash
            // WB code format: WB{size}{dust}{encl}{spindle}{laser}{probe}{cat}
            //   Pos 1-2: "WB" prefix
            //   Pos 3 (size):  A=500x500, B=750x750, C=750x1000, D=1000x1000, E=1000x1500, F=1500x1500, G=Custom
            //   Pos 4 (dust):  A=with dust shoe, B=without
            //   Pos 5 (encl):  A=with enclosure, B=without
            //   Pos 6 (spindle): A=WorkBee Router Head, B=Mafell FM 1000 (Digital), C=Mafell FM 1000 (Manual),
            //                    D=VFD (0-10v), E=VFD (Modbus), F=PWM Laser Module
            //   Pos 7 (laser): A=yes, B=no
            //   Pos 8 (probe): A=Ooznest XYZ Probe, B=Custom Probe, C=None
            //   Pos 9 (cat):   A=Z1+, B=Z2, C=Custom
            const th = this.wizardData.toolheads;
            const sizeCodes = { '500x500':'A', '750x750':'B', '750x1000':'C', '1000x1000':'D', '1000x1500':'E', '1500x1500':'F' };
            const catCodes = { 'z1+':'A', 'z2':'B', 'custom':'C' };
            const spindleCodes = { 'workbee-router-head':'A', 'mafell-digital':'B', 'mafell-manual':'C', 'vfd-0-10v':'D', 'vfd-modbus':'E', 'laser-pwm':'F' };
            const sizePart = machine.id.split('-').slice(1).join('-') || 'custom';
            const szCode = sizeCodes[sizePart] || 'G';
            const catCode = catCodes[machine.category] || 'C';
            const spCode = spindleCodes[th.spindle] || 'A';
            const dustCode = this.wizardData.dustShoe ? 'A' : 'B';
            const encCode = this.wizardData.enclosure ? 'A' : 'B';
            const lasCode = th.laser ? 'A' : 'B';
            const probeCodes = { ooznest: 'A', custom: 'B', none: 'C' };
            const prbCode = probeCodes[this.wizardData.probeType] || 'A';
            const wbCode = `WB${szCode}${dustCode}${encCode}${spCode}${lasCode}${prbCode}${catCode}`;
            await this.ws.sendCommand(`$I=${wbCode}`);

            this._showWizardStatus('All settings applied! Performing soft reset...', 'success');

            // Soft reset
            await this._sleep(500);
            this.ws.sendRealtime('\x18');

            // Update viewer with new machine limits
            if (window.viewer) {
                window.viewer.setMachineLimits(machine.travel.x, machine.travel.y, machine.travel.z);
            }

            this.hideWizard();

        } catch (e) {
            this._showWizardStatus(`Error applying config: ${e.message}`, 'error');
        }
    }

    _showWizardStatus(msg, type) {
        const el = document.getElementById('config-wizard-status');
        if (!el) return;
        if (type === 'error') {
            el.innerHTML = `<div class="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-center gap-2"><i data-lucide="x-circle" style="width:14px;height:14px"></i> ${msg}</div>`;
        } else if (type === 'success') {
            el.innerHTML = `<div class="p-3 bg-green-50 border border-green-200 rounded-lg text-xs text-green-700 flex items-center gap-2"><i data-lucide="check-circle" style="width:14px;height:14px"></i> ${msg}</div>`;
        } else {
            el.innerHTML = `<div class="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700 flex items-center gap-2"><i data-lucide="info" style="width:14px;height:14px"></i> ${msg}</div>`;
        }
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _getWifiConfigLines() {
        const lines = [`$73=${this.wizardData.wifiMode || '0'}`];
        if ((this.wizardData.wifiMode || '0') === '1') {
            lines.push(`$74=${(this.wizardData.wifiSsid || '').trim()}`);
            lines.push(`$75=${this.wizardData.wifiPsk || ''}`);
        }
        return lines;
    }

    _escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
