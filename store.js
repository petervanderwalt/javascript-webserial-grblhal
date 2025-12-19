export class AppStore {
    constructor() {
        // Default Configuration
        this.defaults = {
            general: {
                units: 'mm', // 'mm' or 'in'
            },
            jog: {
                continuous: false,
                step: 10,
                feed: 1000
            },
            probe: {
                toolDiameter: 6.0,
                plateThickness: 10,
                xyPlateOffset: 10,
                feed: 100,
                feedLatch: 25,
                travel: 25,
                retract: 2,
                clearance: 5,
                zDepth: 5,
                bossW: 50,
                bossH: 50,
                usePlate: true
            },
            surfacing: {
                toolDiameter: 6.35,
                stepover: 40,
                feed: 2000,
                rpm: 16000,
                width: 100,
                height: 100,
                direction: 'X',
                depthPerPass: 1.0,
                finalDepth: 3.0,
                clearance: 5.0,
                useCoolant: false,
                useFraming: false // Default off, but available
            }
        };

        this.data = { ...this.defaults };
        this.load();
    }

    load() {
        const stored = localStorage.getItem('cnc_app_config');
        if (stored) {
            try {
                // Deep merge to ensure new keys in defaults are preserved
                const parsed = JSON.parse(stored);
                this.data = this._deepMerge(this.data, parsed);
            } catch (e) {
                console.error("Failed to load settings", e);
            }
        }
    }

    save() {
        localStorage.setItem('cnc_app_config', JSON.stringify(this.data));
    }

    // Get a specific setting (e.g., 'probe.toolDiameter')
    get(path) {
        return path.split('.').reduce((obj, key) => obj && obj[key], this.data);
    }

    // Set a specific setting and save
    set(path, value) {
        const keys = path.split('.');
        const last = keys.pop();
        const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.data);
        target[last] = value;
        this.save();
    }

    // Helper for merging objects
    _deepMerge(target, source) {
        for (const key in source) {
            if (source[key] instanceof Object && key in target) {
                Object.assign(source[key], this._deepMerge(target[key], source[key]));
            }
        }
        Object.assign(target || {}, source);
        return target;
    }
}
