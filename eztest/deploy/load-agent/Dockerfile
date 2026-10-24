# EZTest Load agent (a load generator) as a slim image: Node 22 and one bundled file.
#
#   node scripts/build-load-agent.mjs                       # -> dist-load-agent/eztest-load-agent.mjs
#   docker build -f deploy/load-agent/Dockerfile -t eztest-load-agent .
#   docker run --rm -e EZTEST_LOAD_CONTROLLER=controller.example:7400 -e EZTEST_LOAD_TOKEN=... \
#              -e EZTEST_LOAD_ZONE=eu-west eztest-load-agent
#
# Protocol-level users (HTTP/1.1, HTTP/2, WebSocket, SSE) need nothing else. For SQL, messaging or
# gRPC users add their driver packages (e.g. EXTRA_PACKAGES="pg@8 amqplib@0.10"); for browser-level
# users use the full EZTest image instead (`docker run eztest load agent ...`), which ships the browsers.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
ARG EXTRA_PACKAGES=""
WORKDIR /opt/eztest
COPY dist-load-agent/eztest-load-agent.mjs ./eztest-load-agent.mjs
COPY dist-load-agent/generator-worker.mjs ./generator-worker.mjs
RUN if [ -n "$EXTRA_PACKAGES" ]; then npm init -y >/dev/null && npm install --no-audit --no-fund $EXTRA_PACKAGES; fi
ENV NODE_ENV=production EZTEST_LOAD_NO_BROWSER=1
USER node
ENTRYPOINT ["node", "/opt/eztest/eztest-load-agent.mjs"]
