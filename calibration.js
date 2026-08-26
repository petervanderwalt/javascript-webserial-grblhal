import { makeLine, getTextWidth, drawTextString } from './gcode-draw.js';
import { registerModal } from './modal.js';

export class CalibrationHandler {
    constructor(ws, term, store) {
        this.ws = ws;
        this.term = term;
        this.store = store;

        this.axis = 'X';
        this.method = 'distance';
        this.step = 'axis';
        this.oldSteps = 100;
        this.newSteps = 100;
        this.errorFactor = 1;
        this.commandedDistance = 100;
        this.isCutting = false;
        this.modal = null;
        this.posInterval = null;
        this.alarmWatch = null;
        this.okListener = null;

        this.initUI();
    }

    initUI() {
        this._initModal();
        this.refreshA();
    }

    _initModal() {
        this.modal = registerModal('calibration-modal', {
            onShow: () => {
                this.axis = 'X';
                this.method = 'distance';
                this.commandedDistance = this.getDefaultDistance(this.axis);
                this.isCutting = false;
                this.setStep('axis');
            },
            onHide: () => this.cancel(undefined, { returnToOperation: false })
        });
    }

    showModal() {
        if (!this.modal) this._initModal();
        if (this.modal) this.modal.show();
    }

    hideModal() {
        if (this.modal) this.modal.hide();
    }

    refreshA() {
        // A-axis no longer shown in calibration
    }

    setStep(step) {
        this.step = step;
        this.renderWizard();
    }

    renderWizard() {
        const container = document.getElementById('calibration-modal-body');
        const footer = document.getElementById('calibration-modal-footer');
        if (!container || !footer) return;

        const steps = ['Axis', 'Method', 'Setup', this.method === 'vernier' ? 'Cut' : 'Move', 'Measure', 'Result', 'Done'];
        const stepOrder = ['axis', 'method', 'setup', 'cut', 'measure', 'result', 'done'];
        const currentIndex = stepOrder.indexOf(this.step);

        let html = '';

        // Step indicator
        html += '<div class="wizard-stepper wizard-stepper--compact mb-6 px-1">';
        steps.forEach((label, i) => {
            const isActive = i === currentIndex;
            const isDone = i < currentIndex;
            html += `<div class="wizard-stepper__item ${isActive ? 'is-active' : ''} ${isDone ? 'is-complete' : ''}">`;
            if (isDone) {
                html += '<span class="wizard-stepper__circle"><i data-lucide="check" style="width:16px;height:16px"></i></span>';
            } else {
                html += `<span class="wizard-stepper__circle">${i + 1}</span>`;
            }
            html += `<span class="wizard-stepper__label">${label}</span></div>`;
        });
        html += '</div>';

        // Step content
        html += '<div>';
        switch (this.step) {
            case 'axis': html += this._renderAxisStep(); break;
            case 'method': html += this._renderMethodStep(); break;
            case 'setup': html += this._renderSetupStep(); break;
            case 'cut': html += this._renderCutStep(); break;
            case 'measure': html += this._renderMeasureStep(); break;
            case 'result': html += this._renderResultStep(); break;
            case 'done': html += this._renderDoneStep(); break;
        }
        html += '</div>';

        container.innerHTML = html;

        // Footer
        footer.innerHTML = this._renderFooter();
        footer.classList.remove('hidden');

        this._wireCalibrationEvents();
        if (window.lucide) window.lucide.createIcons();
    }

    _renderAxisStep() {
        const hasA = window.dro && window.dro.mpos && window.dro.mpos.length > 3;
        const axisOptions = [
            { id: 'X', label: 'X Axis' },
            { id: 'Y', label: 'Y Axis' },
            { id: 'Z', label: 'Z Axis' },
        ];

        let html = '<p class="text-sm text-grey mb-4">Choose which machine axis you want to calibrate.</p>';
        html += '<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden">';
        html += '<div class="divide-y divide-grey-light/60">';
        axisOptions.forEach(opt => {
            const sel = this.axis === opt.id;
            html += `<div class="axis-option config-filter-choice ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-axis="${opt.id}">`;
            html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
            html += `<span class="config-filter-choice__label">${opt.label}</span>`;
            html += '</div>';
        });
        html += '</div></div>';
        html += '<p class="text-[10px] text-grey mt-3"><i data-lucide="info" style="width:12px;height:12px"></i> Select the axis you want to calibrate. X and Y support both measured travel and vernier scale methods. Z uses measured travel only.</p>';
        return html;
    }

