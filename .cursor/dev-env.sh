# shellcheck shell=bash
# Development environment defaults for the FinOps Engine Cloud Agent.
#
# Each value is only filled when the variable is unset or empty (`:=`), so any
# real credential injected through Cursor Secrets (SECRET_KEY or the provider
# API keys) is always respected and never overwritten by these dev defaults.
#
# The placeholder provider keys let server.js pass its startup model-routing
# validation and serve the UI + control-plane locally. Actual model dispatch to
# OpenAI/Anthropic/xAI requires real keys added as Cursor Secrets.

# Local infrastructure started by .cursor/start.sh
: "${DATABASE_URL:=postgresql://finops:finops@localhost:5432/finops_dev}"
: "${REDIS_URL:=redis://localhost:6379}"

# Shared login password + HMAC session key (dev-only default).
: "${SECRET_KEY:=dev-local-secret-key-please-change-32chars-minimum}"

# Node server port.
: "${PORT:=3000}"

# Provider credentials (placeholders unless supplied via Cursor Secrets).
: "${OPENAI_API_KEY:=dev-openai-placeholder-key}"
: "${ANTHROPIC_API_KEY:=dev-anthropic-placeholder-key}"
: "${XAI_API_KEY:=dev-xai-placeholder-key}"

# Complete AI-role routing policy (mirrors .env.example). All twelve fields are
# required together; partial policies fail server startup by design.
: "${REASONER_PROVIDER:=OPENAI}"
: "${REASONER_MODEL:=gpt-5.6-sol}"
: "${REASONER_FALLBACK_PROVIDER:=XAI}"
: "${REASONER_FALLBACK_MODEL:=grok-4.6}"

: "${WORKHORSE_PROVIDER:=ANTHROPIC}"
: "${WORKHORSE_MODEL:=claude-sonnet-5}"
: "${WORKHORSE_FALLBACK_PROVIDER:=XAI}"
: "${WORKHORSE_FALLBACK_MODEL:=grok-4.6}"

: "${QUALITY_CHECKER_PROVIDER:=XAI}"
: "${QUALITY_CHECKER_MODEL:=grok-4.6}"
: "${QUALITY_CHECKER_FALLBACK_PROVIDER:=ANTHROPIC}"
: "${QUALITY_CHECKER_FALLBACK_MODEL:=claude-sonnet-5}"

export DATABASE_URL REDIS_URL SECRET_KEY PORT
export OPENAI_API_KEY ANTHROPIC_API_KEY XAI_API_KEY
export REASONER_PROVIDER REASONER_MODEL REASONER_FALLBACK_PROVIDER REASONER_FALLBACK_MODEL
export WORKHORSE_PROVIDER WORKHORSE_MODEL WORKHORSE_FALLBACK_PROVIDER WORKHORSE_FALLBACK_MODEL
export QUALITY_CHECKER_PROVIDER QUALITY_CHECKER_MODEL QUALITY_CHECKER_FALLBACK_PROVIDER QUALITY_CHECKER_FALLBACK_MODEL
