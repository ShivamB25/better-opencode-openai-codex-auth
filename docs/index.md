# better-opencode-openai-codex-auth

> Access GPT-5 Codex through your ChatGPT Plus/Pro subscription in OpenCode

[![npm version](https://img.shields.io/npm/v/better-opencode-openai-codex-auth.svg)](https://www.npmjs.com/package/better-opencode-openai-codex-auth)
[![Tests](https://github.com/ShivamB25/better-opencode-openai-codex-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/ShivamB25/better-opencode-openai-codex-auth/actions)

> **Maintained by [ShivamB25](https://github.com/ShivamB25)**
> Originally by [Numman Ali](https://github.com/numman-ali) — [star the repo](https://github.com/ShivamB25/better-opencode-openai-codex-auth) if this helps you!

## ⚠️ Usage Notice

**This plugin is for personal development use only.** It uses OpenAI's official OAuth authentication (the same method as OpenAI's official Codex CLI) for individual coding assistance with your ChatGPT Plus/Pro subscription.

**Not for:** Commercial services, API resale, or multi-user applications. For production use, see [OpenAI Platform API](https://platform.openai.com/).

Users are responsible for compliance with [OpenAI's Terms of Use](https://openai.com/policies/terms-of-use/).

---

## Quick Links

### For Users
- [Getting Started](getting-started.md) - Complete installation and setup guide
- [Configuration Guide](configuration.md) - Advanced config options and patterns
- [Troubleshooting](troubleshooting.md) - Debug techniques and common issues
- [Privacy & Data Handling](privacy.md) - How your data is handled and protected
- [Release Notes](https://github.com/ShivamB25/better-opencode-openai-codex-auth/releases) - Version history and updates

### For Developers
Explore the engineering depth behind this plugin:
- [Architecture](development/ARCHITECTURE.md) - Technical design, AI SDK compatibility, store:false explained
- [Config System](development/CONFIG_FLOW.md) - How configuration loading and merging works
- [Config Fields](development/CONFIG_FIELDS.md) - Understanding config keys, `id`, and `name` fields
- [Testing Guide](development/TESTING.md) - Test scenarios, integration testing, verification matrix

---

## Getting Started

### Installation

One-command install/update (global config):

```bash
bunx better-opencode-openai-codex-auth@latest
```

Legacy OpenCode (v1.0.209 and below):

```bash
bunx better-opencode-openai-codex-auth@latest --legacy
```

Then run OpenCode and authenticate:

```bash
# 1. Add plugin to ~/.config/opencode/opencode.jsonc (or .json)
# 2. Run OpenCode
opencode

# 3. Authenticate
opencode auth login
```

If the browser callback fails (SSH/WSL/remote), choose **"ChatGPT Plus/Pro (Manual URL Paste)"** and paste the full redirect URL.

### Updating

Re-run the installer to update:

```bash
bunx better-opencode-openai-codex-auth@latest
```

### Quick Test

```bash
opencode run "write hello world to test.txt" --model=openai/gpt-5.2 --variant=medium
```

---

## Features

✅ **OAuth Authentication** - Secure ChatGPT Plus/Pro login
✅ **GPT 5.3 + GPT 5.2 + GPT 5.1 Models** - 33 pre-configured variants across GPT 5.3, GPT 5.3 Codex, GPT 5.2, GPT 5.2 Codex, GPT 5.1 families
✅ **Variant system support** - Works with OpenCode v1.0.210+ model variants and legacy presets
✅ **Per-Model Configuration** - Different reasoning effort, including `xhigh` for GPT 5.3, GPT 5.2, GPT 5.2 Codex, and Codex Max
✅ **Multi-Turn Conversations** - Full conversation history with stateless backend
✅ **Verified Configuration** - Use `config/opencode-modern.json` (v1.0.210+) or `config/opencode-legacy.json` (older)
✅ **Comprehensive Testing** - 247 unit tests

> **⚠️ Important**: GPT 5 models can be temperamental. Use the official config for your OpenCode version (`opencode-modern.json` or `opencode-legacy.json`). Older GPT 5.0 models are deprecated.

---

## Why This Plugin?

**Use your ChatGPT subscription instead of OpenAI API credits**

- No separate API key needed
- Access Codex models through ChatGPT Plus/Pro
- Same OAuth login as official Codex CLI
- Full feature parity with Codex CLI

---

## How It Works

The plugin intercepts OpenCode's OpenAI SDK requests and transforms them for the ChatGPT backend API:

1. **URL Rewriting** - Routes OpenAI SDK requests to ChatGPT Codex backend
2. **Request Transformation** - Normalizes models, injects Codex instructions, applies reasoning config
3. **Account Pool + Token Refresh** - Per-account rotation on 429, per-account token refresh
4. **Stateless Operation** - Works with ChatGPT backend's `store: false` requirement

See [Architecture](development/ARCHITECTURE.md) for technical details.

---

## Development

This plugin represents significant engineering effort to bridge OpenCode and the ChatGPT Codex backend:

- **6-step fetch flow** with per-account token refresh and 429 rotation
- **AI SDK compatibility layer** handling `item_reference` and other SDK constructs
- **Stateless multi-turn** conversations via encrypted reasoning content
- **15-minute caching** to prevent GitHub API rate limits
- **Comprehensive test coverage** with actual API verification

**Explore the development docs** to see the depth of implementation:
- [Architecture Deep Dive](development/ARCHITECTURE.md)
- [Configuration System Internals](development/CONFIG_FLOW.md)
- [Testing & Verification](development/TESTING.md)

---

## Support

- **Issues**: [GitHub Issues](https://github.com/ShivamB25/better-opencode-openai-codex-auth/issues)
- **Releases**: [Release Notes](https://github.com/ShivamB25/better-opencode-openai-codex-auth/releases)
- **Main Repo**: [GitHub](https://github.com/ShivamB25/better-opencode-openai-codex-auth)

---

## License

MIT License with Usage Disclaimer - See [LICENSE](../LICENSE) for details

---

**Trademark Notice:** Not affiliated with OpenAI. ChatGPT, GPT-5, Codex, and OpenAI are trademarks of OpenAI, L.L.C.
