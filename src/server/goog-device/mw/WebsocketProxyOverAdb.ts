import { WebsocketProxy } from '../../mw/WebsocketProxy';
import { AdbUtils } from '../AdbUtils';
import WebSocket from 'ws';
import { RequestParameters } from '../../mw/Mw';
import { ACTION } from '../../../common/Action';

// TODO: HBsmith DEV-12386
import { Device } from '../Device';
//
// TODO: HBsmith DEV-12387
import { Config } from '../../Config';
import { Utils } from '../../Utils';
import axios from 'axios';
//

export class WebsocketProxyOverAdb extends WebsocketProxy {
    // TODO: HBsmith DEV-12386
    private udid = '';
    private appKey = '';
    //
    // TODO: HBsmith DEV-12386
    private apiSessionCreated = false;
    //

    public static processRequest(ws: WebSocket, params: RequestParameters): WebsocketProxy | undefined {
        const { parsedQuery, parsedUrl } = params;
        let udid: string | string[] = '';
        let remote: string | string[] = '';
        let path: string | string[] = '';
        let isSuitable = false;
        if (parsedQuery?.action === ACTION.PROXY_ADB) {
            isSuitable = true;
            remote = parsedQuery.remote;
            udid = parsedQuery.udid;
            path = parsedQuery.path;
        }
        if (parsedUrl && parsedUrl.path) {
            const temp = parsedUrl.path.split('/');
            // Shortcut for action=proxy, without query string
            if (temp.length >= 4 && temp[0] === '' && temp[1] === ACTION.PROXY_ADB) {
                isSuitable = true;
                temp.splice(0, 2);
                udid = decodeURIComponent(temp.shift() || '');
                remote = decodeURIComponent(temp.shift() || '');
                path = temp.join('/') || '/';
            }
        }
        if (!isSuitable) {
            return;
        }
        if (typeof remote !== 'string' || !remote) {
            ws.close(4003, `[${this.TAG}] Invalid value "${remote}" for "remote" parameter`);
            return;
        }
        if (typeof udid !== 'string' || !udid) {
            ws.close(4003, `[${this.TAG}] Invalid value "${udid}" for "udid" parameter`);
            return;
        }
        if (path && typeof path !== 'string') {
            ws.close(4003, `[${this.TAG}] Invalid value "${path}" for "path" parameter`);
            return;
        }
        // TODO: HBsmith DEV-12386
        let appKey = '';
        if (parsedQuery?.app_key !== null && parsedQuery?.app_key !== undefined) {
            appKey = parsedQuery['app_key'].toString();
        }
        // TODO: HBsmith DEV-12386
        return this.createProxyOverAdb(ws, udid, remote, path, appKey);
        //
    }

    // TODO: HBsmith DEV-12387
    private static async apiCreateSession(ws: WebSocket, udid: string) {
        const host = Config.getInstance().getRamielApiServerEndpoint();
        const api = `/devices/android/${udid}/control/`;
        const pp = {
            POST: api,
            timestamp: Utils.getTimestamp(),
        };
        const url = `${host}${api}`;

        await axios
            .post(url, {
                POST: api,
                timestamp: Utils.getTimestamp(),
                signature: Utils.getSignature(pp),
            })
            .then((resp) => {
                return resp.status;
            })
            .catch((error) => {
                let msg = `[${this.TAG}] failed to create a session for ${udid}`;
                if (409 == error.response.status) msg = `사용 중인 장비입니다`;
                if (503 == error.response.status) msg = `장비의 연결이 끊어져있습니다`;
                ws.close(4900, msg);
                throw error;
            });
    }

    private apiDeleteSession(udid: string) {
        const host = Config.getInstance().getRamielApiServerEndpoint();
        const api = `/devices/android/${udid}/control/`;
        const p1 = {
            DELETE: api,
            timestamp: Utils.getTimestamp(),
        };
        const p2 = {
            DELETE: api,
            timestamp: Utils.getTimestamp(),
            signature: Utils.getSignature(p1),
        };
        const queryString = Utils.getBaseString(p2);
        const url = `${host}${api}?${queryString}`;
        const tag = WebsocketProxyOverAdb.TAG;
        axios
            .delete(url)
            .then((response) => {
                console.log(`[${tag}] success to delete session. resp code: ${response.status}`);
            })
            .catch((error) => {
                console.error(`[${tag}] failed to delete session. resp code: ${error.response.status}`);
            });
    }
    //

    public static createProxyOverAdb(
        ws: WebSocket,
        udid: string,
        remote: string,
        path?: string,
        appKey?: string, // TODO: HBsmith DEV-12386
    ): WebsocketProxyOverAdb {
        const service = new WebsocketProxyOverAdb(ws);
        // TODO: HBsmith DEV-12387
        this.apiCreateSession(ws, udid)
            .then(() => {
                AdbUtils.forward(udid, remote)
                    .then((port) => {
                        return service.init(`ws://127.0.0.1:${port}${path ? path : ''}`);
                    })
                    .catch((e) => {
                        const msg = `[${this.TAG}] Failed to start service: ${e.message}`;
                        console.error(msg);
                        ws.close(4005, msg);
                    });
                service.setUpTest(udid, appKey);
            })
            .catch(() => {
                // console.error(e);
            });
        //
        return service;
    }

    // TODO: HBsmith DEV-12386
    public release(): void {
        this.tearDownTest();
        super.release();
    }

    private getDevice(): Device | null {
        if (!this.udid) {
            return null;
        }
        return new Device(this.udid, 'device');
    }

    private setUpTest(udid: string, appKey?: string): void {
        this.apiSessionCreated = true;
        if (udid) {
            this.udid = udid;
        }
        if (appKey) {
            this.appKey = appKey;
        }

        const device = this.getDevice();
        if (!device) {
            return;
        }
        // send key event code 82 twice for deterministic unlock
        device.runShellCommandAdbKit('input keyevent 82').then((output) => {
            console.log(output);
        });
        device.runShellCommandAdbKit('input keyevent 82').then((output) => {
            console.log(output);
        });

        if (this.appKey) {
            device.runShellCommandAdbKit(`am force-stop '${this.appKey}'`).then((output) => {
                console.log(output);
            });
            device
                .runShellCommandAdbKit(`monkey -p '${this.appKey}' -c android.intent.category.LAUNCHER 1`)
                .then((output) => {
                    console.log(output);
                });
        }
    }

    private tearDownTest(): void {
        if (!this.apiSessionCreated || !this.udid) {
            return;
        }

        this.apiDeleteSession(this.udid);

        const device = this.getDevice();
        if (device) {
            if (this.appKey) {
                device.runShellCommandAdbKit(`am force-stop '${this.appKey}'`).then((output) => {
                    console.log(output);
                });
            }
            device.runShellCommandAdbKit('input keyevent 26').then((output) => {
                console.log(output);
            });
        }
    }
    //
}
