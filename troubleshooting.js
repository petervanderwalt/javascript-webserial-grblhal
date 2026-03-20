export class TroubleshootingHandler {
    constructor(ws, store) {
        this.ws = ws;
        this.store = store;
        this.lastPins = "";
    }

    /**
     * Update the visual state of pin indicators
     * @param {string} pins - The Pn: string from grblHAL status report (e.g. "PXYZ")
     */
    updatePins(pins) {
        if (pins === this.lastPins) return;
        this.lastPins = pins;

        // All grblHAL Pn: signals
        // Limit switches: X, Y, Z, A, B, C, U, V, W
        // Probe: P (triggered), O (disconnected)
        // Control: D (door), R (reset), H (hold), S (start), E (e-stop), L (block delete), T (optional stop), Q (single step)
        // Motor: M (warning), F (fault)
        const pinChars = ['X', 'Y', 'Z', 'A', 'B', 'C', 'U', 'V', 'W', 'P', 'O', 'D', 'R', 'H', 'S', 'E', 'L', 'T', 'Q', 'M', 'F'];

        pinChars.forEach(char => {
            const el = document.getElementById(`pin-indicator-${char}`);
            if (!el) return;

            const isActive = pins.includes(char);
            
            // Troubleshooting tab uses the .signal-badge class
            if (isActive) {
                el.classList.remove('signal-off');
                el.classList.add('signal-on');
                el.textContent = 'ON';
                
                // Color overrides for critical/warning pins
                if (['E', 'F'].includes(char)) {
                    // Critical Error (Red)
                    el.style.cssText = 'background:#fee2e2;color:#dc2626;border-color:#fca5a5;box-shadow:0 0 8px rgba(220,38,38,0.25)';
                } else if (['M', 'O'].includes(char)) {
                    // Warning (Yellow)
                    el.style.cssText = 'background:#fef9c3;color:#ca8a04;border-color:#fde047;box-shadow:0 0 8px rgba(202,138,4,0.2)';
                } else if (['X', 'Y', 'Z', 'A', 'B', 'C', 'U', 'V', 'W', 'D'].includes(char)) {
                    // Input/Safety (Soft Red)
                    el.style.cssText = 'background:#fee2e2;color:#dc2626;border-color:#fca5a5;box-shadow:0 0 8px rgba(220,38,38,0.2)';
                } else {
                    // Normal Active (Green)
                    el.style.cssText = '';
                }
            } else {
                el.classList.remove('signal-on');
                el.classList.add('signal-off');
                el.textContent = 'OFF';
                el.style.cssText = '';
            }
        });
    }

    refresh() {
        // Troubleshooting is passive (updates from status reports), 
        // but we could request a full status here if needed.
        if (window.requestFullStatus) window.requestFullStatus();
    }
}
