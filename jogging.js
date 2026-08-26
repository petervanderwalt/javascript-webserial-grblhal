// Jogging Control Module
// Handles jogging button initialization and control logic

class JoggingController {
    constructor() {
        this.initialized = false;
        this.layoutSyncBound = null;
        this.layoutResizeObserver = null;
    }

    syncLayout() {
        const panel = document.getElementById('jog-panel');
        const wrapper = panel?.querySelector('.jog-wrapper');
        const sideStack = panel?.querySelector('.jog-side-stack');
        if (!panel || !wrapper || !sideStack) return;

        const visibleAxisCols = Array.from(sideStack.children).filter((child) => {
            return child instanceof HTMLElement && getComputedStyle(child).display !== 'none';
        }).length;

        const wrapperGap = parseFloat(getComputedStyle(wrapper).gap) || 12;
        const sideGap = parseFloat(getComputedStyle(sideStack).gap) || 6;
        const wrapperWidth = wrapper.clientWidth;
        const wrapperHeight = wrapper.clientHeight;

        if (!wrapperWidth || !wrapperHeight) return;

        let xySize = Math.floor(Math.min(wrapperHeight, wrapperWidth));
        let sideWidth = 0;

        // Recalculate width from the current XY size so the combined pad never exceeds the panel width.
        for (let i = 0; i < 2; i += 1) {
            sideWidth = visibleAxisCols > 0
                ? Math.max(48, Math.min(72, Math.round(xySize * 0.3)))
                : 0;

            const totalSideWidth = visibleAxisCols > 0
                ? (visibleAxisCols * sideWidth) + ((visibleAxisCols - 1) * sideGap)
                : 0;
            const availableWidth = Math.max(0, wrapperWidth - totalSideWidth - (visibleAxisCols > 0 ? wrapperGap : 0));

            xySize = Math.floor(Math.min(wrapperHeight, availableWidth));
        }

        panel.style.setProperty('--jog-xy-size', `${Math.max(0, xySize)}px`);
        panel.style.setProperty('--jog-z-width', `${sideWidth}px`);
    }

