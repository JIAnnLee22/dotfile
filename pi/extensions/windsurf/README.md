# Windsurf AI Provider Extension for Pi

This extension adds Windsurf AI as a custom provider to Pi, allowing you to use Windsurf's models through Pi's interface.

## Installation

### Getting a Windsurf API Key

To use this extension, you need a Windsurf API key. You can obtain one from:

1. **Windsurf Editor**: If you have Windsurf installed, check your account settings
2. **Windsurf Dashboard**: Visit [https://windsurf.com](https://windsurf.com) and sign in to your account
3. **API Documentation**: Check Windsurf's official documentation for API key generation

### Configuring the API Key

Once you have your API key, configure it using one of these methods:

**Method A: Environment variables**:
```bash
# Required: Your Windsurf API key
export WINDSURF_API_KEY="your-windsurf-api-key"

# Optional: Custom API base URL (if different from default)
export WINDSURF_BASE_URL="https://api.devin.ai"
```
You can add these to your `~/.bashrc`, `~/.zshrc`, or shell profile file.

**Method B: auth.json file**:
Add your API key to `~/.config/pi/auth.json`:
```json
{
  "windsurf": {
    "type": "api_key",
    "key": "your-windsurf-api-key"
  }
}
```
If you already have an auth.json file, just add the "windsurf" section.

### Loading the Extension

```bash
# Start Pi with the extension
pi -e ~/.config/pi/extensions/windsurf

# Or add it to your Pi configuration permanently
```

## Configuration

### Configuration Options

| Method | Variable/Path | Required | Description |
|--------|---------------|----------|-------------|
| Environment | `WINDSURF_API_KEY` | Yes* | Your Windsurf API key for authentication |
| Environment | `WINDSURF_BASE_URL` | No | Custom API endpoint URL (default: `https://api.devin.ai`) |
| File | `~/.config/pi/auth.json` | Yes* | API key stored in auth.json (see above) |

*You must provide the API key via either environment variable OR auth.json, not both.

### Permanent Configuration

To permanently enable this extension, add it to your Pi configuration:

1. **Via settings.json**:
   Add the extension path to your `~/.config/pi/settings.json`:
   ```json
   {
     "extensions": ["~/.config/pi/extensions/windsurf"]
   }
   ```

2. **Via command line alias**:
   Create an alias in your shell configuration:
   ```bash
   alias pi='pi -e ~/.config/pi/extensions/windsurf'
   ```

## Usage

1. **List available models**:
   ```bash
   pi --list-models | grep windsurf
   ```

2. **Select Windsurf model**:
   In Pi, use `/model` command to select a Windsurf model:
   ```
   /model windsurf/windsurf-1
   ```

3. **Start coding**:
   Once a Windsurf model is selected, use Pi normally. All requests will be routed through Windsurf's API.

## Customization

### Adding More Models

Edit `index.ts` to add additional Windsurf models:

```typescript
models: [
  {
    id: "windsurf-1",
    name: "Windsurf 1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    id: "windsurf-2",
    name: "Windsurf 2",
    reasoning: true,  // If Windsurf supports reasoning
    input: ["text", "image"],  // If Windsurf supports images
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  }
]
```

### Custom Headers

If Windsurf requires specific headers, uncomment and modify the headers section in `index.ts`:

```typescript
pi.registerProvider("windsurf", {
  headers: {
    "X-Windsurf-API-Version": "2024-01-01",
    "X-Custom-Header": "$WINDSURF_CUSTOM_HEADER"
  }
});
```

### Custom Streaming

If Windsurf's API is not OpenAI-compatible, you'll need to implement a custom streaming function. See the `custom-provider-anthropic` example in the Pi documentation for reference.

## Troubleshooting

### Common Issues

1. **Authentication errors**:
   - Verify your `WINDSURF_API_KEY` is correct
   - Check if the API key has expired

2. **Connection errors**:
   - Verify `WINDSURF_BASE_URL` is correct
   - Check network connectivity
   - Ensure Windsurf's API is accessible from your network

3. **Model not found**:
   - Verify the model ID matches what Windsurf's API supports
   - Check Windsurf's documentation for available models

### Debugging

Enable debug logging in Pi to see detailed API requests:

```bash
DEBUG=pi:* pi -e ~/.config/pi/extensions/windsurf
```

## API Compatibility

This extension uses the `openai-completions` API type, which is compatible with OpenAI's Chat Completions API. If Windsurf's API differs significantly, you may need to:

1. Implement a custom streaming function
2. Adjust the model configuration
3. Add custom headers or authentication

## Support

For issues with this extension:
1. Check Windsurf's API documentation
2. Verify your API credentials
3. Check Pi's extension loading logs

For Windsurf API issues, contact Windsurf support.

## License

This extension is provided as-is for integration purposes.