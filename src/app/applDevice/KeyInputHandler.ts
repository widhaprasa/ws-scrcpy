// TODO: HBsmith DEV-14440

import { WindowsKeyCodeToKey } from '../googDevice/WindowsKeyCodeToKey';
import { KeyToCodeMap, ToUpperCodeMap } from './KeyToCodeMap';

export interface KeyEventListener {
    onKeyEvent: (keyValue: string) => void;
}

export class KeyInputHandler {
    private static readonly listeners: Set<KeyEventListener> = new Set();
    private static handler = (e: Event): void => {
        const event = e as KeyboardEvent;
        if (event.type !== 'keyup') {
            return;
        }

        let keyCode: string | undefined = event.code;
        if (!keyCode) {
            keyCode = WindowsKeyCodeToKey.get(event.keyCode);
        }
        if (!keyCode) {
            return;
        }

        let keyValue = KeyToCodeMap.get(keyCode);
        if (!keyValue) {
            return;
        }

        if (event.getModifierState('Shift') || event.getModifierState('CapsLock')) {
            const tt = ToUpperCodeMap.get(keyValue);
            if (tt) {
                keyValue = tt;
            } else {
                keyValue = keyValue.toUpperCase();
            }
        }

        KeyInputHandler.listeners.forEach((listener) => {
            if (keyValue) {
                listener.onKeyEvent(keyValue);
            }
        });
        e.preventDefault();
    };
    private static attachListeners(): void {
        document.body.addEventListener('keydown', this.handler);
        document.body.addEventListener('keyup', this.handler);
    }
    private static detachListeners(): void {
        document.body.removeEventListener('keydown', this.handler);
        document.body.removeEventListener('keyup', this.handler);
    }
    public static addEventListener(listener: KeyEventListener): void {
        if (!this.listeners.size) {
            this.attachListeners();
        }
        this.listeners.add(listener);
    }
    public static removeEventListener(listener: KeyEventListener): void {
        this.listeners.delete(listener);
        if (!this.listeners.size) {
            this.detachListeners();
        }
    }
}
