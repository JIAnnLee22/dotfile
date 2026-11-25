# Home Manager 在交互式 Bash 中加载此文件；$1 是固定的 Oh My Bash 源码路径。
export OSH="$1"
OSH_THEME="font"
DISABLE_AUTO_UPDATE=true
OMB_TERM_USE_TPUT=no

plugins=(git bashmarks)
aliases=(general)
# 命令补全由 Home Manager 的 bash-completion 提供。
completions=()

source "$OSH/oh-my-bash.sh"
