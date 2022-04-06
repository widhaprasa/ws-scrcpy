import { ParamsStream } from '../../../types/ParamsStream';
import { ACTION } from '../../../common/Action';
import { ParsedUrlQuery } from 'querystring';
import { StreamClient } from './StreamClient';
import { BasePlayer, PlayerClass } from '../../player/BasePlayer';
// TODO: HBsmith DEV-14440
import { KeyInputHandler, KeyEventListener } from '../KeyInputHandler';
import { WDAMethod } from '../../../common/WDAMethod';
//

const TAG = '[StreamClientMJPEG]';

export class StreamClientMJPEG
    extends StreamClient<ParamsStream>
    // TODO: HBsmith DEV-14440
    implements KeyEventListener {
    //
    public static ACTION = ACTION.STREAM_MJPEG;
    protected static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    public static start(params: ParsedUrlQuery | ParamsStream): StreamClientMJPEG {
        // TODO: HBsmith DEV-14440
        const cc = new StreamClientMJPEG(params);
        KeyInputHandler.addEventListener(cc);
        return cc;
        //
    }

    constructor(params: ParsedUrlQuery | ParamsStream) {
        super(params);
        this.name = `[${TAG}:${this.udid}]`;
        this.udid = this.params.udid;
        this.runWebDriverAgent().then(() => {
            this.startStream();
            this.player?.play();
            // TODO: HBsmith DEV-14062
            this.setBodyClass('stream');

            const headerText = document.getElementById('control-header-device-name-text');
            if (headerText) headerText.textContent = `${this.deviceName} (${this.udid})`;
            //
        });
        this.on('wda:status', (status) => {
            if (status === 'stopped') {
                this.player?.stop();
            } else if (status === 'started') {
                this.player?.play();
            }
        });
    }

    // TODO: HBsmith DEV-14440
    public onKeyEvent(value: string): void {
        this.wdaProxy.requestWebDriverAgent(WDAMethod.SEND_TEXT, { text: value });
    }

    public onStop(ev?: string | Event): void {
        KeyInputHandler.removeEventListener(this);
        super.onStop(ev);
    }
    //

    public get action(): string {
        return StreamClientMJPEG.ACTION;
    }

    public createPlayer(udid: string, playerName?: string): BasePlayer {
        return StreamClientMJPEG.createPlayer(udid, playerName);
    }

    public getDeviceName(): string {
        return this.deviceName;
    }
}
