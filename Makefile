# Geldlage — developer entry points
#
# Quick start:
#   make dev     # llama-server + Next.js app together (offers model download
#                # on first run; Ctrl-C tears down what dev started itself)
#   make stop    # stop llama-server + remove the dev OIDC provider containers
#
# Machine-specific overrides (binary paths, env) belong in Makefile.local
# (gitignored, included below).

# ── LLM configuration ────────────────────────────────────────────────────────
# The pinned model: one exact file from Hugging Face, resolved at a pinned
# revision. `make model` downloads it into $(MODEL_DIR) and records the path
# in $(MODEL_FILE). No Ollama involved anywhere.
# Alternative quant, e.g. unsloth's slightly smaller imatrix build:
#   make model MODEL_HF_REPO=unsloth/Qwen3.8-27B-GGUF MODEL_HF_FILE=Qwen3.8-27B-UD-Q4_K_M.gguf MODEL_HF_REVISION=
#   (MODEL_HF_REVISION= pins nothing / tracks the repo default branch)
MODEL_HF_REPO     ?= ggml-org/Qwen3.8-27B-GGUF
MODEL_HF_FILE     ?= Qwen3.8-27B-Q4_K_M.gguf
MODEL_HF_REVISION ?= 0669b98607d47046c7c2b3f801011d54a08cfccf
MODEL_DIR         ?= models
MODEL_SIZE        ?= 18973870432
MODEL_FILE        ?= .llm-model
LLM_HOST          ?= 127.0.0.1
LLM_PORT          ?= 8080
LLM_CTX           ?= 8192
# Thinking models: `on` lets the model reason before answering (the client
# reserves LLM_REASONING_BUDGET thinking tokens in max_tokens, so enable
# it there too); `off` disables the thinking phase entirely. Only `on` and
# `off` are supported: `auto` would let the model's chat template decide
# per request whether to think, and the client cannot reserve max_tokens
# for a maybe-thinking model.
LLM_REASONING     ?= off
# Server-side cap on thinking tokens (--reasoning-budget); 0 means no cap.
# Default 1024: sized for the reference machine (Ryzen 5 5600X, 32 GB RAM,
# RTX 3070 Ti — 27B Q4_K_M at ~3.5-4 t/s): covers the model's typical
# traces while a worst-case request (full cap + label JSON + prompt eval)
# fits the app's 600 s LLM_TIMEOUT_MS (timeouts are never retried). The
# app-side LLM_REASONING_BUDGET reserve should match.
LLM_REASONING_BUDGET ?= 1024

# ── Dev OIDC provider (Authentik in Docker) ─────────────────────────────────
# Throwaway Authentik stack (compose.dev.yaml) for the mandatory OIDC login
# (ADR-0032). OIDC_PORT is what the app's OIDC_ISSUER_URL points at
# (issuer: http://localhost:$(OIDC_PORT)/application/o/geldlage/).
OIDC_PORT         ?= 8081
OIDC_COMPOSE      ?= compose.dev.yaml

# an empty MODEL_HF_REVISION means "track the repo default branch"
MODEL_REV = $(if $(MODEL_HF_REVISION),$(MODEL_HF_REVISION),main)
MODEL_URL = https://huggingface.co/$(MODEL_HF_REPO)/resolve/$(MODEL_REV)/$(MODEL_HF_FILE)
MODEL_PATH = $(MODEL_DIR)/$(MODEL_HF_FILE)

# Local overrides (LLAMA_SERVER, LLAMA_ENV, MODEL_FILE, …)
-include Makefile.local

# llama-server binary: LLAMA_SERVER (env/Makefile.local) wins, else PATH.
# GPU support is auto-detected at launch via --list-devices: a CUDA/Vulkan/
# ROCm-capable build runs with GPU offload, a CPU-only build runs on CPU
# with a warning (never through Ollama). To opt into Ollama's vendored
# GPU-capable llama-server explicitly, create Makefile.local with:
#   LLAMA_SERVER = /usr/lib/ollama/llama-server
#   LLAMA_ENV = GGML_BACKEND_PATH=/usr/lib/ollama/cuda_v13/libggml-cuda.so \
#               LD_LIBRARY_PATH=/usr/lib/ollama/cuda_v13
LLAMA_SERVER ?= $(shell command -v llama-server 2>/dev/null)

