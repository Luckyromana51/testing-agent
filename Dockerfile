# Nuclei, built from source at a fixed version. Go checks every module against its public checksum
# database, so a tampered download fails the build. Built on the build machine's own processor and
# cross-compiled, so it is fast on an Apple Silicon Mac too.
FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS nuclei
ARG TARGETOS TARGETARCH NUCLEI_VERSION=v3.11.1
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go install -ldflags="-s -w" github.com/projectdiscovery/nuclei/v3/cmd/nuclei@${NUCLEI_VERSION} \
 && cp "$(find /go/bin -name nuclei -type f | head -n 1)" /nuclei

# Playwright's image ships Node and the Chromium build that matches playwright@1.63.0.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble
# git clones repositories for the source code engine. Java runs the W3C HTML checker, and
# testssl.sh (from Ubuntu's own packages) checks HTTPS setups. Lighthouse comes with npm.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates default-jre-headless testssl.sh \
 && rm -rf /var/lib/apt/lists/*
COPY --from=nuclei /nuclei /usr/local/bin/nuclei
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown pwuser /data
USER pwuser
# Nuclei's community checks, downloaded once when the image is built (signed by ProjectDiscovery).
# Rebuild the image to update them. If the download fails, Nuclei shows as "not tested" in reports.
RUN nuclei -update-templates -duc -silent || echo "Nuclei checks were not downloaded"
VOLUME ["/data"]
EXPOSE 4000
CMD ["node", "dist/server.js"]
