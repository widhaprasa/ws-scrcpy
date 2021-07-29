#!/bin/bash

SOURCE="${BASH_SOURCE[0]}"
DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
source "${DIR}/env.sh"

cd "${PATH_TO_OPT}/_provisioning" || exit 1
./50.cleanup.sh

sudo launchctl remove "${SERVICE_NAME}"
sudo rm -f "${PATH_TO_ROOT_DAEMONS}/${SERVICE_NAME}.plist"
sudo rm -rf "${PATH_TO_OPT}"