# recipes use bash-only syntax (arrays, ${auth[@]}) — don't rely on /bin/sh
SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.PHONY: help dev app model llm llm-kill stop llm-stop llm-status oidc oidc-teardown-legacy oidc-down oidc-stop oidc-status oidc-logs test check format build start

help:
	@echo "Geldlage — make targets:"
	@echo "  make dev        llama-server + dev OIDC provider + dev app together (offers model download; Ctrl-C tears down what it started)"
	@echo "  make app        dev app only (llama-server + OIDC provider must already run)"
	@echo "  make oidc       start the dev OIDC provider (Authentik, :$(OIDC_PORT)) + provision the client"
	@echo "  make oidc-down  stop and remove the dev OIDC provider containers (config survives in a named volume)"
	@echo "  make oidc-stop  alias for oidc-down"
	@echo "  make oidc-status health check for the dev OIDC provider"
	@echo "  make oidc-logs  tail the dev OIDC provider logs"
	@echo "  make model      download the pinned model ($(MODEL_HF_FILE), ~$$(($(MODEL_SIZE) / 1000000000)) GB) — run once"
	@echo "  make llm        start llama-server in the background (log: /tmp/llama-server.log)"
	@echo "                  reasoning: make llm LLM_REASONING=on (budget defaults to $(LLM_REASONING_BUDGET))"
	@echo "  make stop       interactive teardown: llama-server + dev OIDC provider"
	@echo "  make llm-stop   llama-server-only teardown (no OIDC)"
	@echo "  make llm-status health + GPU usage check"
	@echo "  make test       run the vitest suite"
	@echo "  make check      typecheck + lint + prettier"
	@echo "  make format     prettier write"
	@echo "  make build      production build"
	@echo "  make start      run the production build"
	@echo ""
	@echo "Model source: $(MODEL_URL)"
	@echo "Model file:   $(MODEL_PATH)"
	@echo "Server binary: $(LLAMA_SERVER)"
	@echo "Custom model: make llm MODEL=/path/to/model.gguf"

# ── combined / app ───────────────────────────────────────────────────────────
# dev = llama-server (if not already running) + dev OIDC provider (if not
# already running) + foreground app. Anything this command started itself is
# torn down on exit (llama-server via pidfile, OIDC stack via `compose down`
# — containers removed, the authentik-db named volume keeps the provisioned
# client). Pre-existing llama-server or a pre-existing OIDC stack is left
# alone (tracked via marker files), so parallel sessions don't steal each
# other's services.
dev:
	@if ! curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health >/dev/null 2>&1; then \
		rm -f /tmp/llama-server.managed; \
		$(MAKE) --no-print-directory llm; \
		touch /tmp/llama-server.managed; \
	else \
		echo "llama-server already running on :$(LLM_PORT) (left running after exit)"; \
		rm -f /tmp/llama-server.managed; \
	fi; \
	if curl -sf -m 2 http://localhost:$(OIDC_PORT)/-/health/ready/ >/dev/null 2>&1 || docker compose --env-file compose.dev.env -f $(OIDC_COMPOSE) ps --quiet 2>/dev/null | grep -q .; then \
		echo "dev OIDC provider already running on :$(OIDC_PORT) (left running after exit)"; \
		rm -f /tmp/geldlage-oidc.managed; \
	else \
		touch /tmp/geldlage-oidc.managed; \
	fi; \
	trap 'rc=$$?; \
		if [ -f /tmp/llama-server.managed ]; then \
			rm -f /tmp/llama-server.managed; \
			$(MAKE) --no-print-directory llm-kill || true; \
		fi; \
		if [ -f /tmp/geldlage-oidc.managed ]; then \
			rm -f /tmp/geldlage-oidc.managed; \
			$(MAKE) --no-print-directory oidc-down || true; \
		fi; \
		exit $$rc' EXIT INT TERM; \
	$(MAKE) --no-print-directory oidc; \
	if [ ! -d node_modules ]; then echo "installing dependencies…"; bun install; fi; \
	bun dev

