#!/bin/bash

SOURCE="${BASH_SOURCE[0]}"
DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
source "${DIR}/env.sh"

PATH_TO_OPT='/opt/ramiel/ws-scrcpy'
cd "${PATH_TO_OPT}" || exit 1
source venv/bin/activate
sudo npm start