    _renderMethodStep() {
        const intro = this.axis === 'Z'
            ? 'Z axis uses measured travel calibration only.'
            : `Choose how you want to calibrate the ${this.axis} axis.`;

        const methods = this.axis === 'Z'
            ? [{ id: 'distance', label: 'Measured Travel', desc: 'Command a move, measure the actual travel, then correct steps/mm.' }]
            : [
                { id: 'distance', label: 'Measured Travel', desc: 'Command a move, measure the actual travel, then correct steps/mm.' },
                { id: 'vernier', label: 'Vernier Scale', desc: 'Cut a fine reference scale and compare it visually against a ruler.' },
              ];

        let html = `<p class="text-sm text-grey mb-4">${intro}</p>`;
        html += '<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden">';
        html += '<div class="divide-y divide-grey-light/60">';
        methods.forEach(opt => {
            const sel = this.method === opt.id;
            html += `<div class="method-option config-filter-choice ${sel ? 'is-selected' : ''} flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer" data-method="${opt.id}">`;
            html += `<div class="config-filter-choice__control ${sel ? 'is-selected' : ''} w-4 h-4 rounded-full flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full ${sel ? 'bg-white' : ''}"></div></div>`;
            html += `<div><span class="config-filter-choice__label">${opt.label}</span><div class="config-filter-subtitle">${opt.desc}</div></div>`;
            html += '</div>';
        });
        html += '</div></div>';
        return html;
    }

    _renderSetupStep() {
        const isVernier = this.method === 'vernier';
        const axis = this.axis;
        const axisIdx = this.getAxisIndex(axis);
        const pos = window.dro && window.dro.wpos ? (window.dro.wpos[axisIdx] || 0).toFixed(3) : '---';

        const steps = isVernier
            ? [
                'Secure a scrap piece of <strong>MDF or Wood</strong> to your wasteboard. Ensure it is at least 120mm long.',
                'Install a <strong>sharp V-Bit</strong> or engraving tool.',
                'Jog to the starting position on the scrap material and <strong>zero the Z axis</strong> on the surface.'
              ]
            : [
                `Set up a <strong>ruler, calipers, or dial indicator</strong> so you can measure ${axis} axis travel accurately.`,
                `Jog to a safe start point with enough room to move <strong>${this.commandedDistance}mm</strong> in the positive ${axis} direction.`,
                `Zero or reference your measuring device, then zero the ${axis} work coordinate if that helps your setup.`
              ];

        const warning = isVernier
            ? `Ensure there is enough travel in the ${axis} direction (approx 100mm) from the current position.`
            : `Ensure there is enough clear travel in the ${axis} direction for the commanded move before starting.`;

        let html = '<div class="config-filter-group bg-white rounded-xl border border-grey-light overflow-hidden">';

        // Compact instructions
        html += '<div class="divide-y divide-grey-light/60">';
        html += '<div class="px-4 py-3 space-y-2">';
        steps.forEach((text, i) => {
            html += `<div class="flex items-start gap-2 text-sm text-grey-dark leading-relaxed"><span class="font-bold text-primary shrink-0">${i + 1}.</span><span>${text}</span></div>`;
        });
        html += '</div>';

        // Quick control row
        html += `<div class="px-4 py-3 bg-grey-bg/30 border-t border-grey-light flex items-center justify-between gap-4">`;
        html += `<div class="flex items-center gap-2"><span class="text-xs font-bold text-secondary-dark">${axis}:</span><span id="cal-axis-pos" class="font-mono font-bold text-xs">${pos}</span></div>`;
        html += `<button onclick="window.calibration.zeroSelectedAxis()" class="btn btn-secondary text-xs">Zero ${axis} Axis</button>`;
        html += '</div>';

        // Warning
        html += `<div class="px-4 py-3 border-t border-grey-light flex items-start gap-2 bg-yellow-50/50"><i data-lucide="triangle-alert" class="text-yellow-600 shrink-0 mt-0.5" style="width:14px;height:14px"></i><p class="text-[10px] text-yellow-800">${warning}</p></div>`;

        html += '</div></div>';
        return html;
    }