app:
	@if [ ! -d node_modules ]; then echo "installing dependencies…"; bun install; fi; \
	$(MAKE) --no-print-directory oidc; \
	bun dev

# ── model management ────────────────────────────────────────────────────────
# Interactive offer used by `dev` and `llm`: when no model is configured,
# ask whether to run the (large) download now. Non-tty (CI/pipes) → fail
# fast with instructions instead.
define model_offer
	if [ ! -t 0 ]; then \
		echo "No model configured."; \
		echo "Run:  make model   (downloads $(MODEL_HF_REPO)/$(MODEL_HF_FILE), ~$$(($(MODEL_SIZE) / 1000000000)) GB)"; \
		echo "or:   make llm MODEL=/path/to/model.gguf"; \
		exit 1; \
	fi; \
	printf "No model configured (%s, ~%s GB).\n" "$(MODEL_PATH)" "$$(($(MODEL_SIZE) / 1000000000))"; \
	printf "Download now from Hugging Face (%s)? [y/N] " "$(MODEL_HF_REPO)"; \
	read -r answer; \
	case "$$answer" in \
		y|Y|yes|Yes|YES) $(MAKE) --no-print-directory model || exit 1; ;; \
		*) \
			echo "Aborted. Download later with:"; \
			echo "  make model"; \
			echo "or point at an existing GGUF:"; \
			echo "  make llm MODEL=/path/to/model.gguf"; \
			exit 1; ;; \
	esac
endef

# ── llama-server ────────────────────────────────────────────────────────────
llm:
	@if [ "$(LLM_REASONING)" != "on" ] && [ "$(LLM_REASONING)" != "off" ]; then \
		echo "LLM_REASONING must be 'on' or 'off' (got '$(LLM_REASONING)') — 'auto' is not supported: the client cannot reserve thinking tokens for a maybe-thinking model"; \
		exit 1; \
	fi; \
	if curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health >/dev/null 2>&1; then \
		echo "llama-server already running on :$(LLM_PORT)"; \
		rm -f /tmp/llama-server.pid /tmp/llama-server.managed; \
		exit 0; \
	fi; \
	rm -f /tmp/llama-server.pid /tmp/llama-server.managed; \
	if [ -n "$(MODEL)" ]; then model="$(MODEL)"; \
	elif [ -f "$(MODEL_FILE)" ] && [ -f "$$(cat $(MODEL_FILE) 2>/dev/null)" ]; then model=$$(cat $(MODEL_FILE)); \
	else model=""; fi; \
	if [ -z "$$model" ] || [ ! -f "$$model" ]; then \
		$(model_offer); \
		model="$$(cat $(MODEL_FILE) 2>/dev/null)"; \
	fi; \
	if [ -z "$$model" ] || [ ! -f "$$model" ]; then \
		echo "no usable model after setup — aborting (expected path recorded in $(MODEL_FILE))"; \
		exit 1; \
	fi; \
	if [ -z "$(LLAMA_SERVER)" ]; then \
		echo "llama-server not found on PATH."; \
		echo "Install llama.cpp (CUDA build for GPU) or set LLAMA_SERVER=/path/to/llama-server"; \
		exit 1; \
	fi; \
	if $(LLAMA_ENV) $(LLAMA_SERVER) --list-devices 2>/dev/null | grep -qE "CUDA0|Vulkan0|ROCm|SYCL0"; then \
		gpu_args="-ngl auto --fit on"; \
		echo "GPU detected — starting with GPU offload"; \
	else \
		gpu_args="-ngl 0"; \
		echo "WARNING: no GPU support in $(LLAMA_SERVER) — running CPU-only (slow)."; \
		if [ -x /usr/lib/ollama/llama-server ] && [ -f /usr/lib/ollama/cuda_v13/libggml-cuda.so ]; then \
			echo "hint: a GPU-capable llama-server exists (shipped by Ollama). To opt in explicitly, create Makefile.local:"; \
			echo "  LLAMA_SERVER = /usr/lib/ollama/llama-server"; \
			echo "  LLAMA_ENV = GGML_BACKEND_PATH=/usr/lib/ollama/cuda_v13/libggml-cuda.so LD_LIBRARY_PATH=/usr/lib/ollama/cuda_v13"; \
		fi; \
	fi; \
	if [ "$(LLM_REASONING)" = "on" ]; then \
		echo "reasoning on — set LLM_REASONING=true in the app env too (.env), or the client won't reserve LLM_REASONING_BUDGET thinking tokens and the JSON truncates"; \
	fi; \
	echo "Starting llama-server ($$model) on :$(LLM_PORT)…"; \
	reasoning_args="--reasoning $(LLM_REASONING)"; \
	if [ "$(LLM_REASONING_BUDGET)" != "0" ]; then \
		reasoning_args="$$reasoning_args --reasoning-budget $(LLM_REASONING_BUDGET)"; \
	fi; \
	$(LLAMA_ENV) nohup $(LLAMA_SERVER) -m "$$model" -c $(LLM_CTX) -np 1 -fa on -ctk q8_0 -ctv q8_0 $$gpu_args $$reasoning_args --host $(LLM_HOST) --port $(LLM_PORT) --no-webui > /tmp/llama-server.log 2>&1 & \
	pid=$$!; \
	echo "pid $$pid — log: /tmp/llama-server.log"; \
	echo $$pid > /tmp/llama-server.pid; \
	$(MAKE) --no-print-directory llm-wait

