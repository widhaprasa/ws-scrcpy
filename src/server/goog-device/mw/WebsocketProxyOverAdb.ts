import { WebsocketProxy } from '../../mw/WebsocketProxy';
import { AdbUtils } from '../AdbUtils';
import WS from 'ws';
import { RequestParameters } from '../../mw/Mw';
import { ACTION } from '../../../common/Action';

// TODO: HBsmith
import { Device } from '../Device';
import { Config } from '../../Config';
import { Utils, Logger } from '../../Utils';
import axios from 'axios';
import qs from 'qs';
import KeyEvent from '../../../app/googDevice/android/KeyEvent';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ControlMessage } from '../../../app/controlMessage/ControlMessage';
import * as Sentry from '@sentry/node'; // TODO: HBsmith
//

export class WebsocketProxyOverAdb extends WebsocketProxy {
    // TODO: HBsmith
    private udid = '';
    private appKey = '';
    private userAgent = '';
    private defaultIME = '';
    private apiSessionCreated = false;
    private logger: Logger;
    private lastHeartbeat: number = Date.now();
    private readonly heartbeatTimer: NodeJS.Timeout;

    constructor(ws: WS | Multiplexer, udid: string) {
        super(ws);
        this.logger = new Logger(udid, 'Android');
        this.heartbeatTimer = setInterval(() => {
            if (Date.now() - this.lastHeartbeat < 120 * 1000) {
                return;
            }
            this.ws.close(4900, 'Heartbeat timeout');
        }, 1000);
    }
    //

    public static processRequest(ws: WS, params: RequestParameters): WebsocketProxy | undefined {
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
        /*
        // TODO: HBsmith
        let appKey = '';
        let userAgent = '';
        if (parsedQuery) {
            if (parsedQuery['app_key']) {
                appKey = parsedQuery['app_key'].toString();
            }
            if (parsedQuery['user-agent']) {
                userAgent = parsedQuery['user-agent'].toString();
            }
        }

        return this.createProxyOverAdb(ws, udid, remote, path, appKey, userAgent);
        //
        */

        const service = new WebsocketProxyOverAdb(ws, udid);
        AdbUtils.forward(udid, remote)
            .then((port) => {
                return service.init(`ws://127.0.0.1:${port}${path ? path : ''}`);
            })
            .catch((e) => {
                const msg = `[${this.TAG}] Failed to start service: ${e.message}`;
                console.error(msg);
                ws.close(4005, msg);
            });
        return service;
    }