    _renderCutStep() {
        const isVernier = this.method === 'vernier';
        const axis = this.axis;

        let html = '';

        if (isVernier) {
            html += '<h4 class="text-base font-bold text-secondary-dark mb-3">Ready to cut?</h4>';
            html += '<p class="text-sm text-grey mb-6">The machine will now cut 100 lines spaced 0.9mm apart. This will take approximately 2 minutes.</p>';

            html += '<div id="cal-cut-spindle-warning" class="bg-red-50 border border-red-100 p-4 rounded-lg mb-6 flex items-center gap-3 text-left">';
            html += '<i data-lucide="fan" class="text-red-500 shrink-0" style="width:20px;height:20px"></i>';
            html += '<div><p class="text-xs font-black text-red-800 uppercase">Warning</p><p class="text-xs text-red-700">Please ensure your <strong>spindle is turned ON</strong> before clicking Start Cut.</p></div>';
            html += '</div>';

            // Progress
            html += '<div id="cal-cut-progress" class="mb-6">';
            html += '<div class="flex justify-between text-[10px] font-bold text-grey uppercase mb-1">';
            html += '<span>Cutting Mark <span id="cal-mark-num">0</span>/100</span>';
            html += '<span id="cal-cut-pct">0%</span>';
            html += '</div>';
            html += '<div class="h-2 w-full bg-grey-bg rounded-full overflow-hidden">';
            html += '<div id="cal-cut-bar" class="h-full bg-primary transition-all duration-300 w-0"></div>';
            html += '</div></div>';
        } else {
            html += '<h4 class="text-base font-bold text-secondary-dark mb-3">Ready to move?</h4>';
            html += `<p class="text-sm text-grey mb-6">The machine will move the ${axis} axis by the commanded distance. Measure the actual travel, then enter it on the next step.</p>`;

            html += '<div id="cal-distance-panel" class="mb-6 text-left bg-grey-bg border border-grey-light rounded-xl p-4">';
            html += '<label class="ooznest-label text-[10px] font-bold text-grey-dark uppercase tracking-wider block mb-1">Commanded Travel (mm)</label>';
            html += `<input type="number" id="cal-input-commanded" class="ooznest-field input-field text-right font-mono" value="${this.commandedDistance}" min="0.1" step="0.1">`;
            html += '<p class="text-[10px] text-grey mt-2">The machine will move the selected axis by this amount in the positive direction.</p>';
            html += '</div>';
        }

        return html;
    }

    _renderMeasureStep() {
        const isVernier = this.method === 'vernier';
        const axis = this.axis;

        let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-8">';

        // Left: Help
        html += '<div>';
        html += `<h4 class="font-bold text-secondary-dark mb-4 flex items-center gap-2 text-sm"><i data-lucide="info" class="text-primary" style="width:16px;height:16px"></i> ${isVernier ? 'How to Read' : 'How to Measure'}</h4>`;

        if (isVernier) {
            html += '<div class="space-y-3 text-sm text-grey-dark leading-relaxed">';
            html += '<p>1. Place a <strong>standard steel ruler</strong> against the cut marks, aligning the <strong>0 mark</strong> of the ruler with the <strong>first cut mark</strong>.</p>';
            html += '<p>2. Look along the ruler and find where a <strong>cut mark</strong> aligns perfectly with a <strong>millimeter mark</strong> on your ruler.</p>';
            html += '<div class="p-3 bg-grey-bg rounded-lg border border-grey-light italic text-xs">"The CNC marks are 0.9mm apart. By finding where they align with the 1mm marks on your ruler, we can calculate the exact error."</div>';
            html += '</div>';
        } else {
            html += '<div class="space-y-3 text-sm text-grey-dark leading-relaxed">';
            html += `<p>1. Measure how far the <strong>${axis} axis</strong> actually moved after the commanded travel.</p>`;
            html += `<p>2. Use the same units as the commanded move. The machine was commanded to move <strong><span id="cal-commanded-display-inline">${this.commandedDistance.toFixed(2)}</span> mm</strong>.</p>`;
            html += '</div>';
        }
        html += '</div>';

        // Right: Inputs
        html += '<div class="space-y-4 bg-grey-bg p-5 rounded-xl border border-grey-light">';
        html += '<h4 class="text-[10px] font-black text-grey uppercase tracking-wider">Enter Readings</h4>';

        if (isVernier) {
            html += '<div>';
            html += '<label class="ooznest-label text-[10px] font-bold text-grey-dark uppercase tracking-wider block mb-2">Which CNC mark aligns perfectly? (0-100)</label>';
            html += '<div class="mb-1"><label class="text-[10px] font-bold text-grey block mb-1">MARK</label>';
            html += '<input type="number" id="cal-input-mark" class="ooznest-field input-field text-right font-mono w-full" placeholder="96" min="0" max="100"></div>';
            html += '<p class="text-[10px] text-grey mt-1 italic">Calculated CNC Distance: <span id="cal-cnc-dist-display">0.00</span> mm</p>';
            html += '</div>';
            html += '<div>';
            html += '<label class="ooznest-label text-[10px] font-bold text-grey-dark uppercase tracking-wider block mb-2">Ruler reading at that mark (mm)</label>';
            html += '<div><label class="text-[10px] font-bold text-grey block mb-1">REAL</label>';
            html += '<input type="number" id="cal-input-real" class="ooznest-field input-field text-right font-mono w-full" placeholder="86.0" step="0.1"></div>';
            html += '</div>';
        } else {
            html += '<div>';
            html += '<label class="ooznest-label text-[10px] font-bold text-grey-dark uppercase tracking-wider block mb-2">Commanded Travel (mm)</label>';
            html += `<input type="text" id="cal-commanded-display" class="ooznest-field input-field text-right font-mono w-full" value="${this.commandedDistance.toFixed(2)}" readonly>`;
            html += '</div>';
            html += '<div>';
            html += '<label class="ooznest-label text-[10px] font-bold text-grey-dark uppercase tracking-wider block mb-2">Actual Measured Travel (mm)</label>';
            html += `<input type="number" id="cal-input-actual-travel" class="ooznest-field input-field text-right font-mono w-full" value="${this.commandedDistance.toFixed(2)}" step="0.01">`;
            html += '</div>';
        }

        html += '</div>';
        html += '</div>';

        return html;
    }