# Download the pinned model from Hugging Face (resumable; no Ollama).
model:
	@if [ -n "$(MODEL)" ]; then \
		if [ ! -f "$(MODEL)" ]; then echo "MODEL=$(MODEL): file not found"; exit 1; fi; \
		readlink -f "$(MODEL)" > $(MODEL_FILE); \
		echo "Model set: $$(cat $(MODEL_FILE))"; \
		exit 0; \
	fi; \
	if [ -f "$(MODEL_FILE)" ] && [ -f "$$(cat $(MODEL_FILE))" ]; then \
		echo "Model already configured: $$(cat $(MODEL_FILE))"; \
		exit 0; \
	fi; \
	mkdir -p $(MODEL_DIR); \
	url="$(MODEL_URL)"; \
	if [ -n "$${HF_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $$HF_TOKEN"); \
	else auth=(); fi; \
	echo "Downloading $(MODEL_HF_REPO)/$(MODEL_HF_FILE) (~$$(($(MODEL_SIZE) / 1000000000)) GB)…"; \
	echo "  $$url"; \
	curl -L -C - --fail --progress-bar $${auth[@]+"$${auth[@]}"} -o "$(MODEL_PATH).part" "$$url" || { \
		echo "download failed (resumable — re-run 'make model' to continue)"; exit 1; }; \
	if [ "$$(stat -c %s "$(MODEL_PATH).part")" -lt 1000000000 ]; then \
		echo "downloaded file suspiciously small — aborting"; exit 1; \
	fi; \
	if [ "$$(head -c 4 "$(MODEL_PATH).part")" != "GGUF" ]; then \
		echo "downloaded file is not a GGUF — aborting"; exit 1; \
	fi; \
	mv "$(MODEL_PATH).part" "$(MODEL_PATH)"; \
	readlink -f "$(MODEL_PATH)" > $(MODEL_FILE); \
	echo "Model ready: $$(cat $(MODEL_FILE)) (recorded in $(MODEL_FILE))"

