import '../../../style/filelisting.css';
import { ParamsFileListing } from '../../../types/ParamsFileListing';
import { ManagerClient } from '../../client/ManagerClient';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { ACTION } from '../../../common/Action';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { ParsedUrlQuery } from 'querystring';
import Util from '../../Util';
import Protocol from '@devicefarmer/adbkit/lib/adb/protocol';
import { Entry } from '../Entry';
import { html } from '../../ui/HtmlTag';
import * as path from 'path';
import { ChannelCode } from '../../../common/ChannelCode';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import FilePushHandler, { DragAndPushListener, PushUpdateParams } from '../filePush/FilePushHandler';
import { AdbkitFilePushStream } from '../filePush/AdbkitFilePushStream';

const TAG = '[FileListing]';

const parentDirQuickLink = 'parentDirQuickLink';
const emulated0DirQuickLink = 'emulated0DirQuickLink';
const emulated0AppsDirQuickLink = 'emulated0AppsDirQuickLink';
const sdcard0DirQuickLink = 'sdcard0DirQuickLink';
const sdcard0AppsDirQuickLink = 'sdcard0AppsDirQuickLink';

const emulated0Path = '/storage/emulated/0';
const emulated0AppsPath = '/storage/emulated/0/apps';
const sdcard0Path = '/storage/sdcard0';
const sdcard0AppsPath = '/storage/sdcard0/apps';

