# AGENTS.md

This file provides coding guidance for AI agents (including Claude Code, Codex, and others) when working with code in this repository.

## Overview

This is an **opencode plugin** that enables OAuth authentication with OpenAI's ChatGPT Plus/Pro Codex backend. It allows users to access `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.3-codex`, `gpt-5.3`, `gpt-5.2-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2`, and `gpt-5.1` models through their ChatGPT subscription instead of using OpenAI Platform API credits. Legacy GPT-5.0 models are automatically normalized to their GPT-5.1 equivalents.

**Key architecture principle**: 6-step fetch flow that intercepts opencode's OpenAI SDK requests, transforms them for the ChatGPT backend API, and handles OAuth token management per account. The implementation now also includes a proactive background refresh queue, per-account auth-failure cooldowns, tiered 429 handling, and headless/device-code auth.

## Build & Test Commands

```bash
# Build (compiles TypeScript + copies HTML file)
bun run build

# Type checking only (no build)
bun run typecheck

# Run all tests
bun run test

# Watch mode for TDD
bun run test:watch

# Interactive test UI
bun run test:ui

# Coverage report
bun run test:coverage
```

**Important**: The build script has a critical step that copies `lib/oauth-success.html` to `dist/lib/`. This HTML file is required for the OAuth callback flow.

## Code Architecture

### Plugin Flow (index.ts)

The main entry point orchestrates a **6-step fetch flow** (token refresh is now per-account inside the retry loop):