llm-wait:
	@echo -n "waiting for llama-server"; \
	for i in $$(seq 1 120); do \
		if curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health 2>/dev/null | grep -q ok; then \
			echo " ready"; exit 0; \
		fi; \
		pid=$$(cat /tmp/llama-server.pid 2>/dev/null || echo ""); \
		if [ -n "$$pid" ] && [ $$i -gt 3 ] && ! kill -0 $$pid 2>/dev/null; then \
			echo; echo "llama-server failed to start — last log lines:"; \
			tail -5 /tmp/llama-server.log | strings; exit 1; \
		fi; \
		printf "."; sleep 2; \
	done; \
	echo; echo "timeout waiting for llama-server — see /tmp/llama-server.log"; exit 1

# Pidfile-targeted llama-server teardown, no health-check verdict and no
# OIDC coupling: used by the `dev` trap (only after `dev` started
# llama-server itself) and by `stop`. A failed health check never aborts
# callers — `stop` reports leftovers; `dev`'s trap just reaps the pidfile.
llm-kill:
	@if [ -s /tmp/llama-server.pid ]; then \
		kill -9 $$(cat /tmp/llama-server.pid) 2>/dev/null || true; \
	fi; \
	rm -f /tmp/llama-server.pid /tmp/llama-server.managed; \
	sleep 1

# Interactive teardown: llama-server (pidfile-targeted) + the dev OIDC
# provider containers. Only llama-server processes this project started are
# touched; the health check reports leftovers without failing the target.
stop:
	@$(MAKE) --no-print-directory llm-kill; \
	if curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health >/dev/null 2>&1; then \
		echo "llama-server still running on :$(LLM_PORT) — kill it manually"; \
	else \
		echo "stopped"; \
	fi; \
	$(MAKE) --no-print-directory oidc-down

# llama-server-only teardown (no OIDC coupling): pidfile-targeted kill plus
# the same health-check report as `stop`. `stop` also removes the dev OIDC
# containers; use this when only llama-server should be restarted.
llm-stop:
	@$(MAKE) --no-print-directory llm-kill; \
	if curl -s -m 2 http://$(LLM_HOST):$(LLM_PORT)/health >/dev/null 2>&1; then \
		echo "llama-server still running on :$(LLM_PORT) — kill it manually"; \
	else \
		echo "stopped"; \
	fi

llm-status:
	@curl -s -m 3 http://$(LLM_HOST):$(LLM_PORT)/health && echo " (llama-server ok)" || echo "llama-server unreachable"
	@nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader 2>/dev/null || true

# ── dev OIDC provider (Authentik) ───────────────────────────────────────────
# Starts the compose.dev.yaml stack when :$(OIDC_PORT) is not ready yet,
# waits for first-boot migrations, then idempotently provisions the
# geldlage client (scripts/dev-oidc-provision.ts). OIDC_ISSUER_URL /
# OIDC_CLIENT_* in .env must match the values baked in there.
#
# One-time pre-rebrand cleanup: the compose project was renamed
# (dkb-analytics-dev-oidc → geldlage-dev-oidc), and a still-running old
# stack would keep holding :$(OIDC_PORT), making the health check below
# skip starting the renamed stack and silently provision into the old
# project's Authentik. `oidc-teardown-legacy` removes it (no-op when
# absent, exits 0); the orphaned dkb-analytics-dev-oidc_authentik-db
# volume is kept — docker volume rm by hand if you want it gone.
#
# Credentials: compose.dev.yaml reads them from compose.dev.env (gitignored,
# dockerignored). On first run a copy of compose.dev.env.example is created;
# edit it to change any password. The stack is bound to 127.0.0.1 — it must
# never be reachable from other network hosts.
oidc-teardown-legacy:
	@if docker ps -a --filter label=com.docker.compose.project=dkb-analytics-dev-oidc --quiet | grep -q .; then \
		echo "removing pre-rebrand dev OIDC stack (dkb-analytics-dev-oidc)…"; \
		docker compose -p dkb-analytics-dev-oidc down; \
	fi

