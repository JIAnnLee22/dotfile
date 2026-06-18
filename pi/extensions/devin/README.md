# Devin AI Provider Extension for Pi

This extension adds Devin AI as a custom provider to Pi, allowing you to use Devin's models through Pi's interface.

## Installation

### Getting a Devin API Key

To use this extension, you need a Devin API key. You can obtain one from:

1. **Devin Dashboard**: Visit [https://devin.ai](https://devin.ai) and sign in to your account
2. **API Documentation**: Check Devin's official documentation for API key generation

### Configuring the API Key

Add your API key to `~/.config/pi/auth.json`:
```json
{
  "devin": {
    "type": "api_key",
    "key": "your-devin-api-key"
  }
}
```
If you already have an auth.json file, just add the "devin" section.

### Loading the Extension

The extension is already configured in your Pi settings. Just start Pi:

```bash
pi
```

## Configuration

### Configuration Options

| Method | Variable/Path | Required | Description |
|--------|---------------|----------|-------------|
| File | `~/.config/pi/auth.json` | Yes | API key stored in auth.json (see above) |

### Permanent Configuration

The extension is permanently enabled via `~/.config/pi/settings.json`:

```json
{
  "extensions": ["~/.config/pi/extensions/devin"],
  "defaultProvider": "devin",
  "defaultModel": "devin-1"
}
```

## Usage

1. **List available models**:
   ```bash
   pi --list-models | grep devin
   ```

2. **Start coding**:
   Since Devin is set as the default model, Pi will automatically use it when started.

3. **Switch models**:
   If you want to use a different model temporarily, use the `/model` command:
   ```
   /model devin/devin-1
   ```

## Customization

### Adding More Models

Edit `index.ts` to add additional Devin models:

```typescript
models: [
  {
    id: "devin-1",
    name: "Devin 1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    id: "devin-2",
    name: "Devin 2",
    reasoning: true,  // If Devin supports reasoning
    input: ["text", "image"],  // If Devin supports images
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  }
]
```

### Custom Headers

If Devin requires specific headers, uncomment and modify the headers section in `index.ts`:

```typescript
pi.registerProvider("devin", {
  headers: {
    "X-Devin-API-Version": "2024-01-01",
    "X-Custom-Header": "$DEVIN_CUSTOM_HEADER"
  }
});
```

### Custom Streaming

If Devin's API is not OpenAI-compatible, you'll need to implement a custom streaming function. See the `custom-provider-anthropic` example in the Pi documentation for reference.

## Troubleshooting

### Common Issues

1. **Authentication errors**:
   - Verify your API key is correct in `auth.json`
   - Check if the API key has expired

2. **Connection errors**:
   - Check network connectivity
   - Ensure Devin's API is accessible from your network (default endpoint: `https://api.devin.ai`)

3. **Model not found**:
   - Verify the model ID matches what Devin's API supports
   - Check Devin's documentation for available models

### Debugging

Enable debug logging in Pi to see detailed API requests:

```bash
DEBUG=pi:* pi
```

## API Compatibility

This extension uses the `openai-completions` API type, which is compatible with OpenAI's Chat Completions API. If Devin's API differs significantly, you may need to:

1. Implement a custom streaming function
2. Adjust the model configuration
3. Add custom headers or authentication

## Support

For issues with this extension:
1. Check Devin's API documentation
2. Verify your API credentials
3. Check Pi's extension loading logs

For Devin API issues, contact Devin support.

## License

This extension is provided as-is for integration purposes.