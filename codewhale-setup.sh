#!/usr/bin/env bash
# codewhale-setup.sh
# ─────────────────────────────────────────────────────────────────────────────
# 把本仓库的 .codewhale 配置链接到 ~/.codewhale，并恢复密钥。
# 幂等：本机可重复执行；新机器 clone 后执行一次即可完全复用同一套配置。
#
# 用法：
#   ./codewhale-setup.sh
#
# 流程：
#   1. 若 ~/.codewhale 已存在且不是指向本仓库的软链接，先备份为
#      ~/.codewhale.bak.<时间戳> 再替换
#   2. 创建软链接  ~/.codewhale → <本仓库>/.codewhale
#   3. 若 secrets/secrets.json 不存在，从 secrets/secrets.env 导入密钥
#      （没有 secrets.env 则提示复制模板）
#   4. 若存在 ~/.codex/auth.json，恢复 openai-codex 外部凭据授权
#   5. codewhale auth status 校验
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CW_SRC="$REPO_DIR/.codewhale"
CW_DEST="$HOME/.codewhale"

# ── 1. 处理已存在的 ~/.codewhale ──────────────────────────────────────────────
if [ -e "$CW_DEST" ] || [ -L "$CW_DEST" ]; then
  if [ "$(readlink -f "$CW_DEST" 2>/dev/null)" = "$(readlink -f "$CW_SRC")" ]; then
    echo "[ok] ~/.codewhale 已是本仓库的软链接，跳过替换"
  else
    BAK="$CW_DEST.bak.$(date +%Y%m%d-%H%M%S)"
    echo "[backup] 备份现有 ~/.codewhale → $BAK"
    mv "$CW_DEST" "$BAK"
  fi
fi

if [ ! -e "$CW_DEST" ]; then
  ln -s "$CW_SRC" "$CW_DEST"
  echo "[link] ~/.codewhale → $CW_SRC"
fi

# ── 2. 确保运行时目录存在（内容不入 git） ─────────────────────────────────────
mkdir -p "$CW_SRC"/{secrets,logs,sessions,state,tasks,tool_outputs,slop_ledger}

# ── 3. 密钥：secrets.json 缺失时从 secrets.env 导入 ──────────────────────────
if [ ! -f "$CW_SRC/secrets/secrets.json" ]; then
  ENV_FILE="$CW_SRC/secrets/secrets.env"
  if [ ! -f "$ENV_FILE" ]; then
    if [ ! -f "$CW_SRC/secrets/secrets.env.example" ]; then
      echo "[error] 缺少 secrets/secrets.env.example，请检查仓库完整性" >&2
      exit 1
    fi
    cp "$CW_SRC/secrets/secrets.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "[todo ] 请编辑 $ENV_FILE 填入真实密钥后重新运行本脚本"
    echo "        （或直接导出同名环境变量，如 DEEPSEEK_API_KEY=sk-...）"
    exit 0
  fi
  declare -A PROVIDER_BY_VAR=(
    [DEEPSEEK_API_KEY]=deepseek
    [XIAOMI_MIMO_API_KEY]=xiaomi-mimo
    [OPENAI_API_KEY]=openai
    [OPENCODE_GO_API_KEY]=opencode-go
    [OPENCODE_ZEN_API_KEY]=opencode-zen
  )
  IMPORTED=0
  while IFS='=' read -r VAR KEY; do
    [ -z "$VAR" ] && continue
    case "$VAR" in \#*) continue ;; esac
    [ -z "$KEY" ] && continue
    PROVIDER="${PROVIDER_BY_VAR[$VAR]:-}"
    if [ -z "$PROVIDER" ]; then
      echo "[skip] 未识别的变量 $VAR（跳过）"
      continue
    fi
    printf '%s' "$KEY" | codewhale auth set --provider "$PROVIDER" --api-key-stdin
    echo "[set ] $PROVIDER 密钥已写入 secret store"
    IMPORTED=$((IMPORTED + 1))
  done < "$ENV_FILE"
  if [ "$IMPORTED" -eq 0 ]; then
    echo "[warn] secrets.env 中没有任何有效密钥，请先填写后再运行" >&2
    exit 1
  fi
else
  echo "[ok  ] secrets/secrets.json 已存在，密钥保持不变"
fi

# ── 4. openai-codex 外部凭据授权（机器相关，每台机器单独授权一次） ────────────
if [ -f "$HOME/.codex/auth.json" ]; then
  EXPECTED="path=\"$HOME/.codex/auth.json\""
  STATUS="$(codewhale auth status --provider openai-codex 2>/dev/null || true)"
  if printf '%s' "$STATUS" | grep -q "state=active" && printf '%s' "$STATUS" | grep -Fq "$EXPECTED"; then
    echo "[ok  ] openai-codex 外部凭据已授权（$HOME/.codex/auth.json）"
  else
    codewhale auth external-consent --provider openai-codex --mode read-only --yes || \
      echo "[warn] openai-codex 授权失败，可稍后手动执行：codewhale auth external-consent --provider openai-codex --mode read-only"
  fi
fi

# ── 5. 校验 ───────────────────────────────────────────────────────────────────
echo "──────────────────────────────────────────────────────────────"
codewhale auth status || true
echo "──────────────────────────────────────────────────────────────"
echo "完成。启动 codewhale 即可使用与主机器一致的配置。"