oidc: oidc-teardown-legacy
	@if [ ! -f compose.dev.env ]; then \
		cp compose.dev.env.example compose.dev.env; \
		echo "created compose.dev.env from compose.dev.env.example — edit it to set your dev IdP passwords"; \
	fi; \
	if curl -s -m 2 http://localhost:$(OIDC_PORT)/-/health/ready/ >/dev/null 2>&1; then \
		echo "dev OIDC provider already running on :$(OIDC_PORT)"; \
	else \
		if ! docker info >/dev/null 2>&1; then \
			echo "docker is not running — start it (or the podman equivalent) first"; \
			exit 1; \
		fi; \
		echo "starting dev OIDC provider (Authentik) on :$(OIDC_PORT)…"; \
		docker compose --env-file compose.dev.env -f $(OIDC_COMPOSE) up -d --quiet-pull || exit 1; \
	fi; \
	$(MAKE) --no-print-directory oidc-wait; \
	AUTHENTIK_BOOTSTRAP_TOKEN="$$(sed -n 's/^AUTHENTIK_BOOTSTRAP_TOKEN=//p' compose.dev.env)" bun scripts/dev-oidc-provision.ts; \
	issuer="$$(grep -oP '^OIDC_ISSUER_URL=\K.*' .env 2>/dev/null || echo http://localhost:$(OIDC_PORT)/application/o/geldlage/)"; \
	if curl -sf -m 5 "$${issuer}.well-known/openid-configuration" >/dev/null 2>&1; then \
		echo "OIDC discovery ready: $$issuer"; \
	else \
		echo "WARNING: OIDC discovery not reachable at $${issuer}.well-known/openid-configuration"; \
		exit 1; \
	fi

# Polls /-/health/ready/ (200 when ready) while first-boot migrations run
# (can take a minute on the very first start). OIDC discovery is confirmed
# by the `oidc` target after provisioning.
oidc-wait:
	@echo -n "waiting for dev OIDC provider"; \
	for i in $$(seq 1 60); do \
		if curl -sf -m 2 http://localhost:$(OIDC_PORT)/-/health/ready/ >/dev/null 2>&1; then \
			echo " ready"; \
			break; \
		fi; \
		printf "."; sleep 2; \
	done; \
	if ! curl -sf -m 2 http://localhost:$(OIDC_PORT)/-/health/ready/ >/dev/null 2>&1; then \
		echo; echo "timeout waiting for the dev OIDC provider — see: make oidc-logs"; exit 1; \
	fi

# compose `down` (not `down -v`): containers are removed, but the
# authentik-db named volume keeps the provisioned geldlage client and
# bootstrap state, so the next `make oidc` re-creates and re-provisions from
# the current compose.dev.env instead of serving stale volume state.
oidc-down:
	@if [ ! -f compose.dev.env ]; then cp compose.dev.env.example compose.dev.env; fi; \
	if docker compose --env-file compose.dev.env -f $(OIDC_COMPOSE) ps --quiet 2>/dev/null | grep -q .; then \
		echo "stopping and removing dev OIDC provider containers (volume kept)…"; \
		docker compose --env-file compose.dev.env -f $(OIDC_COMPOSE) down; \
	else \
		echo "dev OIDC provider not running"; \
	fi

oidc-stop: oidc-down

oidc-status:
	@curl -sf -m 3 http://localhost:$(OIDC_PORT)/-/health/ready/ >/dev/null 2>&1 \
		&& echo "dev OIDC provider ok on :$(OIDC_PORT)" \
		|| echo "dev OIDC provider unreachable on :$(OIDC_PORT)"

oidc-logs:
	@if [ ! -f compose.dev.env ]; then cp compose.dev.env.example compose.dev.env; fi; \
	docker compose --env-file compose.dev.env -f $(OIDC_COMPOSE) logs -f --tail=50

# ── quality gates ────────────────────────────────────────────────────────────
test:
	bunx vitest run

check:
	bun run typecheck
	bun run lint
	bun run format:check

format:
	bun run format

build:
	bun run build

start:
	bun run start
