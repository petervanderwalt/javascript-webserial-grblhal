export class DROHandler {
    constructor(ws, term) {
        this.ws = ws;
        this.term = term;
        this.isMm = true; // Default state

        // Coordinate State
        this.wco = [0, 0, 0, 0]; // Work Coordinate Offset
        this.wpos = [0, 0, 0, 0];
        this.mpos = [0, 0, 0, 0];
    }

    // --- Command Senders ---

    setZero(axis) {
        // P0 targets the currently active WCS (G54-G59.3)
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

    // --- NEW: Predefined Positions (G28/G30) ---
    goToPredefined(pos) {
        // pos is 28 or 30
        this.ws.sendCommand(`G${pos}`);
        this.term.writeln(`\x1b[34m> Moving to G${pos} Position\x1b[0m`);
    }

    setPredefined(pos) {
        // pos is 28 or 30
        if(confirm(`Set G${pos} location to current Machine Coordinates?`)) {
            this.ws.sendCommand(`G${pos}.1`);
            this.term.writeln(`\x1b[32m> G${pos} Position Set.\x1b[0m`);
        }
    }
    // -------------------------------------------

    toggleUnits() {
        const toggle = document.getElementById('unitToggle');
        this.isMm = toggle.checked;

        // Save to local storage
        localStorage.setItem('grbl_units', this.isMm ? 'mm' : 'in');

        const label = document.getElementById('unitLabel');
        if(label) label.innerText = this.isMm ? 'MM' : 'IN';

        // Update Controller Modal State
        if (this.isMm) this.ws.sendCommand('G21');
        else this.ws.sendCommand('G20');

        // Update UI Elements (Jog steps, Feedrate)
        this.updateJogOptions();

        // Force re-render of DRO values immediately
        this._updateAxisDisplay();
    }

    /**
     * Re-renders the step size dropdown with units.
     * Handles value conversion if switching units.
     */
    updateJogOptions() {
        // Update Step Distances
        const select = document.getElementById('stepSize');
        if (select) {
            const mmSteps = [0.1, 1, 10, 100];
            const inSteps = [0.001, 0.01, 0.1, 1];
            const steps = this.isMm ? mmSteps : inSteps;
            const unit = this.isMm ? 'mm' : 'in';

            // 1. Determine which index was selected before redraw
            const prevIndex = select.selectedIndex;

            // 2. Redraw Options
            select.innerHTML = '';
            steps.forEach((step) => {
                const opt = document.createElement('option');
                opt.value = step;
                opt.innerText = `${step} ${unit}`;
                select.appendChild(opt);
            });

            // 3. Restore selection
            select.selectedIndex = (prevIndex > -1 && prevIndex < steps.length) ? prevIndex : 2;

            // 4. Save new value to storage
            localStorage.setItem('grbl_step_size', select.value);
        }

        // Update Feedrate
        const feedInput = document.getElementById('feedRate');
        if (feedInput) {
            let currentFeed = parseFloat(feedInput.value) || 0;
            if (this.isMm) {
                // Was Inch? Convert to MM
                if(currentFeed < 200) {
                    feedInput.value = Math.round(currentFeed * 25.4);
                } else if (currentFeed === 0) {
                     feedInput.value = 1000; // Default
                }
            } else {
                // Was MM? Convert to Inch
                if(currentFeed > 100) {
                    feedInput.value = Math.round(currentFeed / 25.4);
                } else if (currentFeed === 0) {
                    feedInput.value = 20; // Default
                }
            }
            localStorage.setItem('grbl_feed_rate', feedInput.value);
        }
    }

    // --- Status Parsing ---

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