    initLayoutSync() {
        if (this.layoutSyncBound) return;

        this.layoutSyncBound = () => {
            window.requestAnimationFrame(() => this.syncLayout());
        };

        window.addEventListener('resize', this.layoutSyncBound);
        window.addEventListener('tab-shown', this.layoutSyncBound);

        if ('ResizeObserver' in window) {
            this.layoutResizeObserver = new ResizeObserver(this.layoutSyncBound);
            const panel = document.getElementById('jog-panel');
            const aPad = document.getElementById('jog-a-pad');
            if (panel) this.layoutResizeObserver.observe(panel);
            if (aPad) this.layoutResizeObserver.observe(aPad);
        }

        this.layoutSyncBound();
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

    syncModeState() {
        const toggle = document.getElementById('jogContinuous');
        const distSelect = document.getElementById('stepSize');
        if (!toggle || !distSelect) return;

        window.store.set('jog.continuous', toggle.checked);
        distSelect.disabled = toggle.checked || !(window.ws && window.ws.isConnected);
    }

    /**
     * Initialize jogging controls
     */
    init() {
        if (this.initialized) return;

        const btns = document.querySelectorAll('[data-jog]');
        const toggle = document.getElementById('jogContinuous');
        toggle.checked = window.store.get('jog.continuous');
        this.syncModeState();

        toggle.addEventListener('change', () => {
            this.syncModeState();
        });

        document.getElementById('stepSize').addEventListener('change', (e) => {
            window.store.set('jog.step', parseFloat(e.target.value));
        });

        const feedRateSelect = document.getElementById('feedRate');
        feedRateSelect.value = window.store.get('jog.speedMode') || 'fast';

        feedRateSelect.addEventListener('change', (e) => {
            window.store.set('jog.speedMode', e.target.value);
        });

        btns.forEach(btn => {
            const dir = btn.dataset.jog;

            const startJog = (e) => {
                if (!toggle.checked) return;
                if (!window.ws || !window.ws.isConnected) { if (window.showToast) window.showToast('Cannot jog - not connected', 'plug-zap', 'error'); return; }
                const speedMode = document.getElementById('feedRate').value || 'slow';
                const f = this.getFeedForDirection(dir, speedMode);
                const isMm = window.store.get('general.units') === 'mm';
                const unit = isMm ? 'G21' : 'G20';
                
                let dist = isMm ? 10000 : 400;

                const viewer = window.viewer;
                const dro = window.dro;

                if (viewer && viewer.machineLimits && dro && dro.mpos && dro.mpos.length >= 3) {
                    const limits = viewer.machineLimits;
                    const mpos = dro.mpos; // Always in mm natively from GRBL
                    const isPos = viewer.isPositiveSpace || false;
                    const dirMask = viewer.homingDirMask || 0;

                    let travels = [];

                    if (dir.includes('X')) {
                        const boundPos = (isPos && (dirMask & 1)) ? (limits.x || 10000) : 0;
                        const boundNeg = (isPos && (dirMask & 1)) ? 0 : -(limits.x || 10000);
                        travels.push(dir.includes('X+') ? (boundPos - mpos[0]) : (mpos[0] - boundNeg));
                    }
                    if (dir.includes('Y')) {
                        const boundPos = (isPos && (dirMask & 2)) ? (limits.y || 10000) : 0;
                        const boundNeg = (isPos && (dirMask & 2)) ? 0 : -(limits.y || 10000);
                        travels.push(dir.includes('Y+') ? (boundPos - mpos[1]) : (mpos[1] - boundNeg));
                    }
                    if (dir.includes('Z')) {
                        const boundPos = (isPos && (dirMask & 4)) ? (limits.z || 10000) : 0;
                        const boundNeg = (isPos && (dirMask & 4)) ? 0 : -(limits.z || 10000);
                        travels.push(dir.includes('Z+') ? (boundPos - mpos[2]) : (mpos[2] - boundNeg));
                    }
                    if (dir.includes('A') && limits.a && mpos.length >= 4) {
                        const boundPos = (isPos && (dirMask & 8)) ? (limits.a || 10000) : 0;
                        const boundNeg = (isPos && (dirMask & 8)) ? 0 : -(limits.a || 10000);
                        travels.push(dir.includes('A+') ? (boundPos - mpos[3]) : (mpos[3] - boundNeg));
                    }

                    if (travels.length > 0) {
                        let maxTravelMm = Math.min(...travels) - 0.5; // Back off by 0.5mm buffer
                        if (maxTravelMm <= 0) return; // Already at or past soft limit
                        dist = isMm ? maxTravelMm : (maxTravelMm / 25.4);
                    }
                }

                let move = "";
                const distStr = dist.toFixed(isMm ? 2 : 4);

                if (dir.includes('X')) move += `X${dir.includes('X-') ? '-' : ''}${distStr} `;
                if (dir.includes('Y')) move += `Y${dir.includes('Y-') ? '-' : ''}${distStr} `;
                if (dir.includes('Z')) move += `Z${dir.includes('Z-') ? '-' : ''}${distStr} `;
                if (dir.includes('A')) move += `A${dir.includes('A-') ? '-' : ''}${distStr} `;

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
                if (!window.ws || !window.ws.isConnected) { if (window.showToast) window.showToast('Cannot jog - not connected', 'plug-zap', 'error'); return; }
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

            btn.addEventListener('pointerdown', (e) => {
                if (toggle.checked) {
                    if (e.cancelable) e.preventDefault();
                    btn.setPointerCapture(e.pointerId);
                    startJog(e);
                }
            });
            btn.addEventListener('pointerup', (e) => {
                if (toggle.checked) {
                    if (e.cancelable) e.preventDefault();
                    if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
                    stopJog(e);
                }
            });
            btn.addEventListener('pointercancel', (e) => {
                if (toggle.checked) {
                    if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
                    stopJog(e);
                }
            });
            btn.addEventListener('click', clickJog);
        });

        this.initLayoutSync();
        this.initialized = true;
    }
}

// Export singleton instance
window.joggingController = new JoggingController();
