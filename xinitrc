#!/bin/bash

xrandr --output HDMI-0 --rotate left --auto --left-of DP-0 --pos 0x0
xrandr --output DP-0 --pos 1080x365

source $HOME/.xprofile

export XDG_CURRENT_DESKTOP=dwm
export XDG_SESSION_TYPE=x11
export XDG_SESSION_DESKTOP=dwm
export DESKTOP_SESSION=dwm
export XDG_CONFIG_DIRS=/etc/xdg

export GTK_IM_MODULE=fcitx
export QT_IM_MODULE=fcitx
export XMODIFIERS=@im=fcitx
exec dbus-launch --exit-with-session ~/.config/dwm/loopdwm

#exec dwm
#exec ~/.config/dwm/loopdwm