    // TODO: HBsmith
    private static async apiCreateSession(ws: WS, udid: string, userAgent?: string) {
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
            signature: Utils.getSignature(pp),
        });
        const url = `${host}${api}`;
        const tag = WebsocketProxyOverAdb.TAG;

        return axios
            .post(url, data, {
                headers: hh,
            })
            .then((rr) => {
                console.log(
                    Utils.getTimeISOString(),
                    udid,
                    `[${tag}] success to create session. resp code: ${rr.status}`,
                );
            })
            .catch((e) => {
                e.message = `[${this.TAG}] failed to create a session for ${udid}`;
                if (e.response) {
                    if (409 === e.response.status) {
                        const userAgent = e.response.data['user-agent'];
                        e.ramiel_message = e.message = '사용 중인 장비입니다';
                        if (userAgent) e.message += ` (${userAgent})`;
                        e.ramiel_contexts = { 'User Agent': userAgent };
                    } else if (410 === e.response.status) {
                        e.ramiel_message = e.message = `장비의 연결이 끊어져 있습니다`;
                    }
                } else if (e.request) {
                    e.ramiel_message = e.message = 'api server is not responding';
                } else {
                    e.ramiel_message = e.message;
                }
                ws.close(4900, e.message);
                throw e;
            });
    }

    public static deleteSession(udid: string, userAgent: string, logger: Logger | null = null) {
        const host = Config.getInstance().getRamielApiServerEndpoint();
        const api = `/real-devices/${udid}/control/`;
        const hh = { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf8' };
        const tt = Utils.getTimestamp();
        const pp = {
            DELETE: api,
            timestamp: tt,
            'user-agent': userAgent,
        };
        const data = qs.stringify({
            DELETE: api,
            timestamp: tt,
            'user-agent': userAgent,
            signature: Utils.getSignature(pp),
        });
        const url = `${host}${api}`;
        const tag = WebsocketProxyOverAdb.TAG;

        axios
            .delete(url, {
                headers: hh,
                data: data,
            })
            .then((rr) => {
                if (logger) logger.info(`[${tag}] success to delete a session. resp code: ${rr.status}`);
            })
            .catch((e) => {
                let status;
                try {
                    status = 'response' in e && 'status' in e.response ? e.response.status : 'unknown_android';
                } catch {
                    status = e.toString();
                }
                const mm = `[${tag}] failed to create a session: ${status}`;
                if (logger) logger.error(mm);
            });
    }

    private apiDeleteSession() {
        if (!this.udid) return;
        WebsocketProxyOverAdb.deleteSession(this.udid, this.userAgent, this.logger);
    }
    //

    public static createProxyOverAdb(
        ws: WS,
        udid: string,
        remote: string,
        path?: string,
        appKey?: string, // TODO: HBsmith
        userAgent?: string, // TODO: HBsmith
    ): WebsocketProxyOverAdb {
        // TODO: HBsmith
        const service = new WebsocketProxyOverAdb(ws, udid);
        this.apiCreateSession(ws, udid, userAgent)
            .then(() => {
                return AdbUtils.forward(udid, remote);
            })
            .then((port) => {
                return service.init(`ws://127.0.0.1:${port}${path ? path : ''}`);
            })
            .then(() => {
                return service.setUpTest(udid, appKey, userAgent);
            })
            .then(() => {
                return service.setUpGitInfo();
            })
            .catch((_) => {
            });
        //
        return service;
    }

    // TODO: HBsmith
    public release(): void {
        this.tearDownTest();
        super.release();
        clearInterval(this.heartbeatTimer);
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        try {
            const [type, value] = event.data;
            if (type === ControlMessage.TYPE_ADB_CONTROL) {
                const device = this.getDevice();
                if (!device) {
                    return;
                }

                switch (value) {
                    case ControlMessage.TYPE_ADB_INSTALL_APK: {
                        const bb = event.data.slice(6);
                        const fileName = bb.toString();
                        const pathToApk = `/data/local/tmp/${fileName}`;
                        // AdbKit.install is not working
                        device
                            .runShellCommandAdbKit(`pm install -r '${pathToApk}'`)
                            .then((rr) => {
                                if (rr === 'Success') {
                                    this.logger.info(`success to install apk: ${fileName}`);
                                    return device.runShellCommandAdbKit(`rm -f '${pathToApk}'`);
                                } else if (rr === 'Failure [INSTALL_FAILED_TEST_ONLY: installPackageLI]') {
                                    return device.runShellCommandAdbKit(`pm install -r -t '${pathToApk}'`);
                                }
                                return;
                            })
                            .then((rr) => {
                                if (rr === 'Success') {
                                    this.logger.info(`success to install test apk: ${fileName}`);
                                    return device.runShellCommandAdbKit(`rm -f '${pathToApk}'`);
                                }
                                return;
                            });
                        return;
                    }
                    case ControlMessage.TYPE_ADB_CONTROL_SWIPE_DOWN:
                    case ControlMessage.TYPE_ADB_CONTROL_SWIPE_UP: {
                        let isLandscape = false;
                        device
                            .runShellCommandAdbKit('dumpsys window displays | grep mCurrentRotation | tail -1')
                            .then((rr) => {
                                if (rr) {
                                    const [oo] = rr.match(/\d+/);
                                    isLandscape = oo === '90' || oo === '270';
                                }
                                return device.runShellCommandAdbKit('wm size | tail -1');
                            })
                            .then((rr) => {
                                if (!rr) throw Error('Failed to get screen size');

                                let [, ww, hh] = rr.match(/(\d+)x(\d+)/);
                                if (isLandscape) {
                                    [ww, hh] = [hh, ww];
                                }

                                const xx = parseInt(ww) / 2;
                                let y1 = parseInt(hh) / 4;
                                let y2 = (parseInt(hh) * 4) / 5;
                                if (value === ControlMessage.TYPE_ADB_CONTROL_SWIPE_UP) {
                                    [y1, y2] = [y2, y1];
                                }

                                return device
                                    .runShellCommandAdbKit(`input swipe ${xx} ${y1} ${xx} ${y2} 2000`)
                                    .then(() => {
                                        this.logger.info(`Success to swipe: ${xx} ${y1} ${xx} ${y2} 2000`);
                                    });
                            })
                            .catch((e) => {
                                this.captureException(e, 'Failed to swipe');
                            });
                        return;
                    }
                    case ControlMessage.TYPE_ADB_REBOOT: {
                        device.runShellCommandAdbKit('reboot').catch((e) => {
                            this.captureException(e, 'Failed to reboot');
                        });
                        return;
                    }
                    case ControlMessage.TYPE_ADB_TERMINATE_APP: {
                        device
                            .runShellCommandAdbKit("dumpsys window | grep -E 'mCurrentFocus'")
                            .then((rr) => {
                                const mm = rr.match(/mCurrentFocus=Window\{.*\}/);
                                let pp = mm ? mm[0] : '';
                                if (!pp) {
                                    return;
                                }
                                pp = pp.split('/')[0].split(' ')[2];
                                if (pp !== 'com.sec.android.app.launcher') {
                                    return device.runShellCommandAdbKit(`am force-stop ${pp}`);
                                }
                                return;
                            })
                            .catch((e) => {
                                this.captureException(e, 'Failed to termination');
                            });
                        return;
                    }
                    case ControlMessage.TYPE_ADB_UNINSTALL_APK: {
                        const bb = event.data.slice(6);
                        const appKey = bb.toString();
                        device.runShellCommandAdbKit(`pm uninstall -k --user 0 ${appKey}`).catch((e) => {
                            this.captureException(e, `Failed to uninstall apk: ${appKey}`);
                        });
                        return;
                    }
                    case ControlMessage.TYPE_ADB_LAUNCH_APK: {
                        const bb = event.data.slice(6);
                        const aa = bb.toString();
                        const cc = `monkey -p '${aa}' -c android.intent.category.LAUNCHER 1`;
                        device.runShellCommandAdbKit(cc).catch((e) => {
                            this.captureException(e, `Failed to uninstall apk: ${aa}`);
                        });
                        return;
                    }
                    case ControlMessage.TYPE_ADB_SEND_TEXT: {
                        const bb = event.data.slice(6);
                        const text = bb.toString();
                        const kk = 'io.hbsmith.bardiel/.AdbIME';

                        let cc = 'ime list -a -s';
                        device
                            .runShellCommandAdbKit(cc)
                            .then((rr) => {
                                const tt = /io.hbsmith.bardiel\/.AdbIME/;
                                if (!tt.test(rr)) throw Error('Failed to get ime: io.hbsmith.bardiel.AdbIME');

                                cc = `ime enable ${kk}`;
                                return device.runShellCommandAdbKit(cc);
                            })
                            .then((rr) => {
                                const tt = /enabled/;
                                if (!tt.test(rr)) throw Error('Failed to enable ime');

                                cc = `ime set ${kk}`;
                                return device.runShellCommandAdbKit(cc);
                            })
                            .then((rr) => {
                                const tt = /selected/;
                                if (!tt.test(rr)) throw Error('Failed to set ime');

                                return Utils.sleep(1000);
                            })
                            .then(() => {
                                cc = `am broadcast -a ADB_INPUT_TEXT --es msg '${text}'`;
                                return device.runShellCommandAdbKit(cc);
                            })
                            .then((rr) => {
                                const tt = /Broadcast completed/;
                                if (!tt.test(rr)) throw Error('Failed to send text');
                                return;
                            })
                            .catch((ee) => {
                                this.captureException(ee, `Failed to send text: ${ee.message}`);
                            })
                            .finally(() => {
                                if (!this.defaultIME) cc = 'ime reset';
                                else cc = `ime set ${this.defaultIME}`;
                                return device.runShellCommandAdbKit(cc).catch((ee) => {
                                    this.captureException(ee, 'Failed to set default ime');
                                });
                            });
                        return;
                    }
                    case ControlMessage.TYPE_ADB_PREPARE_SEND_TEXT: {
                        const kk = 'io.hbsmith.bardiel/.AdbIME';
                        device
                            .runShellCommandAdbKit('ime list -a -s')
                            .then((rr) => {
                                const tt = /io.hbsmith.bardiel\/.AdbIME/;
                                if (!tt.test(rr)) throw Error('Failed to get ime: io.hbsmith.bardiel.AdbIME');

                                return device.runShellCommandAdbKit(`ime enable ${kk}`);
                            })
                            .then((rr) => {
                                const tt = /enabled/;
                                if (!tt.test(rr)) throw Error('Failed to enable ime');

                                return device.runShellCommandAdbKit(`ime set ${kk}`);
                            })
                            .then((rr) => {
                                const tt = /selected/;
                                if (!tt.test(rr)) throw Error('Failed to set ime');

                                return Utils.sleep(1000);
                            })
                            .catch((ee) => {
                                this.captureException(ee, 'Failed to prepare sendText');
                            });
                        return;
                    }
                    case ControlMessage.TYPE_ADB_RESET_KEYBOARD: {
                        let cc;
                        if (!this.defaultIME) cc = 'ime reset';
                        else cc = `ime set ${this.defaultIME}`;

                        device.runShellCommandAdbKit(cc).catch((ee) => {
                            this.captureException(ee, 'Failed to reset default ime');
                        });
                        return;
                    }
                }
            } else if (type === ControlMessage.TYPE_HEARTBEAT) {
                this.lastHeartbeat = Date.now();
            }
        } catch (e) {
            this.captureException(e, e.ramiel_message || 'Failed to handle message');
        }
        super.onSocketMessage(event);
    }

    private captureException(e: Error, message: string): void {
        this.logger.error(e);
        Sentry.captureException(e, (scope) => {
            scope.setTag('ramiel_device_type', 'Android');
            scope.setTag('ramiel_device_id', this.udid);
            scope.setTag('ramiel_message', message || e.message);
            scope.setExtra('ramiel_stack', e.stack);
            return scope;
        });
    }

    private getDevice(): Device | null {
        if (!this.udid) {
            return null;
        }
        return new Device(this.udid, 'device');
    }

    private async setUpTest(udid: string, appKey?: string, userAgent?: string): Promise<void> {
        this.apiSessionCreated = true;
        this.udid = udid;
        if (appKey) {
            this.appKey = appKey;
        }
        if (userAgent) {
            this.userAgent = userAgent;
        }

        const device = this.getDevice();
        if (!device) {
            return;
        }

        this.sendMessage({
            id: -1,
            type: 'set-up-test',
            data: '',
        });

        const cmdGetIME = 'settings get secure default_input_method';
        const cmdMenu = `input keyevent ${KeyEvent.KEYCODE_MENU}`;
        const cmdHome = `input keyevent ${KeyEvent.KEYCODE_HOME}`;
        const cmdAppStop =
            'for pp in $(dumpsys window a | grep "/" | cut -d "{" -f2 | cut -d "/" -f1 | cut -d " " -f2); do am force-stop "${pp}"; done';
        const cmdAppStart = `monkey -p '${this.appKey}' -c android.intent.category.LAUNCHER 1`;
        const cmdAppSmsStart = 'am startservice -n sooft.smsf/.model.service.SFFirebaseMessagingService';

        return device
            .runShellCommandAdbKit(cmdGetIME)
            .then((output) => {
                this.defaultIME = output.trim();
                return device.runShellCommandAdbKit(cmdMenu);
            })
            .then((output) => {
                this.logger.info(output ? output : `success to send 1st KEYCODE_MENU: ${cmdMenu}`);
                return device.runShellCommandAdbKit(cmdMenu);
            })
            .then((output) => {
                this.logger.info(output ? output : `success to send 2nd KEYCODE_MENU: ${cmdMenu}`);
                return device.runShellCommandAdbKit(cmdMenu);
            })
            .then((output) => {
                this.logger.info(output ? output : `success to send 3rd KEYCODE_MENU: ${cmdMenu}`);
                return device.runShellCommandAdbKit(cmdHome);
            })
            .then((output) => {
                this.logger.info(output ? output : `success to send KEYCODE_HOME: ${cmdHome}`);
                if (!this.appKey) return;
                return device.runShellCommandAdbKit(cmdAppStop);
            })
            .then((output) => {
                this.logger.info(output ? output : `success to stop all of the apps: ${cmdAppStop}`);

                // TODO: sooft.smsf is a optional app for sms relay
                device
                    .runShellCommandAdbKit(cmdAppSmsStart)
                    .then(() => {
                        this.logger.info('sooft.smsf service is started');
                    })
                    .catch(() => {
                        this.logger.info('sooft.smsf service is skipped');
                    });

                if (this.appKey) {
                    return device.runShellCommandAdbKit(cmdAppStart).then((output) => {
                        this.logger.info(output ? output : `success to start the app: ${cmdAppStart}`);
                    });
                }
                return;
            })
            .then(() => {
                this.logger.info('setup succeeded. ready to test.');
            })
            .catch((e) => {
                this.logger.error(e);
                Sentry.captureException(e, (scope) => {
                    scope.setTag('ramiel_device_type', 'Android');
                    scope.setTag('ramiel_device_id', this.udid);
                    scope.setTag('ramiel_message', 'Failed to run setUpTest');
                    scope.setExtra('ramiel_stack', e.stack);
                    return scope;
                });
            });
    }

    private async setUpGitInfo() {
        this.sendMessage({
            id: -1,
            type: 'git-info',
            data: Utils.getGitInfo(),
        });
    }

    private tearDownTest(): void {
        if (!this.apiSessionCreated || !this.udid) {
            return;
        }

        const device = this.getDevice();
        if (!device) {
            this.logger.error(`failed to get device at tearDownTest: ${this.udid}`);
            this.apiDeleteSession();
            return;
        }

        const cmdSetIME = this.defaultIME ? `ime set ${this.defaultIME}` : 'ime reset';
        const cmdPower = `input keyevent ${KeyEvent.KEYCODE_POWER}`;
        const cmdAppStop =
            'for pp in $(dumpsys window a | grep "/" | cut -d "{" -f2 | cut -d "/" -f1 | cut -d " " -f2); do am force-stop "${pp}"; done';

        new Promise((resolve) => setTimeout(resolve, 3000))
            .then(() => {
                return device.runShellCommandAdbKit(cmdSetIME);
            })
            .then((output) => {
                this.logger.info(output ? output : `success to set default ime: ${cmdSetIME}`);
                return device.runShellCommandAdbKit(cmdAppStop);
            })
            .then((output) => {
                this.logger.info(output ? output : `success to stop all of running apps`);
                return device.runShellCommandAdbKit(cmdPower);
            })
            .then((output) => {
                this.logger.info(output ? output : `success to run a command: ${cmdPower}`);
            })
            .catch((e) => {
                this.logger.error(e);
            })
            .finally(() => {
                setTimeout(() => {
                    this.apiDeleteSession();
                }, 3000);
            });
    }
    //
}
