![better-opencode-openai-codex-auth](assets/readme-hero.svg)


**Maintained by [ShivamB25](https://github.com/ShivamB25)** | Originally by [Numman Ali](https://github.com/numman-ali)
[![GitHub stars](https://img.shields.io/github/stars/ShivamB25/better-opencode-openai-codex-auth?style=social)](https://github.com/ShivamB25/better-opencode-openai-codex-auth)
[![npm version](https://img.shields.io/npm/v/better-opencode-openai-codex-auth.svg)](https://www.npmjs.com/package/better-opencode-openai-codex-auth)
[![Tests](https://github.com/ShivamB25/better-opencode-openai-codex-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/ShivamB25/better-opencode-openai-codex-auth/actions)
[![npm downloads](https://img.shields.io/npm/dm/better-opencode-openai-codex-auth.svg)](https://www.npmjs.com/package/better-opencode-openai-codex-auth)

**One install. Every Codex model.**

[Install](#quick-start) · [Models](#models) · [Configuration](#configuration) · [Docs](#docs)

---

## Philosophy

Use your ChatGPT Plus/Pro subscription for coding. No API credits. One config file, access to all GPT-5.x and Codex models.

```
ChatGPT OAuth → Codex backend → OpenCode
```

---

## Quick Start

```bash
bunx better-opencode-openai-codex-auth@latest
```

Then authenticate and run:

```bash
opencode auth login
opencode run "write hello world to test.txt" --model=openai/gpt-5.4 --variant=medium
```

**Uninstall:**

```bash
bunx better-opencode-openai-codex-auth@latest --uninstall
bunx better-opencode-openai-codex-auth@latest --uninstall --all
```

---

## Beta/Dev Versions

Test the latest features from the `dev` branch before they're released:

```bash
# Install latest dev version
bun add better-opencode-openai-codex-auth@dev

# Or install latest beta
bun add better-opencode-openai-codex-auth@beta
```

**Available tags:**
- `@dev` - Latest commit from `dev` branch (auto-published on every push)
- `@beta` - Beta releases for testing
- `@preview` - Preview builds for specific branches

To test a specific dev version:
```bash
bunx better-opencode-openai-codex-auth@dev
```

---

## Models

- **gpt-5.3** (none/low/medium/high/xhigh)
- **gpt-5.3-codex** (low/medium/high/xhigh)
- **gpt-5.4** (none/low/medium/high/xhigh)
- **gpt-5.4-pro** (medium/high/xhigh)

---

## Configuration

- **Modern** (OpenCode v1.0.210+): `config/opencode-modern.json`

Minimal configs don't work with GPT-5.x; use the full configs above.

---

## Features

- ChatGPT Plus/Pro OAuth (same flow as official Codex CLI)
- 18 model presets across GPT-5.4 and GPT-5.3 families
- Variant system support (v1.0.210+)
- Multimodal input for all models
- Usage-aware errors with automatic token refresh
- Multi-account pool with round-robin or sticky selection (`~/.opencode/openai-codex-accounts.json`)

---

## Documentation

- [Getting Started](docs/getting-started.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/development/ARCHITECTURE.md)

---

## Usage Notice

This plugin is for **personal development** with your own ChatGPT Plus/Pro subscription. For production or multi-user applications, use the [OpenAI Platform API](https://platform.openai.com/).
