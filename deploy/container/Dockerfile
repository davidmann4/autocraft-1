# syntax=docker/dockerfile:1

# One image for the dashboard, the runner and the one-shot sync and backup
# commands: the first argument picks the process (dashboard | runner | sync |
# backup | any `autocraft` subcommand).
#
# Build from the repository root:  docker build -f deploy/container/Dockerfile -t autocraft .
#
# Bases are Docker Hardened Images for Node 26 on Debian 13. The dev variant is
# the toolchain (bash, apt, npm) and only ever appears in the build stages; the
# production stage is the runtime variant, which ships nothing but Node and has no
# shell to install anything with. That is why everything the process needs is
# assembled in a rootfs by the `tools` stage and copied in as files.
ARG NODE_DEV_IMAGE=dhi.io/node:26-debian-dev@sha256:5101bfdf585a219118dbd5c3ed6554d778e95ff1b9d83aad6da1ebb87f26e3fc
ARG NODE_RUNTIME_IMAGE=dhi.io/node:26@sha256:de8059011a5c409edeb514882b1f7093b8f0610bb3ca582c5470cec9106f6056

# Layer order: every dependency install is keyed on lockfiles only, and the
# source trees (src, web, worker, docs, scripts) are copied after them, so a
# source-only commit reruns nothing but the web bundle and the final copies.

################################################################################
# Build toolchain shared by the web and dependency stages.
FROM ${NODE_DEV_IMAGE} AS node-build
RUN npm install -g pnpm@11.28.10

################################################################################
# The dashboard bundle the server serves from web/dist.
FROM node-build AS web
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
# Install scripts stay off, as in deploy/hook.sh; only esbuild needs its own to place its binary.
# The pnpm store is a cache mount: it persists between builds on one builder
# (a fresh CI runner starts it empty) and stays out of the image.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm-store \
 && pnpm rebuild esbuild
# src/ and docs/ are read by the web build too (shared API types, About page text).
COPY src /app/src
COPY docs /app/docs
COPY web ./
RUN pnpm exec vite build --outDir dist --emptyOutDir

################################################################################
# Runtime tools for the production image. The runtime base has neither a shell nor
# a package manager, so the packages are unpacked here into a rootfs instead:
# every package in the dependency closure is downloaded and extracted, and the
# runtime stage copies the tree as files.
FROM ${NODE_DEV_IMAGE} AS tools
ARG CLAUDE_CODE_VERSION=2.1.309
ARG GH_VERSION=2.100.0
ARG GH_SHA256_AMD64=e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be
ARG GH_SHA256_ARM64=ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961
ARG TARGETARCH

RUN set -eux; \
    apt-get update; \
    # curl and gzip fetch and unpack the GitHub CLI below (a dev base may lack them);
    apt-get install -y --no-install-recommends curl gzip; \
    # Besides the tools themselves, the shell-less base lacks the basics scripts and
    # spawned programs rely on, so they are listed too: dash (/bin/sh, which git runs
    # `!` credential helpers with), coreutils (entrypoint.sh, backup.sh and the periodic
    # loop: mkdir rm ls date stat sleep head tail mktemp dirname cp), findutils (xargs
    # in backup.sh), grep and sed, tar and gzip (src/reference.ts, src/worker/warm.ts),
    # and bsdutils (`script`, src/agents/login.ts).
    packages="bash bsdutils bubblewrap ca-certificates coreutils curl dash findutils git grep gzip sed sqlite3 tar tini zstd"; \
    # Resolve the closure as apt would install it onto an empty system, and fetch
    # it. The empty dpkg status keeps this stage's own installed versions out of the
    # choice: after a repository rebuild they can sort above every version left in
    # the index, and apt would then pick a version it has nowhere to download from.
    # apt picks one provider per dependency and honours Conflicts, and a package it
    # cannot fetch fails the build.
    mkdir -p /rootfs /tmp/apt-empty /tmp/debs/partial; \
    : > /tmp/apt-empty/status; \
    apt-get install -y --download-only --no-install-recommends \
      -o Dir::State::status=/tmp/apt-empty/status -o Dir::Cache::archives=/tmp/debs \
      $packages; \
    cd /tmp/debs; \
    for deb in *.deb; do dpkg -x "$deb" /rootfs; done; \
    rm -rf /var/lib/apt/lists/* /tmp/debs /tmp/apt-empty; \
    # `dpkg -x` runs no postinst, so make sure /bin/sh exists whatever the packages shipped.
    [ -e /rootfs/usr/bin/sh ] || ln -s dash /rootfs/usr/bin/sh; \
    # Prove the unpacked tree runs on its own libraries before it is copied into
    # the runtime base, which has no shell to debug it with later. A plain file
    # stands in for /dev/null so git can open it inside the chroot.
    mkdir -p /rootfs/dev; : > /rootfs/dev/null; \
    chroot /rootfs /bin/bash -c 'set -e; export PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C; \
      git --version; \
      curl --version >/dev/null; \
      sqlite3 --version >/dev/null; \
      bwrap --version; \
      zstd --version >/dev/null; \
      tini --version; \
      script --version >/dev/null; \
      find --version >/dev/null; xargs --version >/dev/null; sed --version >/dev/null; gzip --version >/dev/null'; \
    chroot /rootfs /bin/sh -c 'set -e; export PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C; \
      sh -c true; echo x | cat >/dev/null; echo x | grep x >/dev/null; tar --version >/dev/null; \
      echo x | sha256sum >/dev/null; date >/dev/null; stat / >/dev/null; sleep 0; cp --version >/dev/null'; \
    rm -rf /rootfs/dev; \
    # Volatile mount points and package-manager state do not belong in the layer,
    # and a symlinked /var/lock cannot be merged onto the base image's directory.
    rm -rf /rootfs/var/lock /rootfs/var/run /rootfs/var/cache /rootfs/var/lib/apt \
      /rootfs/run /rootfs/tmp/*

# Certificate bundle, account entries and the writable roots. `dpkg -x` runs no
# postinst scripts, so the CA bundle is copied from this stage rather than
# generated, and the account table is written here because the runtime stage
# cannot run a command.
RUN set -eux; \
    install -D -m 0644 /etc/ssl/certs/ca-certificates.crt /rootfs/etc/ssl/certs/ca-certificates.crt; \
    printf 'root:x:0:0:root:/root:/bin/bash\nautocraft:x:10001:10001:autocraft:/data/home:/bin/bash\n' > /rootfs/etc/passwd; \
    printf 'root:x:0:\nautocraft:x:10001:\n' > /rootfs/etc/group; \
    install -d -o 10001 -g 10001 /rootfs/data /rootfs/data/home /rootfs/data/cache /rootfs/config

# Node CLIs: pnpm for the pipeline's build environments and the Claude CLI, pinned
# like the host install, which updates by hand (DISABLE_AUTOUPDATER). Every package
# these installs fetch is an exact version (pnpm has no dependencies; the Claude CLI's
# platform packages are pinned to its own version), and the registry never replaces
# a published version. The Claude CLI's install script places its platform binary.
RUN npm install -g --prefix /rootfs/usr/local pnpm@11.28.10 @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# GitHub CLI (sync and the pipeline's GitHub calls use it; authenticate with GH_TOKEN), pinned by checksum.
RUN --mount=type=tmpfs,target=/tmp \
    arch="${TARGETARCH:-amd64}" \
 && if [ "$arch" = arm64 ]; then sum="$GH_SHA256_ARM64"; else sum="$GH_SHA256_AMD64"; fi \
 && curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
 && echo "$sum  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /rootfs/usr/local --strip-components=1 --wildcards '*/bin/gh'

