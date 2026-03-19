// Jogging Control Module
// Handles jogging button initialization and control logic

class JoggingController {
    constructor() {
        this.initialized = false;
    }

    getFeedForDirection(dir, speedMode) {
        let maxRate = 1000;
        let rates = [];
        
        if (dir.includes('X') && window.grblSettings?.settings['110']) rates.push(parseFloat(window.grblSettings.settings['110'].val));
        if (dir.includes('Y') && window.grblSettings?.settings['111']) rates.push(parseFloat(window.grblSettings.settings['111'].val));
        if (dir.includes('Z') && window.grblSettings?.settings['112']) rates.push(parseFloat(window.grblSettings.settings['112'].val));
        if (dir.includes('A') && window.grblSettings?.settings['113']) rates.push(parseFloat(window.grblSettings.settings['113'].val));
        
        if (rates.length > 0) maxRate = Math.min(...rates);

        const isMm = window.store.get('general.units') === 'mm';
        if (!isMm) maxRate = maxRate / 25.4;

        let f = maxRate;
        if (speedMode === 'med') f = maxRate * 0.5;
        if (speedMode === 'slow') f = maxRate * 0.25;
        
        return Math.max(f, 0.1).toFixed(isMm ? 0 : 2);
    }

    /**
     * Initialize jogging controls
     */
    init() {
        if (this.initialized) return;

        const btns = document.querySelectorAll('[data-jog]');
        const toggle = document.getElementById('jogContinuous');
        toggle.checked = window.store.get('jog.continuous');
        document.getElementById('stepSize').disabled = toggle.checked;

        toggle.addEventListener('change', () => {
            window.store.set('jog.continuous', toggle.checked);
            document.getElementById('stepSize').disabled = toggle.checked;
        });

        document.getElementById('stepSize').addEventListener('change', (e) => {
            window.store.set('jog.step', parseFloat(e.target.value));
        });

        document.getElementById('feedRate').addEventListener('change', (e) => {
            window.store.set('jog.speedMode', e.target.value);
        });

        btns.forEach(btn => {
            const dir = btn.dataset.jog;

            const startJog = (e) => {
                if (!toggle.checked) return;
                const speedMode = document.getElementById('feedRate').value || 'slow';
                const f = this.getFeedForDirection(dir, speedMode);
                const isMm = window.store.get('general.units') === 'mm';
                const unit = isMm ? 'G21' : 'G20';
                const dist = isMm ? '1000' : '50';
                let move = "";
                if (dir.includes('X')) move += `X${dir.includes('X-') ? '-' : ''}${dist} `;
                if (dir.includes('Y')) move += `Y${dir.includes('Y-') ? '-' : ''}${dist} `;
                if (dir.includes('Z')) move += `Z${dir.includes('Z-') ? '-' : ''}${dist} `;
                if (dir.includes('A')) move += `A${dir.includes('A-') ? '-' : ''}${dist} `;

                // Visual feedback
                btn.classList.add('bg-black/20', 'shadow-inner');

                window.ws.sendCommand(`$J=G91 ${unit} ${move}F${f}`);
            };

            const stopJog = (e) => {
                // Clear visual feedback unconditionally
                btn.classList.remove('bg-black/20', 'shadow-inner');

                if (!toggle.checked) return;
                window.ws.sendRealtime('\x85');
            };

            const clickJog = () => {
                if (toggle.checked) return;
                const s = document.getElementById('stepSize').value;
                const speedMode = document.getElementById('feedRate').value || 'slow';
                const f = this.getFeedForDirection(dir, speedMode);
                const isMm = window.store.get('general.units') === 'mm';
                const unit = isMm ? 'G21' : 'G20';
                let move = "";
                if (dir.includes('X')) move += `X${dir.includes('X-') ? '-' : ''}${s} `;
                if (dir.includes('Y')) move += `Y${dir.includes('Y-') ? '-' : ''}${s} `;
                if (dir.includes('Z')) move += `Z${dir.includes('Z-') ? '-' : ''}${s} `;
                if (dir.includes('A')) move += `A${dir.includes('A-') ? '-' : ''}${s} `;

                // Brief visual flash for click
                btn.classList.add('bg-black/20', 'shadow-inner');
                setTimeout(() => btn.classList.remove('bg-black/20', 'shadow-inner'), 150);

                window.ws.sendCommand(`$J=G91 ${unit} ${move}F${f}`);
            };

            btn.addEventListener('mousedown', startJog);
            btn.addEventListener('mouseup', stopJog);
            btn.addEventListener('mouseleave', stopJog);
            btn.addEventListener('touchstart', (e) => {
                if (toggle.checked) e.preventDefault();
                startJog(e);
            }, { passive: false });
            btn.addEventListener('touchend', (e) => {
                if (toggle.checked) e.preventDefault();
                stopJog(e);
            });
            btn.addEventListener('click', clickJog);
        });

        this.initialized = true;
    }
}

// Export singleton instance
window.joggingController = new JoggingController();
