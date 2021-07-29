#!/bin/bash -x

export PATH_TO_OPT='/opt/ramiel/ws-scrcpy'
export PATH_TO_LOG='/var/log/ramiel'
export PATH_TO_CONFIG='/etc/ramiel/ws-scrcpy'
export PATH_TO_SERVICE="/Users/${SYS_USER}/Library/LaunchAgents"
export PATH_TO_ROOT_DAEMONS='/Library/LaunchDaemons'
export SERVICE_NAME='ramiel.ws-scrcpy.hbsmith.io'
export NODE_VERSION='14.17.3'

__UNAME_MACHINE="$(/usr/bin/uname -m)"
export UNAME_MACHINE="${__UNAME_MACHINE}"
if [[ "$UNAME_MACHINE" == "arm64" ]]; then
  HOMEBREW_PREFIX="/opt/homebrew"
  export PATH="${HOMEBREW_PREFIX}/bin:$PATH"
else
  HOMEBREW_PREFIX="/usr/local"
  export PATH="${HOMEBREW_PREFIX}/bin:$PATH"
fi
