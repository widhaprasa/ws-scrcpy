import WS from 'ws';
import { Mw } from '../../mw/Mw';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { WdaRunner } from '../services/WDARunner';
import { MessageRunWdaResponse } from '../../../types/MessageRunWdaResponse';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';
import Util from '../../../app/Util';
import { WdaStatus } from '../../../common/WdaStatus';
import { Config } from '../../Config';
import { Utils } from '../../Utils';
import qs from 'qs';
import axios from 'axios';

export class WebDriverAgentProxy extends Mw {
    public static readonly TAG = 'WebDriverAgentProxy';
    protected name: string;
    private wda?: WdaRunner;
    // TODO: HBsmith DEV-14620
    private apiSessionCreated = false;
    //

    public static processChannel(ws: Multiplexer, code: string, data: ArrayBuffer): Mw | undefined {
        if (code !== ChannelCode.WDAP) {
            return;
        }
        if (!data || data.byteLength < 4) {
            return;
        }
        const buffer = Buffer.from(data);
        const length = buffer.readInt32LE(0);
        const udid = Util.utf8ByteArrayToString(buffer.slice(4, 4 + length));
        // TODO: HBsmith DEV-14260
        const service = new WebDriverAgentProxy(ws, udid);
        service.apiCreateSession(ws, udid).catch((e) => {
            console.error(Utils.getTimeISOString(), e);
        });
        return service;
        //
    }

    constructor(protected ws: Multiplexer, private readonly udid: string) {
        super(ws);
        this.name = `[${WebDriverAgentProxy.TAG}][udid: ${this.udid}]`;
    }

    private runWda(command: ControlCenterCommand): void {
        const udid = command.getUdid();
        const id = command.getId();
        // TODO: HBsmith DEV-14062
        const data = command.getData();
        const appKey = data.appKey;
        const userAgent = data.userAgent;
        //

        // TODO: apiCreateSession
        console.log('TODO: use this userAgent', udid, userAgent);
        //

        if (this.wda) {
            const message: MessageRunWdaResponse = {
                id,
                type: 'run-wda',
                data: {
                    udid: udid,
                    status: 'started',
                    code: -1,
                    text: 'WDA already started',
                },
            };
            this.sendMessage(message);
            return;
        }
        this.wda = WdaRunner.getInstance(udid);
        this.wda.on('status-change', ({ status, code, text }) => {
            this.onStatusChange(command, status, code, text);
        });
        if (this.wda.isStarted()) {
            this.onStatusChange(command, 'started');
            // TODO: HBsmith DEV-14062, DEV-14260
            this.apiSessionCreated = true;
            this.wda.setUpTest(appKey);
            //
        } else {
            // TODO: HBsmith DEV-14062, DEV-14260
            this.apiSessionCreated = true;
            this.wda.start().then(() => {
                this.wda?.setUpTest(appKey);
            });
            //
        }
    }

    private onStatusChange = (command: ControlCenterCommand, status: WdaStatus, code?: number, text?: string): void => {
        const id = command.getId();
        const udid = command.getUdid();
        const type = 'run-wda';
        const message: MessageRunWdaResponse = {
            id,
            type,
            data: {
                udid,
                status,
                code,
                text,
            },
        };
        this.sendMessage(message);
    };

    private requestWda(command: ControlCenterCommand): void {
        if (!this.wda) {
            return;
        }
        this.wda
            .request(command)
            .then((response) => {
                this.sendMessage({
                    id: command.getId(),
                    type: command.getType(),
                    data: {
                        success: true,
                        response,
                    },
                });
            })
            .catch((e) => {
                this.sendMessage({
                    id: command.getId(),
                    type: command.getType(),
                    data: {
                        success: false,
                        error: e.message,
                    },
                });
            });
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        let command: ControlCenterCommand;
        try {
            command = ControlCenterCommand.fromJSON(event.data.toString());
        } catch (e) {
            console.error(`[${WebDriverAgentProxy.TAG}], Received message: ${event.data}. Error: ${e.message}`);
            return;
        }
        const type = command.getType();
        switch (type) {
            case ControlCenterCommand.RUN_WDA:
                this.runWda(command);
                break;
            case ControlCenterCommand.REQUEST_WDA:
                this.requestWda(command);
                break;
            default:
                throw new Error(`Unsupported command: "${type}"`);
        }
    }

    public release(): void {
        // TODO: HBSmith DEV-14062, DEV-14260
        if (this.apiSessionCreated && !!this.udid) {
            this.wda?.tearDownTest();
        }
        //
        super.release();
        if (this.wda) {
            this.wda.release();
        }
        // TODO: HBsmith DEV-14260
        this.apiDeleteSession(this.udid);
        //
    }

    // TODO: HBsmith DEV-14260
    private async apiCreateSession(ws: Multiplexer, udid: string, userAgent?: string) {
        const host = Config.getInstance().getRamielApiServerEndpoint();
        const api = `/real-devices/${udid}/control/`;
        const hh = { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf8' };
        const tt = Utils.getTimestamp();
        const pp = {
            POST: api,
            timestamp: tt,
            'user-agent': userAgent,
        };
        const data = qs.stringify({
            POST: api,
            timestamp: tt,
            'user-agent': userAgent,
            signature: Utils.getSignature(pp, tt),
        });
        const url = `${host}${api}`;
        const tag = WebDriverAgentProxy.TAG;

        await axios
            .post(url, data, {
                headers: hh,
            })
            .then((rr) => {
                console.log(Utils.getTimeISOString(), `[${tag}] success to create session. resp code: ${rr.status}`);
            })
            .catch((error) => {
                console.error(
                    Utils.getTimeISOString(),
                    `[${tag}] failed to create a session. resp code: ${error.response.status}`,
                );
                let msg = `[${WebDriverAgentProxy.TAG}] failed to create a session for ${udid}`;
                if (!('response' in error)) msg = msg = `undefined response in error`;
                else if (409 == error.response.status) {
                    msg = `사용 중인 장비입니다`;
                    if (userAgent) msg += ` (${userAgent})`;
                } else if (503 == error.response.status) msg = `장비의 연결이 끊어져있습니다`;
                ws.close(4900, msg);
                throw error;
            });
    }

    private apiDeleteSession(udid: string) {
        const host = Config.getInstance().getRamielApiServerEndpoint();
        const api = `/real-devices/${udid}/control/`;
        const hh = { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf8' };
        const tt = Utils.getTimestamp();
        const pp = {
            DELETE: api,
            timestamp: tt,
            // 'user-agent': this.userAgent,    // TODO
        };
        const data = qs.stringify({
            DELETE: api,
            timestamp: tt,
            // 'user-agent': this.userAgent,    // TODO
            signature: Utils.getSignature(pp, tt),
        });
        const url = `${host}${api}`;
        const tag = WebDriverAgentProxy.TAG;

        axios
            .delete(url, {
                headers: hh,
                data: data,
            })
            .then((rr) => {
                console.log(Utils.getTimeISOString(), `[${tag}] success to delete a session. resp code: ${rr.status}`);
            })
            .catch((error) => {
                console.error(
                    Utils.getTimeISOString(),
                    `[${tag}] failed to delete a session. resp code: ${error.response.status}`,
                );
            });
    }
    //
}
