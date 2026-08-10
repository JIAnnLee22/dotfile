import {
  AssistantMessageComponent,
  BashExecutionComponent,
  CustomMessageComponent,
  keyHint,
  ToolExecutionComponent,
  truncateToVisualLines,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

/**
 * Dense UI —— 压缩内置消息框的垂直留白。
 *
 * 内置组件(用户消息 / 工具执行 / 扩展消息)在构造时用 paddingY=1 的
 * Box/Text 渲染,每条消息上下各多出 1 行空白,导致内容分散。
 * extension API 没有暴露这个 padding 的钩子,所以这里包装组件原型上
 * 负责(重)建外壳的方法,在运行时把 paddingY 归零。
 *
 * 各 patch 开关见 CONFIG,改完 `/reload` 生效:
 * - userPaddingY    用户消息内边距 → 0
 * - toolPaddingY    工具块内边距   → 0
 * - customPaddingY  扩展消息内边距 → 0
 * - toolLeadingBlank  去掉每个工具块前的空行(ToolExecutionComponent 构造器
 *                     的 Spacer(1),self-shell 如 edit 工具则去掉装饰性首空行)
 * - bashLeadingBlank 去掉每个 bash 命令块前的空行(BashExecutionComponent 的 Spacer(1))
 * - assistantSpacers 去掉助手消息内部空行(开头、thinking 后、error/abort 前)
 * - noUserMessageBg   去掉用户消息(发出去的消息)的背景色,只留纯文本
 * - collapsedMaxLines 折叠状态的工具结果最多显示的显示行数(含终端自动换行);
 *                     超过则截断并追加 "... (N more lines, 快捷键 to expand)" 提示
 *
 * - 纯运行时修补,不改 dist 文件,`pi update` 后依然生效
 * - /reload 后通过原型上的 Symbol 标记避免重复包装
 * - 水平方向由 settings.json 的 "outputPad": 0 控制(官方设置)
 *
 * 若上游把相关方法改名或删除,守卫会跳过对应修补并告警,其余修补不受影响。
 */

const MARK = Symbol("denseUiPatched");
const MARK_RENDER = Symbol("denseUiRenderPatched");
const MARK_UPDATE = Symbol("denseUiUpdatePatched");
const MARK_CAP = Symbol("denseUiCapPatched");
const MARK_CAPPED = Symbol("denseUiResultCapped");

/** 与主题 muted(#808080)接近的灰色,用于折叠截断提示 */
const GRAY = "\x1b[38;5;244m";
const RESET = "\x1b[0m";

function collapsedHint(more: number, width: number) {
  const hint =
    `${GRAY}... (${more} more lines,${RESET} ` +
    keyHint("app.tools.expand", "to expand") +
    `${GRAY})${RESET}`;
  return truncateToVisualLines(hint, 1, width).visualLines[0] ?? hint;
}

type Any = any;

const CONFIG = {
  userPaddingY: true,
  toolPaddingY: true,
  customPaddingY: true,
  toolLeadingBlank: true,
  bashLeadingBlank: true,
  assistantSpacers: true,
  noUserMessageBg: true,
  collapsedMaxLines: 10,
};

function warn(component: string, method: string) {
  console.warn(
    `[dense-ui] 找不到 ${component}#${method},跳过该修补(上游可能已改动)`,
  );
}

/** pi-tui 的 Spacer 组件,渲染为 1 行空白 */
function isSpacer(c: Any): boolean {
  return !!c && c.constructor?.name === "Spacer";
}

export default function (_pi: unknown) {
  // 1) 用户消息:内部 Box(paddingX=outputPad, paddingY=1) → paddingY=0
  if (CONFIG.userPaddingY) {
    const userProto = UserMessageComponent.prototype as Any;
    if (!userProto[MARK]) {
      if (typeof userProto.rebuild === "function") {
        const origRebuild = userProto.rebuild;
        userProto[MARK] = true;
        userProto.rebuild = function (this: Any, ...args: Any[]) {
          origRebuild.apply(this, args);
          const box = this.children?.[0];
          if (box && typeof box.paddingY === "number") {
            box.paddingY = 0;
          }
          // 去掉用户消息背景色,只保留纯文本
          if (CONFIG.noUserMessageBg && box && typeof box.setBgFn === "function") {
            box.setBgFn(undefined);
          }
        };
      } else {
        warn("UserMessageComponent", "rebuild");
      }
    }
  }

  // 2) 工具执行:外壳 Box(1,1) 与 Text("",1,1) → paddingY=0
  if (CONFIG.toolPaddingY) {
    const toolProto = ToolExecutionComponent.prototype as Any;
    if (!toolProto[MARK]) {
      if (typeof toolProto.updateDisplay === "function") {
        const origUpdate = toolProto.updateDisplay;
        toolProto[MARK] = true;
        toolProto.updateDisplay = function (this: Any, ...args: Any[]) {
          for (const shell of [this.contentBox, this.contentText]) {
            if (shell && typeof shell.paddingY === "number") {
              shell.paddingY = 0;
            }
          }
          return origUpdate.apply(this, args);
        };
      } else {
        warn("ToolExecutionComponent", "updateDisplay");
      }
    }
  }

  // 3) 扩展消息:内部 Box(1,1) → paddingY=0
  if (CONFIG.customPaddingY) {
    const customProto = CustomMessageComponent.prototype as Any;
    if (!customProto[MARK]) {
      if (typeof customProto.rebuild === "function") {
        const origRebuild = customProto.rebuild;
        customProto[MARK] = true;
        customProto.rebuild = function (this: Any, ...args: Any[]) {
          if (this.box && typeof this.box.paddingY === "number") {
            this.box.paddingY = 0;
          }
          return origRebuild.apply(this, args);
        };
      } else {
        warn("CustomMessageComponent", "rebuild");
      }
    }
  }

  // 4) 工具执行块:去掉块前空行
  //    - 默认 shell:构造器 addChild(Spacer(1)) 在 children[0],渲染前临时移除
  //    - self-shell(如 edit 工具):Spacer 不进渲染路径,改去掉装饰性首空行 ""
  if (CONFIG.toolLeadingBlank) {
    const toolProto = ToolExecutionComponent.prototype as Any;
    if (!toolProto[MARK_RENDER]) {
      if (typeof toolProto.render === "function") {
        const origRender = toolProto.render;
        toolProto[MARK_RENDER] = true;
        toolProto.render = function (this: Any, width: number) {
          const isSelf = this.getRenderShell?.() === "self";
          const kids = this.children;
          let spacer: Any;
          let removed = false;
          if (!isSelf && isSpacer(kids?.[0])) {
            spacer = kids.shift();
            removed = true;
          }
          try {
            const lines = origRender.call(this, width);
            if (isSelf && lines?.length > 0 && lines[0] === "") {
              lines.shift();
            }
            return lines;
          } finally {
            if (removed) {
              kids.unshift(spacer);
            }
          }
        };
      } else {
        warn("ToolExecutionComponent", "render");
      }
    }
  }

  // 5) bash 命令块:去掉块前空行(构造器 addChild(Spacer(1)) 在 children[0])
  if (CONFIG.bashLeadingBlank) {
    const bashProto = BashExecutionComponent.prototype as Any;
    if (!bashProto[MARK_RENDER]) {
      if (typeof bashProto.render === "function") {
        const origRender = bashProto.render;
        bashProto[MARK_RENDER] = true;
        bashProto.render = function (this: Any, width: number) {
          const kids = this.children;
          const leading = kids?.[0];
          const removed = isSpacer(leading);
          if (removed) {
            kids.shift();
          }
          try {
            return origRender.call(this, width);
          } finally {
            if (removed) {
              kids.unshift(leading);
            }
          }
        };
      } else {
        warn("BashExecutionComponent", "render");
      }
    }
  }

  // 6) 助手消息:去掉内部空行(消息开头、thinking 块后、error/abort 文本前)
  if (CONFIG.assistantSpacers) {
    const assistantProto = AssistantMessageComponent.prototype as Any;
    if (!assistantProto[MARK_UPDATE]) {
      if (typeof assistantProto.updateContent === "function") {
        const origUpdate = assistantProto.updateContent;
        assistantProto[MARK_UPDATE] = true;
        assistantProto.updateContent = function (this: Any, ...args: Any[]) {
          origUpdate.apply(this, args);
          const cc = this.contentContainer;
          if (cc && Array.isArray(cc.children)) {
            cc.children = cc.children.filter((c: Any) => !isSpacer(c));
          }
        };
      } else {
        warn("AssistantMessageComponent", "updateContent");
      }
    }
  }

  // 7) 折叠状态的工具结果:限制最大显示行数(显示行,含终端自动换行),
  //    避免 find/ls/grep 等工具默认折叠时也展示 15~20 行
  if (CONFIG.collapsedMaxLines > 0) {
    const toolProto = ToolExecutionComponent.prototype as Any;
    if (!toolProto[MARK_CAP]) {
      if (typeof toolProto.updateDisplay === "function") {
        const origUpdate = toolProto.updateDisplay;
        toolProto[MARK_CAP] = true;
        toolProto.updateDisplay = function (this: Any, ...args: Any[]) {
          origUpdate.apply(this, args);
          const comp = this.resultRendererComponent;
          if (!comp || comp[MARK_CAPPED] || typeof comp.render !== "function") {
            return;
          }
          comp[MARK_CAPPED] = true;
          const tool = this;
          const origRender = comp.render;
          comp.render = function (width: number) {
            const lines = origRender.call(this, width);
            if (tool.expanded || tool.result?.isError) {
              return lines;
            }
            const max = CONFIG.collapsedMaxLines;
            if (!Array.isArray(lines) || lines.length <= max) {
              return lines;
            }
            const kept = lines.slice(0, max);
            let more = lines.length - max;
            // 末尾若是以 [ 开头的提示行(如 [Truncated: ...])则保留
            const tail = lines[lines.length - 1];
            if (tail && /^\s*\[/.test(tail)) {
              kept.push(tail);
              more -= 1;
            }
            if (more > 0) {
              kept.push(collapsedHint(more, width));
            }
            return kept;
          };
        };
      } else {
        warn("ToolExecutionComponent", "updateDisplay");
      }
    }
  }
}
