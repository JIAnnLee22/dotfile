#!/bin/bash

xrdb -merge ~/.Xresources
export XDG_CURRENT_DESKTOP=dwm
export XDG_SESSION_TYPE=x11
export XDG_SESSION_DESKTOP=dwm
export DESKTOP_SESSION=dwm
export XDG_CONFIG_DIRS=/etc/xdg
exec dbus-launch --exit-with-session dwm

#exec dwm
#exec ~/.config/dwm/loopdwm