1. **URL Rewriting**: Transform OpenAI Platform API URLs (`/responses` and `/chat/completions`) → ChatGPT backend API (`https://chatgpt.com/backend-api/codex/responses`)
2. **Request Transformation**:
   - Normalize model names (all variants → `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.3`, `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, or `gpt-5.1-codex-mini`)
   - Inject Codex system instructions from latest GitHub release
   - Apply reasoning configuration (effort, summary, verbosity)
   - Add CODEX_MODE bridge prompt (default) or tool remap message (legacy)
   - Filter OpenCode system prompts when in CODEX_MODE
   - Filter conversation history (remove `rs_*` IDs for stateless operation)
3. **Account Selection + Token Refresh** (per-account retry loop):
   - Pick next account from pool using round-robin or sticky strategy
   - Skip accounts in auth-failure cooldown
   - Refresh token for selected account if expired (auth failure increments failure counter and can trigger cooldown)
   - Rotate to next account automatically on 429 responses
   - If all accounts are rate-limited but one recovers within 5 minutes, wait and retry instead of failing immediately
4. **Headers**: Add OAuth token + selected ChatGPT account ID, plus `originator=opencode`, `session_id` from the real opencode session, and a plugin-specific User-Agent
5. **Request Execution**: Send to Codex backend
6. **Response Handling**: Convert SSE to JSON (non-tool requests) or pass through; tier 429 cooldowns by ChatGPT error code; optional debug logging (`ENABLE_PLUGIN_REQUEST_LOGGING=1`)

### Module Organization

**Core Plugin** (`index.ts`)
- Plugin definition and main fetch orchestration
- OAuth loader (extracts ChatGPT account ID from JWT)
- Configuration loading and CODEX_MODE determination

**Authentication** (`lib/auth/`)
- `auth.ts`: OAuth flows (browser PKCE, headless/device-code), token exchange, JWT decoding, account ID extraction, refresh
- `server.ts`: Local HTTP server for OAuth callback (port 1455)
- `browser.ts`: Platform-specific browser opening

**Request Handling** (`lib/request/`)
- `fetch-helpers.ts`: 10 focused helper functions for main fetch flow
- `request-transformer.ts`: Body transformations (model normalization, reasoning config, input filtering)
- `response-handler.ts`: SSE to JSON conversion

**Prompts** (`lib/prompts/`)
- `codex.ts`: Fetches Codex instructions from GitHub (ETag-cached), tool remap message
- `codex-opencode-bridge.ts`: CODEX_MODE bridge prompt for CLI parity

**Configuration** (`lib/`)
- `config.ts`: Plugin config loading, CODEX_MODE determination
- `constants.ts`: All magic values, URLs, error messages, cooldown tiers, device auth endpoints
- `types.ts`: TypeScript type definitions
- `logger.ts`: Debug logging (controlled by env var)
- `refresh-queue.ts`: Proactive background token refresh for account pool entries

### Key Design Patterns

**1. Stateless Operation**: Uses `store: false` + `include: ["reasoning.encrypted_content"]`
- Allows multi-turn conversations without server-side storage
- Encrypted reasoning content persists context across turns

**2. CODEX_MODE** (enabled by default):
- **Priority**: `CODEX_MODE` env var > `~/.opencode/openai-codex-auth-config.json` > default (true)
- When enabled: Filters out OpenCode system prompts, adds Codex-OpenCode bridge prompt with Task tool & MCP awareness
- When disabled: Uses legacy tool remap message
- Bridge prompt (~550 tokens): Tool mappings, available tools, working style, **Task tool/sub-agent awareness**, **MCP tool awareness**
- **Prompt verification**: Caches OpenCode's codex.txt from GitHub (ETag-based) to verify exact prompt removal, with fallback to text signature matching

**3. Configuration Merging**:
- Global options (`provider.openai.options`) + per-model options (`provider.openai.models[name].options`)
- Model-specific options override global
- Plugin defaults: `reasoningEffort: "medium"`, `reasoningSummary: "auto"`, `textVerbosity: "medium"`

**4. Model Normalization** (GPT-5.0 → GPT-5.1 migration):
- All `gpt-5.4-pro*` variants → `gpt-5.4-pro`
- All `gpt-5.4*` variants → `gpt-5.4`
- All `gpt-5.3-codex*` variants → `gpt-5.3-codex` (newest Codex model, supports xhigh)
- All `gpt-5.3` variants → `gpt-5.3` (newest general-purpose model, supports none/low/medium/high/xhigh)
- All `gpt-5.2-codex*` variants → `gpt-5.2-codex`
- All `gpt-5.1-codex-max*` variants → `gpt-5.1-codex-max`
- All `gpt-5.1-codex*` variants → `gpt-5.1-codex`
- All `gpt-5.1-codex-mini*` variants → `gpt-5.1-codex-mini`
- All `gpt-5.2` variants → `gpt-5.2`
- All `gpt-5.1` variants → `gpt-5.1`
- **Legacy mappings** (GPT-5.0 being phased out):
  - `gpt-5-codex*` variants → `gpt-5.1-codex`
  - `gpt-5-codex-mini*` or `codex-mini-latest` → `gpt-5.1-codex-mini`
  - `gpt-5*` variants (including `gpt-5-mini`, `gpt-5-nano`) → `gpt-5.1`
- `minimal` effort auto-normalized to `low` for Codex families (including GPT-5.3 Codex and GPT-5.2 Codex) and clamped to `medium` (or `high` when requested) for Codex Mini

**5. Model-Specific Prompt Selection**:
- Different prompts for different model families (matching Codex CLI):
  - `gpt-5.3-codex*` → `gpt-5.3-codex_prompt.md` (Codex CLI agent prompt)
  - `gpt-5.3*` → `gpt_5_3_prompt.md` (GPT‑5.3 general family)
  - `gpt-5.2-codex*` → `gpt-5.2-codex_prompt.md` (Codex CLI agent prompt)
  - `gpt-5.1-codex-max*` → `gpt-5.1-codex-max_prompt.md` (frontend design guidelines)
  - `gpt-5.1-codex*`, `codex-*` → `gpt_5_codex_prompt.md` (coding focus)
  - `gpt-5.2*` → `gpt_5_2_prompt.md` (GPT‑5.2 general family)
  - `gpt-5.1*` → `gpt_5_1_prompt.md` (full behavioral guidance)
- `getModelFamily()` determines prompt selection based on normalized model

**6. Codex Instructions Caching**:
- Fetches from latest release tag (not main branch)
- ETag-based HTTP conditional requests per model family
- Separate cache files per family: `gpt-5.4-instructions.md`, `gpt-5.3-codex-instructions.md`, `gpt-5.3-instructions.md`, `gpt-5.2-codex-instructions.md`, `codex-max-instructions.md`, `codex-instructions.md`, `gpt-5.2-instructions.md`, `gpt-5.1-instructions.md`
- Cache invalidation when release tag changes
- Falls back to bundled version if GitHub unavailable

## Development Patterns

### Adding New Configuration Options

1. Add to `ConfigOptions` interface in `lib/types.ts`
2. Update `transformRequestBody()` in `lib/request/request-transformer.ts`
3. Add tests in `test/request-transformer.test.ts`
4. Document in README.md configuration section

### Modifying Request Transformation

All request transformations go through `transformRequestBody()`:
- Input filtering: `filterInput()`, `filterOpenCodeSystemPrompts()`
- Message injection: `addCodexBridgeMessage()` or `addToolRemapMessage()`
- Reasoning config: `getReasoningConfig()` (follows Codex CLI defaults, not opencode defaults)
- Model config: `getModelConfig()` (merges global + per-model options)

### OAuth Flow Modifications

OAuth implementation follows OpenAI Codex CLI patterns, with first-party opencode compatibility where it differs:
- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann`
- Browser PKCE flow with S256 challenge
- Headless/device-code auth flow via OpenAI device auth endpoints
- Special params: `codex_cli_simplified_flow=true`, `originator=opencode`
- Callback server on port 1455 (matches Codex CLI)
- Prefer `accountId` from stored auth or `id_token`, then fall back to decoding `access_token`

### Testing Strategy

- **247 comprehensive tests** covering all modules, including device auth, JWT/account-ID extraction, account-pool cooldown logic, and request transformation
- Test files mirror source structure (`test/auth.test.ts` ↔ `lib/auth/auth.ts`)
- Mock-heavy testing (no actual network calls or file I/O in tests)
- Focus on edge cases: token expiration, model normalization, input filtering, CODEX_MODE toggling

## Important Configuration Differences

This plugin **intentionally differs from opencode defaults** because it accesses ChatGPT backend API (not OpenAI Platform API):

| Setting | opencode Default | This Plugin Default | Reason |
|---------|-----------------|---------------------|--------|
| `reasoningEffort` | "high" (gpt-5) | "medium" (Codex Max defaults to "high") | Matches Codex CLI default and Codex Max capabilities |
| `textVerbosity` | "low" (gpt-5) | "medium" | Matches Codex CLI default |
| `reasoningSummary` | "detailed" | "auto" | Matches Codex CLI default |
| gpt-5-codex config | (excluded) | Full support | opencode excludes gpt-5-codex from auto-config |
| `store` | true | false | Required for ChatGPT backend |
| `include` | (not set) | `["reasoning.encrypted_content"]` | Required for stateless operation |

## File Paths & Locations

- **Plugin config**: `~/.opencode/openai-codex-auth-config.json`
- **Cache dir**: `~/.opencode/cache/`
  - `codex-instructions.md` (Codex CLI instructions from GitHub)
  - `codex-instructions-meta.json` (ETag + release tag for Codex instructions)
  - `opencode-codex.txt` (OpenCode system prompt from GitHub, for verification)
  - `opencode-codex-meta.json` (ETag for OpenCode prompt)
- **Debug logs**: `~/.opencode/logs/codex-plugin/` (when `ENABLE_PLUGIN_REQUEST_LOGGING=1`)
- **OAuth callback**: `http://localhost:1455/auth/callback`

## Environment Variables

- `CODEX_MODE`: Override config file (1=enable, 0=disable)
- `ENABLE_PLUGIN_REQUEST_LOGGING`: Enable detailed request logging (1=enable)

## TypeScript Configuration

- Target: ES2022
- Module: ES2022 with bundler resolution
- Output: `./dist/`
- Strict mode enabled
- Declaration files generated
- Source maps enabled
- Excludes: `test/`, `node_modules/`, `dist/`

## Dependencies

**Production**:
- `@openauthjs/openauth` (OAuth PKCE implementation)

**Development**:
- `@opencode-ai/plugin` (peer dependency)
- `vitest` (testing framework)
- TypeScript

**Zero external runtime dependencies** - only uses Node.js built-ins for file I/O, HTTP, crypto.
