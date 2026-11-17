# The Go tools (Nuclei, Gitleaks, OSV-Scanner, Trivy), built from source at fixed versions. Go checks
# every module against its public checksum database, so a tampered or moved release tag fails the
# build (this is how Trivy is installed safely after its release binaries were hijacked in March
# 2026: v0.69.4 and the Docker tags 0.69.5 and 0.69.6 were malicious). Built on the build machine's
# own processor and cross-compiled, so it is fast on an Apple Silicon Mac too.
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS gotools
ARG TARGETOS TARGETARCH \
    NUCLEI_VERSION=v3.11.1 GITLEAKS_VERSION=v8.30.1 OSV_SCANNER_VERSION=v2.7.0 TRIVY_VERSION=v0.76.1 \
    COSIGN_VERSION=v2.6.5 OPENGREP_VERSION=v1.30.0
RUN mkdir -p /tools \
 && for pkg in \
      github.com/projectdiscovery/nuclei/v3/cmd/nuclei@${NUCLEI_VERSION} \
      github.com/zricethezav/gitleaks/v8@${GITLEAKS_VERSION} \
      github.com/google/osv-scanner/v2/cmd/osv-scanner@${OSV_SCANNER_VERSION} \
      github.com/aquasecurity/trivy/cmd/trivy@${TRIVY_VERSION}; do \
      CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go install -trimpath -ldflags="-s -w" "$pkg" || exit 1; \
    done \
 && for b in nuclei gitleaks osv-scanner trivy; do cp "$(find /go/bin -name "$b" -type f | head -n 1)" /tools/; done
# Opengrep is not written in Go: its release binary is downloaded and its signature checked with
# cosign against Opengrep's own GitHub release workflow. If it cannot be verified, it is left out
# and the Opengrep tab shows "not installed" (the image still builds).
RUN CGO_ENABLED=0 go install github.com/sigstore/cosign/v2/cmd/cosign@${COSIGN_VERSION} \
 && case "$TARGETARCH" in amd64) dist=opengrep_manylinux_x86 ;; arm64) dist=opengrep_manylinux_aarch64 ;; *) dist="" ;; esac \
 && url="https://github.com/opengrep/opengrep/releases/download/${OPENGREP_VERSION}/$dist" \
 && if [ -n "$dist" ] \
      && curl -fsSL -o /tmp/opengrep "$url" && curl -fsSL -o /tmp/opengrep.cert "$url.cert" && curl -fsSL -o /tmp/opengrep.sig "$url.sig" \
      && /go/bin/cosign verify-blob --cert /tmp/opengrep.cert --signature /tmp/opengrep.sig \
           --certificate-identity-regexp "https://github.com/opengrep/opengrep.+" \
           --certificate-oidc-issuer https://token.actions.githubusercontent.com /tmp/opengrep; then \
      install -m 755 /tmp/opengrep /tools/opengrep; \
    else echo "Opengrep ${OPENGREP_VERSION} could not be downloaded and verified: it is left out of the image"; fi

# Playwright's image ships Node and the Chromium build that matches playwright@1.63.0.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble
ARG SCHEMATHESIS_VERSION=4.32.7 NEWMAN_VERSION=6.2.3
# git clones repositories for the source code engine. Java runs the W3C HTML checker, and
# testssl.sh (from Ubuntu's own packages) checks HTTPS setups. Lighthouse comes with npm.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates default-jre-headless testssl.sh python3-venv \
 && rm -rf /var/lib/apt/lists/*
COPY --from=gotools /tools/ /usr/local/bin/
# Schemathesis (Python) and Newman (Node) each live in their own folder, away from the app's own
# packages: Newman brings old dependencies of its own, which never load into the app.
RUN python3 -m venv /opt/schemathesis \
 && /opt/schemathesis/bin/pip install --no-cache-dir "schemathesis==${SCHEMATHESIS_VERSION}" \
 && ln -s /opt/schemathesis/bin/st /usr/local/bin/st \
 && npm install -g --prefix /opt/newman --ignore-scripts --no-audit --no-fund "newman@${NEWMAN_VERSION}" \
 && ln -s /opt/newman/bin/newman /usr/local/bin/newman
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
# GLV's own Opengrep rules.
COPY --from=build /app/rules ./rules
RUN mkdir -p /data && chown pwuser /data
USER pwuser
# Nuclei's community checks, downloaded once when the image is built (signed by ProjectDiscovery).
# Rebuild the image to update them. If the download fails, Nuclei shows as "not tested" in reports.
RUN nuclei -update-templates -duc -silent || echo "Nuclei checks were not downloaded"
VOLUME ["/data"]
EXPOSE 4000
CMD ["node", "dist/server.js"]
