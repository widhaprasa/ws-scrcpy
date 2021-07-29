#!/bin/bash -x

SOURCE="${BASH_SOURCE[0]}"
DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd)"
source "${DIR}/env.sh"

#
# sync tz
#
if which sntp; then
  sudo sntp -sS time.apple.com
fi

#
sudo mkdir -p "${PATH_TO_OPT}"
sudo mkdir -p "${PATH_TO_LOG}"
sudo mkdir -p "${PATH_TO_CONFIG}"

if sudo launchctl list | grep -q "${SERVICE_NAME}"; then
  sudo launchctl remove "${SERVICE_NAME}"
  sleep 10
fi

# copy
sudo cp -R "${DIR}/.." "${PATH_TO_OPT}"

# config
cd "${PATH_TO_OPT}" || exit 1
sudo cp -f "_provisioning/configuration/${PATH_TO_CONFIG}/settings_local.json" "${PATH_TO_CONFIG}"

# venv
cd "/opt/ramiel/ws-scrcpy" || exit 1

sudo virtualenv --python=python3.9 venv
source venv/bin/activate
sudo pip install --upgrade pip
sudo pip install nodeenv

if ! sudo nodeenv --node="${NODE_VERSION}" --python-virtualenv; then
  # In M1 OSX, 404 error on prebuilt except the latest lts ver.
  # problem: installation with --source option takes too much time
  sudo nodeenv --node="${NODE_VERSION}" --python-virtualenv --source
fi

source venv/bin/activate
sudo npm install --unsafe-perm
deactivate
deactivate_node

# launchd
cd "${PATH_TO_OPT}/_provisioning/configuration/etc/launchd" || exit 2
sudo chmod 644 ./*.plist
sudo cp "${SERVICE_NAME}.plist" "${PATH_TO_ROOT_DAEMONS}"
sudo launchctl load -w "${PATH_TO_ROOT_DAEMONS}/${SERVICE_NAME}.plist"
