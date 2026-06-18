/**
 * Devin AI Provider Extension for Pi
 *
 * Registers Devin as a custom provider using OpenAI-compatible API.
 * Supports streaming via openai-completions API type.
 *
 * Usage:
 *   # Add your Devin API key to ~/.config/pi/auth.json:
 *   # {
 *   #   "devin": {
 *   #     "type": "api_key",
 *   #     "key": "your-devin-api-key"
 *   #   }
 *   # }
 *   #
 *   # Then start pi with this extension
 *   pi -e ~/.config/pi/extensions/devin
 *   #
 *   # Or load it via settings.json
 *   #
 *   # Then use /model to select devin/devin-1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

export default function (pi: ExtensionAPI) {
  // 基础URL配置
  const baseUrl = "https://api.devin.ai";
  let apiKey: string | undefined;
  
  // 从auth.json读取API密钥
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
      const authPath = path.join(homeDir, ".config", "pi", "auth.json");
      if (fs.existsSync(authPath)) {
        const authData = JSON.parse(fs.readFileSync(authPath, "utf8"));
        if (authData.devin && authData.devin.type === "api_key" && authData.devin.key) {
          apiKey = authData.devin.key;
          console.log("Devin: 从auth.json加载API密钥");
        }
      }
    }
  } catch (error) {
    console.warn("读取auth.json失败:", error);
  }
  
  // 如果没有API密钥，跳过注册
  if (!apiKey) {
    console.warn("Devin API密钥未找到。请在 ~/.config/pi/auth.json 中添加devin配置。");
    return;
  }
  
  console.log(`Devin: 注册提供者，基础URL: ${baseUrl}`);
  
  // 注册Devin作为新提供者
  pi.registerProvider("devin", {
    name: "Devin AI",
    baseUrl: baseUrl,
    apiKey: apiKey,
    api: "openai-completions",  // 使用OpenAI Chat Completions API兼容
    
    // 定义可用模型
    models: [
      {
        id: "devin-1",
        name: "Devin 1",
        reasoning: false, // 如果Devin支持推理/思考，设置为true
        input: ["text"],  // 如果Devin支持图像输入，添加"image"
        cost: {
          input: 0,       // 更新为实际价格
          output: 0,
          cacheRead: 0,
          cacheWrite: 0
        },
        contextWindow: 128000, // 更新为实际上下文窗口
        maxTokens: 4096,       // 更新为实际最大输出token数
      },
      // 根据需要添加更多模型
      // {
      //   id: "devin-2",
      //   name: "Devin 2",
      //   reasoning: true,
      //   input: ["text", "image"],
      //   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      //   contextWindow: 200000,
      //   maxTokens: 8192,
      // }
    ],
  });

  // 可选：如果Devin需要特定的头部信息，取消注释并修改
  // pi.registerProvider("devin", {
  //   headers: {
  //     "X-Devin-API-Version": "2024-01-01",
  //     "X-Custom-Header": "$DEVIN_CUSTOM_HEADER"
  //   }
  // });
}