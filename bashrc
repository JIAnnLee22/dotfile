#
# ~/.bashrc
#

# If not running interactively, don't do anything
[[ $- != *i* ]] && return

alias ra='ranger'
alias ls='ls --color=auto'
PS1='[\W] '

EDITOR=nvim
alias nvi='nvim'
alias vi='vim'

export HISTTIMEFORMAT='%F %T '
export HISTCONTROL=ignoreboth
# export PATH=

export PUB_HOSTED_URL="https://pub.flutter-io.cn"
export FLUTTER_STORAGE_BASE_URL="https://storage.flutter-io.cn"

export ELECTRON_OZONE_PLATFORM_HINT=auto

export OBSFILE_ROOT=$HOME/obs/obsfile/
PATH=$PATH:$HOME/obs/obsgen/linux/
PATH=$HOME/.npm-global/bin:$PATH

# auth when tui need sudo
export SUDO_ASKPASS=/usr/lib/ssh/x11-ssh-askpass