################################################################################
# Production dependencies, keyed on the lockfile alone.
FROM node-build AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir /pnpm-store

################################################################################
# Application tree without node_modules: the sources plus the built dashboard.
# The production stage copies it as its own layer, so a source change exports
# and pushes this small layer and reuses the node_modules one.
FROM ${NODE_DEV_IMAGE} AS app
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chmod=0755 deploy/backup.sh deploy/periodic.sh deploy/container/entrypoint.sh ./deploy/
COPY --chmod=0755 deploy/container/ws ./deploy/ws
COPY scripts ./scripts
# Served by the dashboard as the Task Runner helper and its legacy name (src/dash/server/index.ts).
COPY worker ./worker
COPY src ./src
COPY web/src ./web/src
COPY --from=web /app/web/dist ./web/dist
# Shown on the dashboard's prompts page (src/dash/api/prompts.ts); there is no .git in the image.
# The argument is declared here, not at the top of the stage, because every RUN
# after an ARG is keyed on its value, and it changes with every commit.
ARG SOURCE_COMMIT=
RUN if [ -n "$SOURCE_COMMIT" ]; then printf '%s\n' "$SOURCE_COMMIT" > .source-commit; fi

################################################################################
# Production. Nothing is installed here: the shell-less runtime base receives the
# prepared tree as files, so no build tool survives into the image.
FROM ${NODE_RUNTIME_IMAGE}

COPY --from=tools /rootfs/ /
COPY --from=deps --chown=10001:10001 /app/node_modules /app/node_modules
COPY --from=app --chown=10001:10001 /app /app

# Every writable path is under /data (database, caches, job logs, HOME) or /config
# (secrets, accounts, Claude config directories); mount volumes there.
ENV HOME=/data/home \
    XDG_CACHE_HOME=/data/cache \
    DISABLE_AUTOUPDATER=1 \
    AUTOCRAFT_CLAUDE_BIN=/usr/local/bin/claude \
    AUTOCRAFT_DATA_DIR=/data \
    AUTOCRAFT_LISTEN=0.0.0.0:3005 \
    AUTOCRAFT_WORKER_LISTEN=0.0.0.0:8981 \
    AUTOCRAFT_SECRETS_FILE=/config/secrets.json \
    AUTOCRAFT_ACCOUNTS=/config/accounts.json \
    AUTOCRAFT_ACCOUNTS_ROOT=/config/claude \
    AUTOCRAFT_USAGE_DIR=/data/cache/autocraft/usage \
    AUTOCRAFT_LOCK_DIR=/data/cache/autocraft/locks \
    AUTOCRAFT_RUNNER_LOGS=/data/cache/autocraft/jobs \
    AUTOCRAFT_DIFF_CACHE=/data/cache/autocraft/diffs \
    AUTOCRAFT_CHECKOUT_DIR=/data/cache/autocraft/checkouts \
    AUTOCRAFT_FIXUP_DIR=/data/cache/autocraft/fixups \
    AUTOCRAFT_BACKUP_DIR=/data/backups

USER 10001:10001
EXPOSE 3005 8981
VOLUME ["/data", "/config"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
CMD ["dashboard"]
