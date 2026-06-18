/**
 * Windsurf API Provider Extension for Pi
 *
 * Registers Windsurf as a custom provider using OpenAI-compatible API.
 * Supports streaming via openai-completions API type.
 *
 * Usage:
 *   # Set your Windsurf API key
 *   export WINDSURF_API_KEY="your-windsurf-api-key"
 *
 *   # Optional: Set custom base URL if Windsurf's API endpoint differs
 *   export WINDSURF_BASE_URL="https://api.windsurf.com/v1"
 *
 *   # Then start pi with this extension
 *   pi -e ~/.config/pi/extensions/windsurf
 *
 *   # Or load it via settings.json
 *
 * Then use /model to select windsurf/windsurf-1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

export default function (pi: ExtensionAPI) {
  // Get configuration from environment variables
  const baseUrl = process.env.WINDSURF_BASE_URL || "https://api.devin.ai";
  let apiKey = process.env.WINDSURF_API_KEY;
  
  // If API key not in environment, try to read from auth.json
  if (!apiKey) {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      if (homeDir) {
        const authPath = path.join(homeDir, ".config", "pi", "auth.json");
        if (fs.existsSync(authPath)) {
          const authData = JSON.parse(fs.readFileSync(authPath, "utf8"));
          if (authData.windsurf && authData.windsurf.type === "api_key" && authData.windsurf.key) {
            apiKey = authData.windsurf.key;
            console.log("Windsurf: API key loaded from auth.json");
          }
        }
      }
    } catch (error) {
      console.warn("Failed to read auth.json:", error);
    }
  } else {
    console.log("Windsurf: API key loaded from environment variable");
  }
  
  // Skip registration if API key is not set
  if (!apiKey) {
    console.warn("Windsurf API key not found. Set WINDSURF_API_KEY environment variable or add to ~/.config/pi/auth.json.");
    return;
  }
  
  console.log(`Windsurf: Registering provider with base URL: ${baseUrl}`);
  
  // Register Windsurf as a new provider
  pi.registerProvider("windsurf", {
    name: "Windsurf AI",
    baseUrl: baseUrl,
    apiKey: apiKey,
    api: "openai-completions",  // Use OpenAI Chat Completions API compatibility
    
    // Define available models
    models: [
      {
        id: "windsurf-1",
        name: "Windsurf 1",
        reasoning: false, // Set to true if Windsurf supports reasoning/thinking
        input: ["text"],  // Add "image" if Windsurf supports image input
        cost: {
          input: 0,       // Update with actual pricing
          output: 0,
          cacheRead: 0,
          cacheWrite: 0
        },
        contextWindow: 128000, // Update with actual context window
        maxTokens: 4096,       // Update with actual max output tokens
      },
      // Add more models as needed
      // {
      //   id: "windsurf-2",
      //   name: "Windsurf 2",
      //   reasoning: true,
      //   input: ["text", "image"],
      //   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      //   contextWindow: 200000,
      //   maxTokens: 8192,
      // }
    ],
  });

  // Optional: Add custom headers if Windsurf requires them
  // pi.registerProvider("windsurf", {
  //   headers: {
  //     "X-Windsurf-API-Version": "2024-01-01",
  //     "X-Custom-Header": "$WINDSURF_CUSTOM_HEADER"
  //   }
  // });
}