function formatSize(size: number): string {
    if (size < 1024) {
        return `${size} B`;
    }
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = size / 1024;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index++;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

type Download = {
    receivedBytes: number;
    entry?: Entry;
    progressEl?: HTMLElement;
    anchor?: HTMLElement;
    chunks: Uint8Array[];
    path: string;
    pathToLoadAfter: string;
};
type Upload = { row: HTMLElement; progressEl: HTMLElement; anchor: HTMLElement; timeout: number | null };

enum Foreground {
    Drop = 'drop-target',
    Connect = 'connect',
}

const Message: Record<Foreground, string> = {
    [Foreground.Drop]: 'Drop files here',
    [Foreground.Connect]: 'Connection lost',
};

export class FileListingClient extends ManagerClient<ParamsFileListing, never> implements DragAndPushListener {
    public static readonly ACTION = ACTION.FILE_LISTING;
    public static readonly PARENT_DIR = '..';
    public static readonly PROPERTY_NAME = 'data-name';
    public static readonly PROPERTY_ENTRY_ID = 'data-entry-id';
    public static REMOVE_ROW_TIMEOUT = 2000;

    public static start(params: ParsedUrlQuery): FileListingClient {
        return new FileListingClient(params);
    }

    public static createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | DocumentFragment | undefined {
        if (descriptor.state !== 'device') {
            return;
        }
        const entry = document.createElement('div');
        entry.classList.add('file-listing', blockClass);
        entry.appendChild(
            BaseDeviceTracker.buildLink(
                {
                    action: ACTION.FILE_LISTING,
                    udid: descriptor.udid,
                    path: `${emulated0AppsPath}`,
                },
                'list files',
                params,
            ),
        );
        return entry;
    }

    private readonly serial: string;
    private readonly name: string;
    private readonly tableBodyId: string;
    private readonly wrapperId: string;
    private readonly filePushHandler?: FilePushHandler;
    private readonly parent: HTMLElement;
    private enterCount = 0;
    private entries: Entry[] = [];
    private path: string;
    private sortColumn: 'name' | 'size' | 'mtime' = 'name';
    private sortDirection: 'asc' | 'desc' = 'asc';
    private requireClean = false;
    private requestedPath = '';
    private downloads: Map<Multiplexer, Download> = new Map();
    private uploads: Map<string, Upload> = new Map();
    private tableBody: HTMLElement;
    private channels: Set<Multiplexer> = new Set();
    constructor(params: ParsedUrlQuery) {
        super(params);
        this.parent = document.body;
        this.serial = this.params.udid;
        this.path = this.params.path;
        this.openNewConnection();
        this.setTitle(`Listing ${this.serial}`);
        this.setBodyClass('file-listing');
        this.name = `${TAG} [${this.serial}]`;
        this.tableBodyId = `${Util.escapeUdid(this.serial)}_list`;
        this.wrapperId = `wrapper_${this.tableBodyId}`;
        const fragment = html`<div id="${this.wrapperId}" class="listing">
            <h1 id="header"><span class="listing-title-label">Contents</span> <span id="header-path" class="listing-path">${this.path}</span></h1>
            <div id="${parentDirQuickLink}" class="quick-link-box">
                <a class="icon up" href="#!" ${FileListingClient.PROPERTY_NAME}="..">parent</a>
            </div>
            <div id="${emulated0DirQuickLink}" class="quick-link-box hidden">
                <a class="icon dir" href="#!" ${FileListingClient.PROPERTY_NAME}="${emulated0Path}">/</a>
            </div>
            <div id="${emulated0AppsDirQuickLink}" class="quick-link-box hidden">
                <a class="icon dir" href="#!" ${FileListingClient.PROPERTY_NAME}="${emulated0AppsPath}">/apps</a>
            </div>
            <div id="${sdcard0DirQuickLink}" class="quick-link-box hidden">
                <a class="icon dir" href="#!" ${FileListingClient.PROPERTY_NAME}="${sdcard0Path}">/</a>
            </div>
            <div id="${sdcard0AppsDirQuickLink}" class="quick-link-box hidden">
                <a class="icon dir" href="#!" ${FileListingClient.PROPERTY_NAME}="${sdcard0AppsPath}">/apps</a>
            </div>
            <table>
                <thead>
                    <tr>
                        <th class="sortable" data-sort="name">Name</th>
                        <th class="sortable entry-size-header" data-sort="size">Size</th>
                        <th class="sortable" data-sort="mtime">Modified</th>
                        <th class="entry-actions-header"></th>
                    </tr>
                </thead>
                <tbody id="${this.tableBodyId}"></tbody>
            </table>
        </div>`.content;
        this.tableBody = fragment.getElementById(this.tableBodyId) as HTMLElement;
        const thead = fragment.querySelector('thead');
        if (thead) {
            thead.addEventListener('click', (e) => {
                if (!e.target) {
                    return;
                }
                const th = (e.target as HTMLElement).closest('th[data-sort]');
                if (!th) {
                    return;
                }
                const column = th.getAttribute('data-sort') as 'name' | 'size' | 'mtime';
                if (this.sortColumn === column) {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    this.sortColumn = column;
                    this.sortDirection = 'asc';
                }
                this.updateSortHeader();
                this.sortRows();
            });
        }
        const wrapper = fragment.getElementById(this.wrapperId);
        if (wrapper) {
            wrapper.addEventListener('click', (e) => {
                if (!e.target || !(e.target instanceof HTMLElement)) {
                    return;
                }
                let el = e.target.closest(`[${FileListingClient.PROPERTY_NAME}]`) as HTMLElement | null;
                if (!el) {
                    // Clicked elsewhere in a row (e.g. size or date cell): use the row's name link
                    const row = e.target.closest('tr');
                    if (row) {
                        el = row.querySelector(`[${FileListingClient.PROPERTY_NAME}]`) as HTMLElement | null;
                    }
                }
                if (!el || el.closest('.disabled')) {
                    return;
                }
                const name = el.getAttribute(FileListingClient.PROPERTY_NAME);
                if (!name) {
                    return;
                }
                e.preventDefault();
                e.cancelBubble = true;
                const newPath = path.resolve(this.path, name);
                if (newPath !== this.path) {
                    const entryIdString = el.getAttribute(FileListingClient.PROPERTY_ENTRY_ID);
                    let entry: Entry | undefined;
                    let anchor: HTMLElement | undefined;
                    if (entryIdString) {
                        const entryId = parseInt(entryIdString, 10);
                        if (!isNaN(entryId) && this.entries[entryId]) {
                            entry = this.entries[entryId];
                            anchor = el;
                        }
                    }
                    this.loadContent(newPath, entry, anchor);
                }
            });

            if (this.ws instanceof Multiplexer) {
                this.filePushHandler = new FilePushHandler(this.parent, new AdbkitFilePushStream(this.ws, this));
                this.filePushHandler.addEventListener(this);
            }
        }
        this.parent.appendChild(fragment);
    }

    public onDragEnter(): boolean {
        if (this.enterCount === 0) {
            this.addForeground(Foreground.Drop);
        }
        this.enterCount++;
        return true;
    }

    public onDragLeave(): boolean {
        this.enterCount--;
        if (this.enterCount < 0) {
            this.enterCount = 0;
        }
        if (this.enterCount === 0) {
            this.removeForeground(Foreground.Drop);
        }
        return true;
    }

    public onDrop(): boolean {
        this.enterCount = 0;
        this.removeForeground(Foreground.Drop);
        return true;
    }

    private findOrCreateEntryRow(fileName: string): HTMLElement {
        const row = document.getElementById(`entry-${fileName}`);
        if (row) {
            return row;
        }
        return this.addRow(true, fileName, 'file');
    }

    public onFilePushUpdate(data: PushUpdateParams): void {
        const { fileName, progress, error, message, finished } = data;
        let upload = this.uploads.get(fileName);
        if (!upload || document.getElementById(upload.anchor.id) !== upload.anchor) {
            const row = this.findOrCreateEntryRow(fileName);
            const anchor = row.getElementsByTagName('a')[0];
            if (!anchor.id) {
                anchor.id = `upload_${fileName}`;
            }
            const progressEl = this.appendProgressElement(anchor);
            upload = { row, progressEl, anchor, timeout: null };
            this.uploads.set(fileName, upload);
        }
        const { row, progressEl, anchor } = upload;
        if (error) {
            this.uploads.delete(fileName);
            progressEl.style.width = `100%`;
            progressEl.classList.add('error');
            if (!anchor.classList.contains('error')) {
                anchor.classList.add('error');
                anchor.innerText = `${fileName} — ${message}`;
            }
            if (!upload.timeout) {
                upload.timeout = window.setTimeout(() => {
                    const parent = row.parentElement;
                    if (parent) {
                        parent.removeChild(row);
                        this.reload();
                    }
                }, FileListingClient.REMOVE_ROW_TIMEOUT);
            }
        } else {
            anchor.innerText = `${fileName} — ${message}`;
            progressEl.style.width = `${progress}%`;
        }
        if (finished && !error) {
            this.uploads.delete(fileName);
            this.reload();
        }
    }
    public onError(error: string | Error): void {
        console.error(this.name, 'FIXME: implement', error);
    }

    private addForeground(type: Foreground): void {
        const icon = type === Foreground.Drop ? '⬆' : '⚠';
        const fragment = html`<div class="foreground ${type}">
            <div class="foreground-message ${type}-message">
                <span class="foreground-icon">${icon}</span>
                <span>${Message[type]}</span>
            </div>
        </div>`.content;
        this.parent.appendChild(fragment);
    }

    private removeForeground(type: Foreground): void {
        const els = this.parent.getElementsByClassName(type);
        Array.from(els).forEach((el) => {
            this.parent.removeChild(el);
        });
    }

    public parseParameters(params: ParsedUrlQuery): ParamsFileListing {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.FILE_LISTING) {
            throw Error('Incorrect action');
        }
        const path = params.path ? (Array.isArray(params.path) ? params.path[0] : params.path) : emulated0AppsPath;
        return { ...typedParams, action, udid: Util.parseStringEnv(params.udid), path };
    }

    protected buildDirectWebSocketUrl(): URL {
        const localUrl = super.buildDirectWebSocketUrl();
        localUrl.searchParams.set('action', ACTION.MULTIPLEX);
        return localUrl;
    }

    protected onSocketClose(e: CloseEvent): void {
        if (this.filePushHandler) {
            this.filePushHandler.release();
        }
        console.error(this.name, 'socket closed', e.reason);
        this.addForeground(Foreground.Connect);
    }

    protected onSocketMessage(_e: MessageEvent): void {
        // We create separate channel for each request
        // Don't expect any messages on this level
    }

    protected onSocketOpen(): void {
        this.resolveStartPath(this.path).then((path) => {
            this.loadContent(path);
        });
    }

    protected statPath(path: string): Promise<number | undefined> {
        return new Promise((resolve) => {
            if (!this.ws || this.ws.readyState !== this.ws.OPEN || !(this.ws instanceof Multiplexer)) {
                resolve(undefined);
                return;
            }
            const cmd = Protocol.STAT;
            const len = Buffer.byteLength(path, 'utf-8');
            const payload = Buffer.alloc(cmd.length + 4 + len);
            let pos = payload.write(cmd, 0);
            pos = payload.writeUInt32LE(len, pos);
            payload.write(path, pos);
            const channel = this.ws.createChannel(payload);
            const cleanup = (): void => {
                channel.removeEventListener('message', onMessage);
                channel.removeEventListener('close', onClose);
            };
            const onMessage = (e: MessageEvent): void => {
                const data = Buffer.from(e.data);
                const reply = data.slice(0, 4).toString('ascii');
                if (reply === Protocol.STAT) {
                    const mode = data.readUInt32LE(4);
                    cleanup();
                    resolve(mode);
                } else if (reply === Protocol.FAIL) {
                    cleanup();
                    resolve(undefined);
                }
            };
            const onClose = (): void => {
                cleanup();
                resolve(undefined);
            };
            channel.addEventListener('message', onMessage);
            channel.addEventListener('close', onClose);
        });
    }

    // Some devices expose the internal storage at /storage/emulated/0, others at
    // /storage/sdcard0. Keep the requested path when it exists; otherwise pick the
    // storage root that actually exists on this device (preferring its apps dir).
    protected async resolveStartPath(requested: string): Promise<string> {
        if (await this.statPath(requested)) {
            return requested;
        }
        // Prefer the storage family of the requested path so the outcome is
        // deterministic across reloads
        const roots = requested.startsWith(sdcard0Path)
            ? [sdcard0Path, emulated0Path]
            : [emulated0Path, sdcard0Path];
        for (const root of roots) {
            if (await this.statPath(root)) {
                const apps = path.join(root, 'apps');
                if (await this.statPath(apps)) {
                    return apps;
                }
                return root;
            }
        }
        return requested;
    }

    protected loadContent(path: string, entry?: Entry, anchor?: HTMLElement, pathToLoadAfter = ''): void {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN || !(this.ws instanceof Multiplexer)) {
            return;
        }
        if (!entry && (this.channels.size || this.uploads.size)) {
            return;
        }
        this.requireClean = true;
        this.requestedPath = path;
        let cmd: string;
        if (!entry) {
            cmd = Protocol.STAT;
        } else if (entry.isFile()) {
            cmd = Protocol.RECV;
        } else {
            cmd = Protocol.LIST;
        }
        const len = Buffer.byteLength(path, 'utf-8');
        const payload = Buffer.alloc(cmd.length + 4 + len);
        let pos = payload.write(cmd, 0);
        pos = payload.writeUInt32LE(len, pos);
        payload.write(path, pos);
        const channel = this.ws.createChannel(payload);
        this.channels.add(channel);
        const download: Download = {
            receivedBytes: 0,
            path,
            entry,
            anchor,
            chunks: [],
            pathToLoadAfter,
        };
        this.downloads.set(channel, download);
        const onMessage = (e: MessageEvent): void => {
            this.handleReply(channel, e);
        };
        const onClose = (): void => {
            this.channels.delete(channel);
            this.downloads.delete(channel);
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);
    }

    protected clean(): void {
        this.tableBody.innerHTML = '';
        const headerPath = document.getElementById('header-path');
        if (headerPath) {
            headerPath.innerText = this.path;
        }
        this.toggleQuickLinks(this.path);

        // FIXME: should do over way around: load content on hash change
        const hash = location.hash.replace(/#!/, '');
        const params = new URLSearchParams(hash);
        if (params.get('action') === ACTION.FILE_LISTING) {
            params.set('path', this.path);
            location.hash = `#!${params.toString()}`;
        }
    }

    protected toggleQuickLinks(path: string): void {
        const parentEl = document.getElementById(parentDirQuickLink);
        if (parentEl) {
            const isBase = (path === emulated0Path || path === sdcard0Path);
            parentEl.classList.toggle('disabled', isBase);
        }

        let sdcard0Hidden = false;
        let emulated0Hidden = false;
        if (path.startsWith(emulated0Path)) {
            sdcard0Hidden = true;
        } else if (path.startsWith(sdcard0Path)) {
            emulated0Hidden = true;
        }

        const emulated0El = document.getElementById(emulated0DirQuickLink);
        if (emulated0El) {
            emulated0El.classList.toggle('hidden', emulated0Hidden || path === emulated0Path);
        }
        const emulatedApps0El = document.getElementById(emulated0AppsDirQuickLink);
        if (emulatedApps0El) {
            emulatedApps0El.classList.toggle('hidden', emulated0Hidden || path === emulated0AppsPath);
        }
        const sdcard0El = document.getElementById(sdcard0DirQuickLink);
        if (sdcard0El) {
            sdcard0El.classList.toggle('hidden', sdcard0Hidden || path === sdcard0Path);
        }
        const sdcard0AppsEl = document.getElementById(sdcard0AppsDirQuickLink);
        if (sdcard0AppsEl) {
            sdcard0AppsEl.classList.toggle('hidden', sdcard0Hidden || path === sdcard0AppsPath);
        }
    }

    protected handleReply(channel: Multiplexer, e: MessageEvent): void {
        const data = Buffer.from(e.data);
        const reply = data.slice(0, 4).toString('ascii');
        switch (reply) {
            case Protocol.DENT:
                const stat = data.slice(4);
                const mode = stat.readUInt32LE(0);
                const size = stat.readUInt32LE(4);
                const mtime = stat.readUInt32LE(8);
                const namelen = stat.readUInt32LE(12);
                const name = Util.utf8ByteArrayToString(stat.slice(16, 16 + namelen));
                this.addEntry(new Entry(name, mode, size, mtime));
                return;
            case Protocol.DONE:
                this.finishDownload(channel);
                return;
            case Protocol.STAT: {
                const download = this.downloads.get(channel);
                if (!download) {
                    return;
                }
                const stat = data.slice(4);
                const mode = stat.readUInt32LE(0);
                const size = stat.readUInt32LE(4);
                const mtime = stat.readUInt32LE(8);
                const nameString = path.basename(download.path);
                if (mode === 0) {
                    this.channels.delete(channel);
                    this.resolveStartPath(download.path).then((fallback) => {
                        if (fallback !== download.path) {
                            this.loadContent(fallback);
                            return;
                        }
                        this.showErrorRow(`Cannot access "${download.path}"`);
                    });
                    return;
                }
                const entry = new Entry(nameString, mode, size, mtime);
                let anchor: HTMLElement | undefined;
                let nextPath = '';
                if (!entry.isDirectory()) {
                    nextPath = this.requestedPath = path.dirname(download.path);
                    const row = this.addEntry(entry);
                    anchor = row ? row.getElementsByTagName('a')[0] : undefined;
                }
                this.loadContent(download.path, entry, anchor, nextPath);
                break;
            }
            case Protocol.FAIL:
                const length = data.readUInt32LE(4);
                const message = Util.utf8ByteArrayToString(data.slice(8, 8 + length));
                console.error(TAG, `FAIL: ${message}`);
                return;
            case Protocol.DATA:
                const download = this.downloads.get(channel);
                if (!download) {
                    return;
                }
                download.chunks.push(data.slice(4));
                download.receivedBytes += data.length - 4;
                if (download.anchor) {
                    let progressElement = download.progressEl;
                    if (!progressElement) {
                        progressElement = this.appendProgressElement(download.anchor);
                        download.progressEl = progressElement;
                    }
                    if (download.entry) {
                        const { size } = download.entry;
                        const percent = (download.receivedBytes * 100) / size;
                        progressElement.style.width = `${percent}%`;
                    }
                }
                return;
            default:
                console.error(`Unexpected "${reply}"`);
        }
    }

    protected showErrorRow(message: string): void {
        this.tableBody.innerHTML = '';
        // Unhide all quick links so the user can navigate somewhere else
        for (const id of [
            parentDirQuickLink,
            emulated0DirQuickLink,
            emulated0AppsDirQuickLink,
            sdcard0DirQuickLink,
            sdcard0AppsDirQuickLink,
        ]) {
            const el = document.getElementById(id);
            if (el) {
                el.classList.remove('hidden');
            }
        }
        const row = document.createElement('tr');
        row.classList.add('entry-row');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.classList.add('entry-error');
        td.innerText = message;
        row.appendChild(td);
        this.tableBody.appendChild(row);
    }

    protected appendProgressElement(anchor: HTMLElement): HTMLElement {
        const progressElement = document.createElement('span');
        progressElement.className = 'background-progress';
        const parent = anchor.parentElement;
        if (parent) {
            parent.appendChild(progressElement);
        }
        return progressElement;
    }

    protected addEntry(entry: Entry): HTMLElement | undefined {
        if (this.requireClean) {
            this.path = this.requestedPath;
            this.requestedPath = '';
            this.clean();
            this.requireClean = false;
            this.entries.length = 0;
        }
        this.entries.push(entry);
        const entryId = (this.entries.length - 1).toString();
        if (entry.name === '.') {
            return;
        }
        if (entry.name === FileListingClient.PARENT_DIR) {
            const el = document.getElementById(parentDirQuickLink);
            if (el) {
                const a = el.children[0];
                if (a) {
                    a.setAttribute(FileListingClient.PROPERTY_ENTRY_ID, entryId);
                }
            }
            return;
        }
        const type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : 'else';
        const date = entry.mtime.toLocaleString();
        const row = this.addRow(false, entry.name, type, formatSize(entry.size), date, entryId);
        row.dataset.size = String(entry.size);
        row.dataset.mtime = String(entry.mtime.getTime());
        return row;
    }

    protected addRow(push: boolean, name: string, typeClass: string, size = '', date = '', entryId = ''): HTMLElement {
        const row = document.createElement('tr');
        row.id = `entry-${name}`;
        row.classList.add('entry-row');
        const nameTd = document.createElement('td');
        nameTd.classList.add('entry-name');
        const link = document.createElement('a');
        link.classList.add('icon', typeClass);
        link.setAttribute(FileListingClient.PROPERTY_NAME, name);
        if (entryId) {
            link.setAttribute(FileListingClient.PROPERTY_ENTRY_ID, entryId);
        }
        link.innerText = name;
        nameTd.appendChild(link);
        row.appendChild(nameTd);
        if (push) {
            nameTd.colSpan = 4;
            link.classList.add('push');
        } else {
            const href = new URL(location.href);
            const hash = new URLSearchParams(href.hash.replace(/^#!/, ''));
            hash.set('path', path.join(this.path, name));
            href.hash = `#!${hash.toString()}`;
            link.href = href.toString();
            const sizeTd = document.createElement('td');
            sizeTd.classList.add('entry-size');
            sizeTd.innerText = size;
            row.appendChild(sizeTd);
            const mtimeTd = document.createElement('td');
            mtimeTd.classList.add('entry-time');
            mtimeTd.innerText = date;
            row.appendChild(mtimeTd);
            const actionTd = document.createElement('td');
            actionTd.classList.add('entry-actions');
            if (typeClass === 'file') {
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'delete-file';
                deleteBtn.title = 'Delete';
                deleteBtn.innerHTML =
                    '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
                deleteBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.confirmDelete(name, row);
                });
                actionTd.appendChild(deleteBtn);
            }
            row.appendChild(actionTd);
        }
        if (push || !this.tableBody.children.length) {
            this.tableBody.insertBefore(row, this.tableBody.firstChild);
        } else {
            this.tableBody.appendChild(row);
        }
        return row;
    }

    private updateSortHeader(): void {
        const ths = document.querySelectorAll(`#${this.wrapperId} th[data-sort]`);
        ths.forEach((th) => {
            const sorted = th.getAttribute('data-sort') === this.sortColumn;
            th.classList.toggle('sorted-asc', sorted && this.sortDirection === 'asc');
            th.classList.toggle('sorted-desc', sorted && this.sortDirection === 'desc');
        });
    }

    private confirmDelete(name: string, row: HTMLElement): void {
        if (!window.confirm(`Are you sure you want to delete "${name}"?`)) {
            return;
        }
        if (!this.ws || this.ws.readyState !== this.ws.OPEN || !(this.ws instanceof Multiplexer)) {
            return;
        }
        const fullPath = path.join(this.path, name);
        const cmd = 'RMFL';
        const len = Buffer.byteLength(fullPath, 'utf-8');
        const payload = Buffer.alloc(cmd.length + 4 + len);
        let pos = payload.write(cmd, 0);
        pos = payload.writeUInt32LE(len, pos);
        payload.write(fullPath, pos);
        const channel = this.ws.createChannel(payload);
        const onMessage = (e: MessageEvent): void => {
            const reply = Buffer.from(e.data).slice(0, 4).toString('ascii');
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
            if (reply === Protocol.OKAY) {
                row.remove();
                this.reload();
            } else {
                console.error(TAG, `Failed to delete "${fullPath}": ${reply}`);
            }
        };
        const onClose = (): void => {
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);
    }

    private sortRows(): void {
        const rows = Array.from(this.tableBody.children) as HTMLElement[];
        const direction = this.sortDirection === 'asc' ? 1 : -1;
        const { sortColumn } = this;
        rows.sort((a, b) => {
            const aLink = a.querySelector('a');
            const bLink = b.querySelector('a');
            if (!aLink || !bLink) {
                return 0;
            }
            const aPush = aLink.classList.contains('push');
            const bPush = bLink.classList.contains('push');
            if (aPush !== bPush) {
                return aPush ? -1 : 1; // uploads in progress stay on top
            }
            const aDir = aLink.classList.contains('dir') || aLink.classList.contains('link');
            const bDir = bLink.classList.contains('dir') || bLink.classList.contains('link');
            if (aDir !== bDir) {
                return aDir ? -1 : 1; // directories always first
            }
            const aName = aLink.textContent || '';
            const bName = bLink.textContent || '';
            let cmp: number;
            if (sortColumn === 'size') {
                const aSize = Number(a.dataset.size);
                const bSize = Number(b.dataset.size);
                cmp = (isNaN(aSize) ? -1 : aSize) - (isNaN(bSize) ? -1 : bSize);
            } else if (sortColumn === 'mtime') {
                const aTime = Number(a.dataset.mtime);
                const bTime = Number(b.dataset.mtime);
                cmp = (isNaN(aTime) ? -1 : aTime) - (isNaN(bTime) ? -1 : bTime);
            } else {
                cmp = aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
            }
            if (cmp === 0) {
                // Tie-break by name for stable order
                cmp = aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
            }
            return cmp * direction;
        });
        rows.forEach((row) => {
            this.tableBody.appendChild(row);
        });
    }

    protected finishDownload(channel: Multiplexer): void {
        const download = this.downloads.get(channel);
        if (!download) {
            return;
        }
        this.downloads.delete(channel);
        const el = download.progressEl;
        if (el) {
            this.cleanProgress(el);
        }
        if (!download.entry || !download.entry.isFile()) {
            // A directory listing has completed: order the rows
            this.sortRows();
        }
        let name: string;
        if (download.entry && download.entry.isFile()) {
            name = download.entry.name;
        } else {
            // we always should have `download.entry` and never be here
            name = path.basename(this.path);
        }
        if (download.pathToLoadAfter) {
            this.channels.delete(channel);
            this.loadContent(download.pathToLoadAfter);
        }
        const file = new File(download.chunks, name, { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = `${name}`;
        a.click();
    }

    protected cleanProgress(el: HTMLElement): void {
        el.style.width = '100%';
        el.classList.add('finished');
        // Let the fade-out animation play before removing the element
        window.setTimeout(() => {
            const parent = el.parentElement;
            if (parent) {
                parent.removeChild(el);
            }
        }, 500);
    }

    public getPath(): string {
        return this.path;
    }

    public reload(): void {
        this.loadContent(this.path);
    }

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelInitData(): Buffer {
        const serial = Util.stringToUtf8ByteArray(this.serial);
        const buffer = Buffer.alloc(4 + 4 + serial.byteLength);
        buffer.write(ChannelCode.FSLS, 'ascii');
        buffer.writeUInt32LE(serial.length, 4);
        buffer.set(serial, 8);
        return buffer;
    }
}
