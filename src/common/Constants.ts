export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_PORT = 8886;
export const SERVER_VERSION = '4.0-ws2';

export const SERVER_TYPE = 'web';

export const LOG_LEVEL = 'DEBUG';

let SCRCPY_LISTENS_ON_ALL_INTERFACES;
/// #if SCRCPY_LISTENS_ON_ALL_INTERFACES
SCRCPY_LISTENS_ON_ALL_INTERFACES = true;
/// #else
SCRCPY_LISTENS_ON_ALL_INTERFACES = false;
/// #endif

const ARGUMENTS = [
    SERVER_VERSION,
    SERVER_TYPE,
    LOG_LEVEL,
    SERVER_PORT,
    SCRCPY_LISTENS_ON_ALL_INTERFACES,
    'ws_audio_warmup=true',
    'audio_bit_rate=64000',
    'ws_audio_channels=1',
    'ws_audio_frame_mode=combined'
    //'ws_reverse=true ws_reverse_url=ws://127.0.0.1:8675/device ws_reverse_token="VQG46tz8oK10yznpv0IJ2IwqK6ZSzr3LWOnxERtbz3c"'
];

export const SERVER_PROCESS_NAME = 'app_process';

export const ARGS_STRING = `/ ${SERVER_PACKAGE} ${ARGUMENTS.join(' ')} > /data/local/tmp/ws_server.log`;
