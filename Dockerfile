# syntax=docker/dockerfile:1
#
# webip -- two-lane web inspection tool.
#
# Base image tag is pinned to the EXACT playwright version in package.json
# (1.62.1). The tag was verified to resolve on MCR before being written here:
#   GET https://mcr.microsoft.com/v2/playwright/manifests/v1.62.1-noble -> 200
# "noble" is Ubuntu 24.04, which matches the dev host. Never use :latest --
# the browser build must be reproducible.
#
# BUILD:
#   docker build -t webip:0.0.0 .
#
# RUN (--shm-size is NOT optional, see below):
#   docker run --rm --init --shm-size=1gb webip:0.0.0
#
# WHY --shm-size=1gb:
#   Docker defaults /dev/shm to 64MB. Chromium maps its renderer surfaces and
#   shared buffers there, and under real crawl load it exhausts 64MB and dies
#   with SIGBUS / "Target crashed" mid-navigation. The browser lane needs at
#   least 1gb. The alternative -- launching with --disable-dev-shm-usage --
#   pushes those buffers onto disk and measurably slows layout work, which is
#   exactly what the browser lane spends its time on. Raise the limit instead.
#
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Pinned + checksum-verified. Keep in sync with scripts/install-lychee.sh and
# versions.json. This layer is amd64-only; for arm64 swap in the
# lychee-aarch64-unknown-linux-gnu asset and its published checksum.
ARG LYCHEE_VERSION=0.24.2
ARG LYCHEE_TARGET=x86_64-unknown-linux-gnu
ARG LYCHEE_SHA256=1f4e0ef7f6554a6ed33dd7ac144fb2e1bbed98598e7af973042fc5cd43951c9a

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
#
# NOTE: NODE_ENV is deliberately NOT set to "production".
# npm treats NODE_ENV=production as --omit=dev and silently skips
# devDependencies -- which would drop tsx, the interpreter `npm run smoke`
# depends on. This bit us once already on the dev host.

# tini  -> a real PID 1 that reaps zombies. Chromium forks aggressively and
#          Playwright kills subprocesses abruptly; without a reaper the
#          container accumulates <defunct> entries until it hits the PID limit.
#          `docker run --init` does the same job; both are wired up here so the
#          image is safe even when the caller forgets the flag.
# openjdk-17-jre-headless -> required by vnu-jar. The Nu validator needs Java
#          17+. Installed in the image only; the host is left untouched.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      openjdk-17-jre-headless \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

# lychee: official prebuilt binary, pinned and checksum-verified.
RUN curl -fsSL -o /tmp/lychee.tar.gz \
      "https://github.com/lycheeverse/lychee/releases/download/lychee-v${LYCHEE_VERSION}/lychee-${LYCHEE_TARGET}.tar.gz" \
 && echo "${LYCHEE_SHA256}  /tmp/lychee.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/lychee.tar.gz -C /tmp \
 && install -m 0755 "/tmp/lychee-${LYCHEE_TARGET}/lychee" /usr/local/bin/lychee \
 && rm -rf /tmp/lychee.tar.gz "/tmp/lychee-${LYCHEE_TARGET}" \
 && lychee --version

WORKDIR /app

# Dependency layer first, so editing source does not invalidate the npm cache.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev && npm cache clean --force

COPY . .

# The smoke test resolves lychee from ./bin by default; point it at the copy
# installed on PATH so the image does not need the gitignored bin/ directory.
ENV WEBIP_LYCHEE_BIN=/usr/local/bin/lychee

# The Playwright base image ships a non-root `pwuser`. Run as it -- Chromium
# should never run as root, and the sandbox is happier unprivileged.
RUN mkdir -p /app/out/evidence && chown -R pwuser:pwuser /app
USER pwuser

# tini as PID 1 for zombie reaping (see note above).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "smoke"]