    _renderResultStep() {
        const settingId = this.getAxisSettingId(this.axis);

        let html = '<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">';
        html += '<div class="bg-grey-bg p-4 rounded-xl border border-grey-light text-center">';
        html += '<span class="text-[10px] font-black text-grey uppercase block mb-1">Current Steps/mm</span>';
        html += `<span id="cal-old-steps" class="text-2xl font-mono font-bold text-secondary-dark">${this.oldSteps.toFixed(3)}</span>`;
        html += '</div>';
        html += '<div class="bg-primary/5 p-4 rounded-xl border border-primary/20 text-center ring-4 ring-primary/5">';
        html += '<span class="text-[10px] font-black text-primary uppercase block mb-1">New Steps/mm</span>';
        html += `<span id="cal-new-steps" class="text-3xl font-mono font-black text-primary">${this.newSteps.toFixed(3)}</span>`;
        html += '</div>';
        html += '<div class="bg-grey-bg p-4 rounded-xl border border-grey-light text-center">';
        html += '<span class="text-[10px] font-black text-grey uppercase block mb-1">Error Factor</span>';
        html += `<span id="cal-error-factor" class="text-2xl font-mono font-bold text-secondary-dark">${this.errorFactor.toFixed(6)}</span>`;
        html += '</div>';
        html += '</div>';

        const verifyTail = this.method === 'vernier'
            ? 'It is recommended to perform a test cut after applying to verify the accuracy.'
            : 'It is recommended to repeat the travel check after applying to verify the accuracy.';

        html += `<div class="bg-blue-50 border border-blue-100 p-5 rounded-xl mb-4 flex items-start gap-3">`;
        html += `<i data-lucide="info" class="text-blue-500 shrink-0" style="width:18px;height:18px"></i>`;
        html += `<div class="text-sm text-blue-800 leading-relaxed"><p class="font-bold mb-1">Verification</p><p>Applying this change will update your machine's <strong>$${settingId}</strong> setting. ${verifyTail}</p></div>`;
        html += '</div>';

        return html;
    }

    _renderDoneStep() {
        const axis = this.axis;
        const desc = this.method === 'vernier'
            ? `The new steps/mm have been saved to your machine's non-volatile memory. Your ${axis} axis is now tuned using the Vernier method.`
            : `The new steps/mm have been saved to your machine's non-volatile memory. Your ${axis} axis is now tuned using measured travel.`;

        let html = '<div class="text-center">';
        html += '<div class="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4"><i data-lucide="check" class="text-3xl"></i></div>';
        html += '<h3 class="text-xl font-black text-secondary-dark mb-2">Calibration Complete!</h3>';
        html += `<p class="text-sm text-grey mb-6 max-w-md mx-auto">${desc}</p>`;
        html += '</div>';
        return html;
    }

