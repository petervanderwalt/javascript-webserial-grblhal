const modalRegistry = new Map();
const modalStack = [];

function resolveElement(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.getElementById(target);
    return target;
}

function removeFromStack(controller) {
    const idx = modalStack.indexOf(controller);
    if (idx !== -1) modalStack.splice(idx, 1);
}

class AppModal {
    constructor(target, options = {}) {
        const root = resolveElement(target);
        if (!root) throw new Error('Modal root not found');

        this.root = root;
        this.options = {
            closeOnBackdrop: true,
            closeOnEscape: true,
            onShow: null,
            onHide: null,
            ...options
        };

        this.panel = this.root.querySelector('[data-modal-panel]') || this.root.firstElementChild;
        this.lastFocusedElement = null;
        this.root.classList.add('oz-modal');
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-modal', 'true');
        this.root.setAttribute('aria-hidden', this.isOpen() ? 'false' : 'true');

        this._bindEvents();
    }

    _bindEvents() {
        this.root.addEventListener('click', (event) => {
            const closeTrigger = event.target.closest('[data-modal-close]');
            if (closeTrigger) {
                event.preventDefault();
                event.stopPropagation();
                this.hide();
                return;
            }

            if (this.options.closeOnBackdrop && event.target === this.root) {
                this.hide();
            }
        });
    }

    isOpen() {
        return !this.root.classList.contains('hidden');
    }

    getPrimaryAction() {
        return this.root.querySelector(
            '[data-modal-primary], .oz-modal__footer .btn-primary:not(:disabled), .btn-primary:not(:disabled)'
        );
    }

    focusPrimaryAction() {
        const primaryAction = this.getPrimaryAction();
        if (!primaryAction || typeof primaryAction.focus !== 'function') return;

        requestAnimationFrame(() => {
            if (!this.isOpen()) return;
            primaryAction.focus();
        });
    }

    show() {
        if (this.isOpen()) return;
        const activeEl = document.activeElement;
        this.lastFocusedElement = activeEl instanceof HTMLElement ? activeEl : null;
        this.root.classList.remove('hidden');
        this.root.setAttribute('aria-hidden', 'false');
        removeFromStack(this);
        modalStack.push(this);
        if (typeof this.options.onShow === 'function') this.options.onShow();
        this.focusPrimaryAction();
    }

    hide() {
        if (!this.isOpen()) return;
        this.root.classList.add('hidden');
        this.root.setAttribute('aria-hidden', 'true');
        removeFromStack(this);
        if (typeof this.options.onHide === 'function') this.options.onHide();
        if (this.lastFocusedElement && typeof this.lastFocusedElement.focus === 'function') {
            this.lastFocusedElement.focus();
        }
        this.lastFocusedElement = null;
    }

    toggle(force) {
        if (typeof force === 'boolean') {
            if (force) this.show();
            else this.hide();
            return;
        }

        if (this.isOpen()) this.hide();
        else this.show();
    }
}

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;

    for (let i = modalStack.length - 1; i >= 0; i -= 1) {
        const modal = modalStack[i];
        if (!modal.isOpen()) continue;
        if (!modal.options.closeOnEscape) return;
        modal.hide();
        return;
    }
});

export function registerModal(target, options = {}) {
    const root = resolveElement(target);
    if (!root) return null;

    const key = root.id || root;
    if (modalRegistry.has(key)) return modalRegistry.get(key);

    const controller = new AppModal(root, options);
    modalRegistry.set(key, controller);
    return controller;
}

export function getModal(target) {
    const root = resolveElement(target);
    if (!root) return null;
    const key = root.id || root;
    return modalRegistry.get(key) || registerModal(root);
}

window.registerAppModal = registerModal;
window.getAppModal = getModal;

