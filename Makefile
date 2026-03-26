UPSTREAM ?= https://github.com/openclaw/openclaw.git

# ── Current upstream release tag ──────────────────────────────────
TAG ?= v2026.3.24
# ──────────────────────────────────────────────────────────────────

# ── Patch branches (applied in order on top of TAG) ──────────────
PATCHES = feat/cron-gate feat/require-mention-threads feat/shared-bootstrap
# ──────────────────────────────────────────────────────────────────

.PHONY: install upgrade rebuild

## First-time setup: install deps, build, link globally (run on `custom` branch)
install:
	@git remote get-url upstream >/dev/null 2>&1 || git remote add upstream $(UPSTREAM)
	pnpm install
	pnpm build
	npm link
	@echo "== Done. 'openclaw' now points to this checkout =="
	@which openclaw

## Upgrade to a new upstream release and rebuild custom with all patches
## Usage: make upgrade TAG=v2026.3.14
upgrade:
	git fetch upstream --tags
	git checkout main
	git reset --hard $(TAG)
	@for branch in $(PATCHES); do \
		echo "== Rebasing $$branch onto $(TAG) ==" && \
		git checkout $$branch && \
		git rebase --onto $(TAG) $$(git merge-base HEAD main@{1}) $$branch || \
		{ echo "!! Conflict in $$branch — resolve, then: git rebase --continue"; exit 1; }; \
	done
	git checkout -B custom $(TAG)
	@for branch in $(PATCHES); do \
		echo "== Cherry-picking $$branch ==" && \
		git cherry-pick $(TAG)..$$branch || \
		{ echo "!! Conflict in $$branch — resolve, then: git cherry-pick --continue"; exit 1; }; \
	done
	$(MAKE) rebuild
	@echo "== Done. custom branch rebuilt on $(TAG) with all patches =="
	openclaw --version

## Rebuild only (skip git operations)
rebuild:
	pnpm install
	pnpm build