    _renderFooter() {
        if (this.step === 'done') {
            return `<div class="flex w-full justify-center gap-3">
                <button onclick="window.calibration.cancel()" class="btn btn-primary"><i data-lucide="repeat" style="width:14px;height:14px"></i> Calibrate Another Axis</button>
                <button onclick="window.calibration.hideModal()" class="btn btn-secondary"><i data-lucide="x" style="width:14px;height:14px"></i> Close</button>
            </div>`;
        }

        const isDisabled = this.isCutting;
        const forwardLabel = this.step === 'cut'
            ? (this.method === 'vernier' ? 'Start Cut' : 'Run Test Move')
            : this.step === 'result' ? 'Apply' : 'Continue';

        const backAction = this.step === 'axis'
            ? 'window.calibration.hideModal()'
            : 'window.calibration.prevStep()';

        const forwardAction = this.step === 'cut'
            ? 'window.calibration.runCutJob()'
            : this.step === 'measure' ? 'window.calibration.calculate()'
            : this.step === 'result' ? 'window.calibration.apply()'
            : 'window.calibration.nextStep()';

        return `<div class="flex w-full justify-between items-center gap-3">
            <button onclick="${backAction}" class="btn btn-secondary" ${isDisabled ? 'disabled' : ''}>${this.step === 'axis' ? 'Close' : 'Back'}</button>
            <button id="btn-cal-fwd" onclick="${forwardAction}" class="btn btn-primary" ${isDisabled ? 'disabled' : ''}>${forwardLabel}</button>
        </div>`;
    }

    _wireCalibrationEvents() {
        // Axis selection
        document.querySelectorAll('.axis-option').forEach(el => {
            el.onclick = () => {
                const axis = el.dataset.axis;
                if (axis) this.selectAxis(axis);
            };
        });

        // Method selection
        document.querySelectorAll('.method-option').forEach(el => {
            el.onclick = () => {
                const method = el.dataset.method;
                if (method) this.selectMethod(method);
            };
        });

        // Vernier mark input
        const markInput = document.getElementById('cal-input-mark');
        if (markInput) {
            markInput.addEventListener('input', () => {
                const n = parseFloat(markInput.value) || 0;
                const dist = n * 0.9;
                const display = document.getElementById('cal-cnc-dist-display');
                if (display) display.textContent = dist.toFixed(2);
            });
        }

        // Commanded distance input
        const commandedInput = document.getElementById('cal-input-commanded');
        if (commandedInput) {
            commandedInput.addEventListener('input', () => {
                const val = parseFloat(commandedInput.value) || this.commandedDistance || 0;
                const display = document.getElementById('cal-commanded-display');
                const displayInline = document.getElementById('cal-commanded-display-inline');
                if (display) display.value = val.toFixed(2);
                if (displayInline) displayInline.textContent = val.toFixed(2);
            });
        }
    }

    selectAxis(axis) {
        this.axis = axis;
        if (axis === 'Z') this.method = 'distance';
        this.commandedDistance = this.getDefaultDistance(axis);
        this.renderWizard();
    }

    selectMethod(method) {
        this.method = method;
        this.renderWizard();
    }

    startWizard(axis, method = 'distance') {
        this.axis = axis;
        this.method = method;

        if (method === 'vernier' && axis !== 'X' && axis !== 'Y') {
            this.term.writeln(`\x1b[33m[Calibration] Vernier calibration is available for X and Y only.\x1b[0m`);
            if (window.showToast) window.showToast('Vernier calibration is available for X and Y only.', 'info', 'info');
            return;
        }

        if (axis === 'A') {
            this.term.writeln(`\x1b[33m[Calibration] A axis calibration coming soon.\x1b[0m`);
            if (window.showToast) window.showToast('A axis calibration coming soon.', 'info', 'info');
            return;
        }

        this.commandedDistance = this.getDefaultDistance(axis);
        this.setStep('setup');

        // Fetch current steps/mm for this axis
        const settingId = this.getAxisSettingId(axis);
        if (window.grblSettings && Object.keys(window.grblSettings.settings).length > 0) {
            if (window.grblSettings.settings[settingId]) {
                this.oldSteps = parseFloat(window.grblSettings.settings[settingId].val);
            }
        } else if (window.grblSettings) {
            this.term.writeln('\x1b[33m[Calibration] Fetching settings from machine...\x1b[0m');
            window.grblSettings.fetchSettings();
            setTimeout(() => {
                if (window.grblSettings.settings[settingId]) {
                    this.oldSteps = parseFloat(window.grblSettings.settings[settingId].val);
                }
            }, 2000);
        }

        this.oldSteps = this.oldSteps || 100;

        // Start position monitoring
        if (this.posInterval) clearInterval(this.posInterval);
        this.posInterval = setInterval(() => {
            if (window.dro && window.dro.wpos) {
                const posEl = document.getElementById('cal-axis-pos');
                if (posEl) {
                    const axisIndex = this.getAxisIndex(this.axis);
                    posEl.textContent = (window.dro.wpos[axisIndex] || 0).toFixed(3);
                }
            }
        }, 200);
    }

