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
export ANDROID_SDK_ROOT=~/Android/Sdk/
PATH=$PATH:~/Android/Sdk/build-tools/30.0.3/
export GRADLE_LOCAL_JAVA_HOME=/usr/lib/jvm/java-11-openjdk/

export PUB_HOSTED_URL="https://pub.flutter-io.cn"
export FLUTTER_STORAGE_BASE_URL="https://storage.flutter-io.cn"

export ELECTRON_OZONE_PLATFORM_HINT=auto

export OBSFILE_ROOT=$HOME/obs/obsfile/
PATH=$PATH:$HOME/obs/obsgen/linux/
PATH=$HOME/.npm-global/bin:$PATH

# Pi coding agent config directory
export PI_CODING_AGENT_DIR=$HOME/.config/pi
