# EZTest: Node 22 + Chrome for Testing (and optionally Firefox) + the eztest CLI.
# Built from this source tree; projects install the same package from npm as @eztech/eztest.
#
#   docker build -t eztest .
#   docker build --build-arg EZTEST_BROWSERS="chromium firefox" -t eztest .   # Firefox too
#   docker run --rm -v "$PWD:/work" eztest run --base-url https://app.example.com
#   docker run --rm -p 8080:8080 -v eztest-data:/data eztest server --host 0.0.0.0 --data-dir /data
#
# Browsers are downloaded by EZTest itself (`eztest install-browsers`: Chrome for
# Testing from Google's storage, Firefox from Mozilla, archives verified) into
# /opt/eztest/browsers. Pin a build with EZTEST_BROWSERS="chromium@141.0.7390.54".
# Behind a TLS-inspecting proxy, pass its CA as a build secret (and the proxy as
# build args HTTPS_PROXY / HTTP_PROXY):
#   docker build --secret id=ca,src=/path/to/ca.crt -t eztest .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=${NODE_IMAGE}

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Electron is a dev dependency (for EZTest's own Electron tests); its binary is not needed to build.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund --ignore-scripts
COPY tsconfig.base.json tsconfig.json tsconfig.build.json tsconfig.client.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build
# Runtime dependencies only, plus the PostgreSQL driver for `eztest server` with Postgres.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm prune --omit=dev --no-audit --no-fund && npm install --no-save --omit=dev --ignore-scripts --no-audit --no-fund pg@8

FROM ${RUNTIME_IMAGE}
LABEL org.opencontainers.image.title="EZTest" \
      org.opencontainers.image.description="Verified test automation: plain-English journeys, EZTest's own browser driver (CDP, WebDriver BiDi), evidence vault, results server"
# Shared libraries Chrome and Firefox need on a slim Debian, plus fonts so pages render text.
# SYSTEM_DEPS=none skips this when the runtime image already has them.
ARG SYSTEM_DEPS=apt
RUN if [ "$SYSTEM_DEPS" = "apt" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates fonts-liberation fonts-noto-color-emoji fontconfig \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 \
        libexpat1 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libudev1 libvulkan1 \
        libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxshmfence1 \
        libgtk-3-0 libdbus-glib-1-2 libxtst6 xz-utils \
      && rm -rf /var/lib/apt/lists/*; \
    fi
# Containers allow no unprivileged user namespaces, so Chromium's own sandbox cannot start as the
# non-root user; the container is the isolation boundary (EZTEST_CHROMIUM_SANDBOX=1 forces it).
ENV NODE_ENV=production \
    EZTEST_BROWSERS_PATH=/opt/eztest/browsers \
    EZTEST_CHROMIUM_SANDBOX=0
WORKDIR /opt/eztest
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY README.md THIRD_PARTY_NOTICES.md ./
COPY docs ./docs
RUN chmod +x dist/cli/bin.js && ln -s /opt/eztest/dist/cli/bin.js /usr/local/bin/eztest
# Browsers: one `eztest install-browsers` per entry (chromium, chrome-headless-shell, firefox, firefox-esr; @version pins).
ARG EZTEST_BROWSERS=chromium
# Mirrors and version index for install-browsers (optional).
ARG EZTEST_CFT_DOWNLOAD_BASE
ARG EZTEST_CFT_VERSIONS_URL
ARG EZTEST_FIREFOX_DOWNLOAD_BASE
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    for b in $EZTEST_BROWSERS; do eztest install-browsers "$b" || exit 1; done \
    && chmod -R a+rX /opt/eztest/browsers
RUN useradd --create-home --uid 10001 --user-group eztest && mkdir -p /work /data && chown eztest:eztest /work /data
USER eztest
WORKDIR /work
EXPOSE 8080
ENTRYPOINT ["eztest"]
CMD ["--help"]
