// Jogging Control Module
// Handles jogging button initialization and control logic

class JoggingController {
    constructor() {
        this.initialized = false;
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
            window.store.set('jog.feed', parseFloat(e.target.value));
        });

        btns.forEach(btn => {
            const dir = btn.dataset.jog;

            const startJog = (e) => {
                if (!toggle.checked) return;
                e.preventDefault();
                const f = document.getElementById('feedRate').value;
                const isMm = window.store.get('general.units') === 'mm';
                const unit = isMm ? 'G21' : 'G20';
                const dist = isMm ? '1000' : '50';
                let move = "";
                if (dir.includes('X')) move += `X${dir.includes('X-') ? '-' : ''}${dist} `;
                if (dir.includes('Y')) move += `Y${dir.includes('Y-') ? '-' : ''}${dist} `;
                if (dir.includes('Z')) move += `Z${dir.includes('Z-') ? '-' : ''}${dist} `;
                if (dir.includes('A')) move += `A${dir.includes('A-') ? '-' : ''}${dist} `;
                window.ws.sendCommand(`$J=G91 ${unit} ${move}F${f}`);
            };

            const stopJog = (e) => {
                if (!toggle.checked) return;
                window.ws.sendRealtime('\x85');
            };

            const clickJog = () => {
                if (toggle.checked) return;
                const s = document.getElementById('stepSize').value;
                const f = document.getElementById('feedRate').value;
                const isMm = window.store.get('general.units') === 'mm';
                const unit = isMm ? 'G21' : 'G20';
                let move = "";
                if (dir.includes('X')) move += `X${dir.includes('X-') ? '-' : ''}${s} `;
                if (dir.includes('Y')) move += `Y${dir.includes('Y-') ? '-' : ''}${s} `;
                if (dir.includes('Z')) move += `Z${dir.includes('Z-') ? '-' : ''}${s} `;
                if (dir.includes('A')) move += `A${dir.includes('A-') ? '-' : ''}${s} `;
                window.ws.sendCommand(`$J=G91 ${unit} ${move}F${f}`);
            };

            btn.addEventListener('mousedown', startJog);
            btn.addEventListener('mouseup', stopJog);
            btn.addEventListener('mouseleave', stopJog);
            btn.addEventListener('touchstart', (e) => { e.preventDefault(); startJog(e); }, { passive: false });
            btn.addEventListener('touchend', (e) => { e.preventDefault(); stopJog(e); });
            btn.addEventListener('click', clickJog);
        });

        this.initialized = true;
    }
}

// Export singleton instance
window.joggingController = new JoggingController();
