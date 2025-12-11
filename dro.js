export class DROHandler {
    constructor(ws, term, store) {
        this.ws = ws;
        this.term = term;
        this.store = store;

        // Initialize Units from Store
        this.isMm = this.store.get('general.units') === 'mm';

        // Coordinate State
        this.wco = [0, 0, 0, 0];
        this.wpos = [0, 0, 0, 0];
        this.mpos = [0, 0, 0, 0];

        // Initial UI Render
        this.updateUIUnits();
    }

    // --- Command Senders ---

    setZero(axis) {
        if (axis === 'XYZ') {
            this.ws.sendCommand('G10 L20 P0 X0 Y0 Z0');
        } else {
            this.ws.sendCommand(`G10 L20 P0 ${axis}0`);
        }
    }

    home() {
        if (confirm("Run Homing Cycle ($H)? Ensure path is clear.")) {
            this.ws.sendCommand('$H');
        }
    }

    goXY0() {
        this.ws.sendCommand('G0 X0 Y0');
    }

    setWCS(wcs) {
        this.ws.sendCommand(wcs);
        this.term.writeln(`\x1b[34m> Switched to ${wcs}\x1b[0m`);
    }

    goToPredefined(pos) {
        this.ws.sendCommand(`G${pos}`);
        this.term.writeln(`\x1b[34m> Moving to G${pos} Position\x1b[0m`);
    }

    setPredefined(pos) {
        if(confirm(`Set G${pos} location to current Machine Coordinates?`)) {
            this.ws.sendCommand(`G${pos}.1`);
            this.term.writeln(`\x1b[32m> G${pos} Position Set.\x1b[0m`);
        }
    }

    toggleUnits() {
        const toggle = document.getElementById('unitToggle');
        this.isMm = toggle.checked;

        // Save to Store
        this.store.set('general.units', this.isMm ? 'mm' : 'in');

        // Update UI
        this.updateUIUnits();

        // Update Controller
        if (this.isMm) this.ws.sendCommand('G21');
        else this.ws.sendCommand('G20');

        this._updateAxisDisplay();
    }

    updateUIUnits() {
        // Toggle Switch
        const toggle = document.getElementById('unitToggle');
        if(toggle) toggle.checked = this.isMm;

        // Label
        const label = document.getElementById('unitLabel');
        if(label) label.innerText = this.isMm ? 'MM' : 'IN';

        // Step Options
        const select = document.getElementById('stepSize');
        if (select) {
            const mmSteps = [0.1, 1, 10, 100];
            const inSteps = [0.001, 0.01, 0.1, 1];
            const steps = this.isMm ? mmSteps : inSteps;
            const unit = this.isMm ? 'mm' : 'in';

            // Get Current Stored Preference
            const currentStep = parseFloat(this.store.get('jog.step')) || (this.isMm ? 10 : 0.1);

            select.innerHTML = '';
            let matchFound = false;

            steps.forEach((step) => {
                const opt = document.createElement('option');
                opt.value = step;
                opt.innerText = `${step} ${unit}`;
                if(step === currentStep) matchFound = true;
                select.appendChild(opt);
            });

            if(matchFound) select.value = currentStep;
            else select.selectedIndex = 2; // Default to middle option if mismatch
        }

        // Feedrate
        const feedInput = document.getElementById('feedRate');
        if(feedInput) {
            // Read from Store
            feedInput.value = this.store.get('jog.feed');
        }
    }

    parseStatus(line) {
        const content = line.substring(1, line.length - 1);
        const parts = content.split('|');

        this._updateStateBadge(parts[0]);

        let rawWPos = null;
        let rawMPos = null;

        parts.forEach(part => {
            if (part.startsWith('WCO:')) {
                this.wco = part.split(':')[1].split(',').map(Number);
            } else if (part.startsWith('WPos:')) {
                rawWPos = part.split(':')[1].split(',').map(Number);
            } else if (part.startsWith('MPos:')) {
                rawMPos = part.split(':')[1].split(',').map(Number);
            }
        });

        if (rawMPos) {
            this.mpos = rawMPos;
            this.wpos = this.mpos.map((v, i) => v - (this.wco[i] || 0));
        } else if (rawWPos) {
            this.wpos = rawWPos;
            this.mpos = this.wpos.map((v, i) => v + (this.wco[i] || 0));
        }

        this._updateAxisDisplay();
    }

    _updateStateBadge(state) {
        const stateEl = document.getElementById('machine-state');
        if (!stateEl) return;
        const cleanState = state.split(':')[0];
        stateEl.textContent = cleanState;
        stateEl.className = "text-[10px] px-1.5 py-0.5 rounded font-bold uppercase text-white transition-all duration-300";
        const s = cleanState.toLowerCase();

        if (s.startsWith('alarm')) {
            stateEl.classList.add('bg-red-600', 'animate-pulse', 'shadow-lg', 'shadow-red-500/50');
        } else if (s.startsWith('hold') || s.startsWith('door') || s.startsWith('sleep')) {
            stateEl.classList.add('bg-yellow-600');
        } else if (s.startsWith('run') || s.startsWith('jog') || s.startsWith('homing')) {
            stateEl.classList.add('bg-green-600');
        } else {
            stateEl.classList.add('bg-secondary');
        }
    }

    _updateAxisDisplay() {
        const axes = ['x', 'y', 'z', 'a'];
        axes.forEach((axis, i) => {
            const elW = document.getElementById(`dro-${axis}`);   // Work
            const elM = document.getElementById(`dro-${axis}-m`); // Machine
            if (elW) {
                let wVal = this.wpos[i] !== undefined ? this.wpos[i] : 0;
                let mVal = this.mpos[i] !== undefined ? this.mpos[i] : 0;
                if (!this.isMm) {
                    wVal = wVal / 25.4;
                    mVal = mVal / 25.4;
                }
                const decimals = this.isMm ? 3 : 4;
                elW.textContent = wVal.toFixed(decimals);
                if (elM) elM.textContent = mVal.toFixed(decimals);

                if (axis === 'a') {
                    if (this.wpos.length > 3) {
                        elW.closest('.dro-row').classList.remove('hidden');
                        elW.closest('.dro-row').classList.add('flex');
                    } else {
                        elW.closest('.dro-row').classList.add('hidden');
                        elW.closest('.dro-row').classList.remove('flex');
                    }
                }
            }
        });
    }
}