    nextStep() {
        if (this.step === 'axis') this.setStep('method');
        else if (this.step === 'method') this.startWizard(this.axis, this.method);
        else if (this.step === 'setup') this.setStep('cut');
        else if (this.step === 'cut') this.setStep('measure');
        else if (this.step === 'measure') this.setStep('result');
        else if (this.step === 'result') this.setStep('done');
    }

    prevStep() {
        if (this.step === 'method') this.setStep('axis');
        else if (this.step === 'setup') this.setStep('method');
        else if (this.step === 'cut') this.setStep('setup');
        else if (this.step === 'measure') this.setStep('cut');
        else if (this.step === 'result') this.setStep('measure');
    }

    cancel(msg, options = {}) {
        const { returnToOperation = true } = options;
        if (this.posInterval) clearInterval(this.posInterval);
        this.posInterval = null;
        if (this.alarmWatch) clearInterval(this.alarmWatch);
        this.alarmWatch = null;
        this.isCutting = false;
        if (this.okListener) this.ws.removeListener('line', this.okListener);
        this.okListener = null;
        if (returnToOperation) {
            this.axis = 'X';
            this.method = 'distance';
            this.commandedDistance = this.getDefaultDistance(this.axis);
            this.setStep('axis');
        }
        if (msg && this.term) {
            this.term.writeln(`\x1b[31m[Calibration] ${msg}\x1b[0m`);
        }
    }

    runCutJob() {
        if (this.method === 'distance') {
            this.runDistanceMove();
            return;
        }

        const gcode = this.generateGCode();

        this.isCutting = true;
        this.renderWizard();

        // Re-grab progress elements after render
        const progress = document.getElementById('cal-cut-progress');
        if (progress) progress.classList.remove('hidden');

        this.term.writeln(`\x1b[34m[Calibration] Starting cut job for ${this.axis} axis...\x1b[0m`);

        this.lines = gcode.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        this.currentLineIndex = 0;
        this.marksCut = 0;

        // Watch for alarms during the cut job
        if (this.alarmWatch) clearInterval(this.alarmWatch);
        this.alarmWatch = setInterval(() => {
            if (!this.isCutting) {
                clearInterval(this.alarmWatch);
                return;
            }
            if (window.dro && window.dro.status === 'Alarm') {
                clearInterval(this.alarmWatch);
                this.term.writeln(`\x1b[31m[Calibration] Machine alarm detected! Aborting job.\x1b[0m`);
                if (window.showToast) window.showToast('Calibration aborted due to machine alarm', 'triangle-alert', 'error');
                this.cancel('Aborted due to machine alarm. Check machine and re-home before retrying.');
            }
        }, 200);

        // Listener for 'ok' responses
        this.okListener = (line) => {
            if (!this.isCutting) return;
            if (line === 'ok' || line.startsWith('error:')) {
                this.sendNextLine();
            }
        };
        this.ws.on('line', this.okListener);

        // Start by sending the first few lines to fill the buffer
        for (let i = 0; i < 10; i++) {
            if (this.currentLineIndex < this.lines.length) {
                this.sendNextLine();
            }
        }
    }

