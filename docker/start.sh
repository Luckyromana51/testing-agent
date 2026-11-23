#!/bin/sh
# Starts the app. With the Android emulator profile (ANDROID_DEVICE set in .env and no APPIUM_URL
# of its own), it first connects adb to the emulator and starts Appium inside this container, on
# 127.0.0.1 only, so nothing outside the container can drive the phone.
set -e
if [ -n "$ANDROID_DEVICE" ] && [ -z "$APPIUM_URL" ] && command -v appium >/dev/null 2>&1; then
  case "$ANDROID_DEVICE" in
    *:*) adb connect "$ANDROID_DEVICE" >/dev/null 2>&1 || echo "adb could not reach $ANDROID_DEVICE yet: the emulator may still be starting; it is tried again before each test" ;;
  esac
  appium --address 127.0.0.1 --port 4723 --allow-insecure='*:adb_shell' --log-level warn --log /tmp/appium.log &
  export APPIUM_URL=http://127.0.0.1:4723
  export APPIUM_LOCAL=1
fi
# ClamAV's signatures normally come with the image. If that download failed (ClamAV's servers
# sometimes refuse image builds), fetch them now in the background; the malware check uses
# YARA alone until they arrive.
if command -v freshclam >/dev/null 2>&1 && ! ls /var/lib/clamav/*.c[lv]d >/dev/null 2>&1; then
  (freshclam --stdout --log=/tmp/freshclam-update.log >/tmp/freshclam.log 2>&1 || true) &
fi
exec node dist/server.js
