#!/usr/bin/env bash
# Installs a release APK on the running emulator, starts it, and checks it
# is still up 30 seconds later with nothing in the crash log: the signed,
# R8-minified build the release ships, which debug builds and unit tests
# never exercise. Run by release.yml's android-launch job inside
# reactivecircus/android-emulator-runner, which runs each script line on
# its own, hence a script file.
#
#   bash mobile/scripts/launch-on-emulator.sh <apk>
set -euo pipefail
apk="$1"
pkg=com.opendungeonmaster.app

adb install -r "$apk"
adb logcat -c
adb shell am start -W -n "$pkg/.MainActivity"
sleep 30

pid=$(adb shell pidof "$pkg" | tr -d '\r' || true)
crashes=$(adb logcat -d -b crash | grep -c "$pkg" || true)
if [ -z "$pid" ] || [ "$crashes" != 0 ]; then
  echo "::error::the release APK is not running 30 seconds after launch (pid '$pid', crash log mentions: $crashes)"
  adb logcat -d -b crash | tail -n 100
  adb logcat -d | grep -E "AndroidRuntime|$pkg|Capacitor" | tail -n 100
  exit 1
fi
echo "the release APK started and stayed up (pid $pid)"
