# Configuration

This directory contains the opencode configuration template for the OpenAI Codex OAuth plugin.

## File

**`opencode-modern.json`** — the only config. Requires opencode v1.0.210+ (variants system).
The installer (`bunx better-opencode-openai-codex-auth@latest`) writes this to `~/.config/opencode/opencode.jsonc` automatically.

The shipped template pins the plugin as `better-opencode-openai-codex-auth@latest` so fresh installs always resolve the latest published npm tarball.

## Available Models

| Model | Variants | Notes |
|-------|----------|-------|
| `gpt-5.4` | none / low / medium / high / xhigh | Latest general model |
| `gpt-5.4-pro` | medium / high / xhigh | Pro tier (no none/low) |
| `gpt-5.3-codex` | low / medium / high / xhigh | Newest Codex family |
| `gpt-5.3` | none / low / medium / high / xhigh | GPT-5.3 general |
## Manual install

```bash
cp config/opencode-modern.json ~/.config/opencode/opencode.jsonc
```
