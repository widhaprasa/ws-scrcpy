#!/bin/bash

SOURCE="${BASH_SOURCE[0]}"
DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
source "${DIR}/env.sh"

echo 'stopping ws-scrcpy as a daemon'
if sudo launchctl list | grep -q "${SERVICE_NAME}"; then
  sudo launchctl remove "${SERVICE_NAME}"
fi