    runDistanceMove() {
        const input = document.getElementById('cal-input-commanded');
        const distance = parseFloat(input?.value);
        if (isNaN(distance) || distance <= 0) {
            alert('Please enter a valid commanded distance.');
            return;
        }

        this.commandedDistance = distance;
        this.isCutting = true;
        this.renderWizard();

        const feed = this.axis === 'Z' ? 300 : 1000;
        const axisWord = `${this.axis}${distance}`;
        this.term.writeln(`\x1b[34m[Calibration] Moving ${this.axis} axis by ${distance.toFixed(3)}mm...\x1b[0m`);
        this.ws.sendCommand('G21');
        this.ws.sendCommand('G91');
        this.ws.sendCommand(`G1 ${axisWord} F${feed}`);
        this.ws.sendCommand('G90');
        this.waitForIdle(true);
    }

    sendNextLine() {
        if (!this.isCutting) return;

        if (this.currentLineIndex >= this.lines.length) {
            this.isCutting = false;
            this.ws.removeListener('line', this.okListener);
            this.okListener = null;
            this.waitForIdle();
            return;
        }

        const line = this.lines[this.currentLineIndex];
        this.ws.sendCommand(line);
        this.currentLineIndex++;

        // Update Progress UI
        const pct = Math.round((this.currentLineIndex / this.lines.length) * 100);
        const bar = document.getElementById('cal-cut-bar');
        const pctEl = document.getElementById('cal-cut-pct');
        if (bar) bar.style.width = `${pct}%`;
        if (pctEl) pctEl.textContent = `${pct}%`;

        // Count marks
        if (/G0?1.*Z-/.test(line)) {
            this.marksCut++;
            const markNum = document.getElementById('cal-mark-num');
            if (markNum) markNum.textContent = Math.min(this.marksCut, 100);
        }
    }

    waitForIdle(mustSeeMotion = false) {
        this.term.writeln(`\x1b[34m[Calibration] Waiting for machine to finish moving...\x1b[0m`);

        let attempts = 0;
        let sawMotion = !mustSeeMotion;
        const checkIdle = setInterval(() => {
            attempts++;
            if (window.dro && window.dro.status && window.dro.status !== 'Idle' && window.dro.status !== 'Check') {
                sawMotion = true;
            }
            if (window.dro && sawMotion && (window.dro.status === 'Idle' || window.dro.status === 'Check')) {
                clearInterval(checkIdle);
                this.term.writeln(`\x1b[32m[Calibration] Job complete.\x1b[0m`);
                this.isCutting = false;
                this.nextStep();
            }
            if (attempts > 60) {
                clearInterval(checkIdle);
                this.term.writeln(`\x1b[33m[Calibration] Timeout waiting for Idle. Proceeding...\x1b[0m`);
                this.isCutting = false;
                this.nextStep();
            }
        }, 500);
    }

    generateGCode() {
        const orientation = this.axis;
        const lengthLet = 3;
        const hightLet = 4;
        const space = 1.5;
        const depth = -0.3;
        const up = 1;
        const feedrate = 500;
        const plungeRate = 150;
        const rotateLabels = true;

        const down = depth;
        const rapide = 'G0';
        const lent = 'G01';

        let gcode = '';
        gcode += `G21 G90 G17 F${feedrate}\n`;
        gcode += `G0 X0 Y0 Z${up}\n`;

        for (let i = 0; i <= 100; i++) {
            const u = i * 0.9;
            let tickHeight = hightLet * 0.5;
            if (i % 10 === 0) {
                tickHeight = hightLet;
            } else if (i % 5 === 0) {
                tickHeight = hightLet * 0.75;
            }

            gcode += makeLine(rapide, orientation, u, 0, { z: up });
            gcode += makeLine(lent, orientation, u, 0, { z: down, f: plungeRate });
            gcode += makeLine(lent, orientation, u, tickHeight, { z: down });
            gcode += makeLine(rapide, orientation, u, tickHeight, { z: up });
        }

        const labelBaseline = hightLet + 1.5;
        for (let i = 0; i <= 100; i += 10) {
            const uTick = i * 0.9;
            const labelText = i + 'X';

            if (rotateLabels) {
                gcode += drawTextString(labelText, uTick, labelBaseline, lengthLet, hightLet, space, depth, up, orientation, true);
            } else {
                const labelWidth = getTextWidth(labelText, lengthLet, space);
                const uStart = uTick - labelWidth / 2;
                gcode += drawTextString(labelText, uStart, labelBaseline, lengthLet, hightLet, space, depth, up, orientation, false);
            }
        }

        let maxLabelLength = 0;
        if (rotateLabels) {
            maxLabelLength = getTextWidth("100X", lengthLet, space);
        } else {
            maxLabelLength = hightLet;
        }

        const dimensionBaseline = labelBaseline + maxLabelLength + 4.5;
        const extensionMinV = labelBaseline + maxLabelLength + 1.2;
        const extensionMaxV = dimensionBaseline + 1.5;

        gcode += makeLine(rapide, orientation, 0, extensionMinV, { z: up });
        gcode += makeLine(lent, orientation, 0, extensionMinV, { z: down, f: plungeRate });
        gcode += makeLine(lent, orientation, 0, extensionMaxV, { z: down });
        gcode += makeLine(rapide, orientation, 0, extensionMaxV, { z: up });

        gcode += makeLine(rapide, orientation, 90, extensionMinV, { z: up });
        gcode += makeLine(lent, orientation, 90, extensionMinV, { z: down, f: plungeRate });
        gcode += makeLine(lent, orientation, 90, extensionMaxV, { z: down });
        gcode += makeLine(rapide, orientation, 90, extensionMaxV, { z: up });

        const dimText = "90MM";
        const dimTextWidth = getTextWidth(dimText, lengthLet, space);
        const dimTextStart = 45 - dimTextWidth / 2;
        const dimTextBaseline = dimensionBaseline - (hightLet / 2);

        gcode += drawTextString(dimText, dimTextStart, dimTextBaseline, lengthLet, hightLet, space, depth, up, orientation, false);

        const textGap = 2.0;
        const lineV = dimensionBaseline;

        gcode += makeLine(rapide, orientation, 0, lineV, { z: up });
        gcode += makeLine(lent, orientation, 0, lineV, { z: down, f: plungeRate });
        gcode += makeLine(lent, orientation, 45 - (dimTextWidth / 2) - textGap, lineV, { z: down });
        gcode += makeLine(rapide, orientation, 45 - (dimTextWidth / 2) - textGap, lineV, { z: up });

        gcode += makeLine(rapide, orientation, 45 + (dimTextWidth / 2) + textGap, lineV, { z: up });
        gcode += makeLine(lent, orientation, 45 + (dimTextWidth / 2) + textGap, lineV, { z: down, f: plungeRate });
        gcode += makeLine(lent, orientation, 90, lineV, { z: down });
        gcode += makeLine(rapide, orientation, 90, lineV, { z: up });

        gcode += makeLine(rapide, orientation, 0, 0, { z: up });

        return gcode;
    }

    calculate() {
        if (this.method === 'distance') {
            const commanded = this.commandedDistance;
            const actual = parseFloat(document.getElementById('cal-input-actual-travel')?.value);

            if (isNaN(commanded) || commanded <= 0 || isNaN(actual) || actual <= 0) {
                alert("Please enter valid travel values.");
                return;
            }

            this.commandedDistance = commanded;
            this.errorFactor = actual / commanded;
            this.newSteps = this.oldSteps * (commanded / actual);

            this.setStep('result');
            return;
        }

        const n = parseFloat(document.getElementById('cal-input-mark').value);
        const real = parseFloat(document.getElementById('cal-input-real').value);

        if (isNaN(n) || isNaN(real) || real <= 0) {
            alert("Please enter valid readings.");
            return;
        }

        const cncDist = n * 0.9;
        this.errorFactor = real / cncDist;
        this.newSteps = this.oldSteps * (cncDist / real);

        this.setStep('result');
    }

    apply() {
        const settingId = this.getAxisSettingId(this.axis);
        const val = this.newSteps.toFixed(3);

        this.ws.sendCommand(`$${settingId}=${val}`);
        if (this.axis === 'Y') {
            this.ws.sendCommand(`$103=${val}`);
        }
        this.term.writeln(`\x1b[32m[Calibration] Applied $${settingId}=${val} to firmware.\x1b[0m`);

        if (window.reporter) {
            if (window.showToast) window.showToast(`Updated $${settingId} to ${val}`, 'check-circle', 'success');
        }

        this.setStep('done');
    }

    zeroSelectedAxis() {
        this.ws.sendCommand(`G10 L20 P0 ${this.axis}0`);
    }

    getAxisSettingId(axis) {
        return { X: '100', Y: '101', Z: '102', A: '103' }[axis] || '100';
    }

    getAxisIndex(axis) {
        return { X: 0, Y: 1, Z: 2, A: 3 }[axis] ?? 0;
    }

    getDefaultDistance(axis) {
        return axis === 'Z' ? 25 : axis === 'A' ? 360 : 100;
    }
}
