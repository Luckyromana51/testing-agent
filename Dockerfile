# The Go tools (Nuclei, Gitleaks, OSV-Scanner, Trivy), built from source at fixed versions. Go checks
# every module against its public checksum database, so a tampered or moved release tag fails the
# build (this is how Trivy is installed safely after its release binaries were hijacked in March
# 2026: v0.69.4 and the Docker tags 0.69.5 and 0.69.6 were malicious). Built on the build machine's
# own processor and cross-compiled, so it is fast on an Apple Silicon Mac too.
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS gotools
ARG TARGETOS TARGETARCH \
    NUCLEI_VERSION=v3.11.1 GITLEAKS_VERSION=v8.30.1 OSV_SCANNER_VERSION=v2.7.0 TRIVY_VERSION=v0.76.1 \
    COSIGN_VERSION=v2.6.5 OPENGREP_VERSION=v1.30.0 K6_VERSION=v1.8.2
# k6 (the "k6 load test" tool tab) is built from source the same way: Go checks it against its public
# checksum database. k6 v1.8.2 needs Go 1.26 or newer, which this image has.
# Go's build cache is emptied after each tool and its download cache at the end, so the build needs a
# few GB less free disk at its peak and the finished step keeps only the built programs (otherwise
# Docker keeps several GB of Go caches in its build cache). See "Disk space" in the README.
# retry() reruns a slow or dropped module download a few times before giving up, so a slow connection
# does not fail the build on the first stalled transfer (Go has no --retry flag of its own).
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    mkdir -p /tools \
 && for pkg in \
      github.com/projectdiscovery/nuclei/v3/cmd/nuclei@${NUCLEI_VERSION} \
      github.com/zricethezav/gitleaks/v8@${GITLEAKS_VERSION} \
      github.com/google/osv-scanner/v2/cmd/osv-scanner@${OSV_SCANNER_VERSION} \
      github.com/aquasecurity/trivy/cmd/trivy@${TRIVY_VERSION} \
      go.k6.io/k6@${K6_VERSION}; do \
      retry env CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go install -trimpath -ldflags="-s -w" "$pkg" || exit 1; \
      go clean -cache || exit 1; \
    done \
 && for b in nuclei gitleaks osv-scanner trivy k6; do cp "$(find /go/bin -name "$b" -type f | head -n 1)" /tools/; done \
 && go clean -modcache
# Wave 1 (2026 gap report): subfinder (attack surface: subdomains from public sources), the Interactsh
# client (blind, out-of-band holes) and go-ios (iPhones on USB for the phone farm, no Mac needed).
# Built the same checked way; each is optional, so one that fails to build is left out and its
# feature says "not installed" instead of breaking the image.
ARG SUBFINDER_VERSION=v2.9.0 INTERACTSH_VERSION=v1.2.4 GO_IOS_VERSION=v1.0.182
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    for pkg in \
      github.com/projectdiscovery/subfinder/v2/cmd/subfinder@${SUBFINDER_VERSION} \
      github.com/projectdiscovery/interactsh/cmd/interactsh-client@${INTERACTSH_VERSION} \
      github.com/danielpaulus/go-ios@${GO_IOS_VERSION}; do \
      retry env CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go install -trimpath -ldflags="-s -w" "$pkg" || echo "Left out: $pkg"; \
      go clean -cache; \
    done \
 && for b in subfinder interactsh-client; do f="$(find /go/bin -name "$b" -type f | head -n 1)"; [ -n "$f" ] && cp "$f" /tools/ || true; done \
 && f="$(find /go/bin -name go-ios -type f | head -n 1)"; [ -n "$f" ] && cp "$f" /tools/ios || true; \
    go clean -modcache
# Opengrep is not written in Go: its release binary is downloaded and its signature checked with
# cosign against Opengrep's own GitHub release workflow. If it cannot be verified, it is left out
# and the Opengrep tab shows "not installed" (the image still builds).
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    (retry env CGO_ENABLED=0 go install github.com/sigstore/cosign/v2/cmd/cosign@${COSIGN_VERSION} || echo "cosign could not be built: Opengrep will be left out") \
 && go clean -cache -modcache \
 && case "$TARGETARCH" in amd64) dist=opengrep_manylinux_x86 ;; arm64) dist=opengrep_manylinux_aarch64 ;; *) dist="" ;; esac \
 && url="https://github.com/opengrep/opengrep/releases/download/${OPENGREP_VERSION}/$dist" \
 && if [ -n "$dist" ] \
      && curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 -o /tmp/opengrep "$url" && curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 -o /tmp/opengrep.cert "$url.cert" && curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 -o /tmp/opengrep.sig "$url.sig" \
      && /go/bin/cosign verify-blob --cert /tmp/opengrep.cert --signature /tmp/opengrep.sig \
           --certificate-identity-regexp "https://github.com/opengrep/opengrep.+" \
           --certificate-oidc-issuer https://token.actions.githubusercontent.com /tmp/opengrep; then \
      install -m 755 /tmp/opengrep /tools/opengrep; \
    else echo "Opengrep ${OPENGREP_VERSION} could not be downloaded and verified: it is left out of the image"; fi

# Apache JMeter (the "JMeter test plan" tab) runs the client's .jmx load-test plans. It is plain Java, so
# it is downloaded once on the build machine and checked against the SHA-512 that Apache publishes for
# this release before it is unpacked; a changed or swapped file fails the build. default-jre-headless
# (below) runs it. Load tests only ever run with the client's written permission (see the README).
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm AS jmeter
ARG JMETER_VERSION=5.6.3 \
    JMETER_SHA512=5978a1a35edb5a7d428e270564ff49d2b1b257a65e17a759d259a9283fc17093e522fe46f474a043864aea6910683486340706d745fcdf3db1505fd71e689083
RUN curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 -o /tmp/jmeter.tgz "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz" \
 && echo "${JMETER_SHA512}  /tmp/jmeter.tgz" | sha512sum -c - \
 && tar -xzf /tmp/jmeter.tgz -C /opt \
 && mv "/opt/apache-jmeter-${JMETER_VERSION}" /opt/jmeter \
 && rm -rf /opt/jmeter/docs /opt/jmeter/printable_docs /tmp/jmeter.tgz

# Playwright's image ships Node and the Chromium, Firefox and WebKit builds that match playwright@1.63.0
# (the cross-browser lab opens pages in all three).
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build
WORKDIR /app
# Survive a slow or flaky connection: npm waits longer and retries a dropped download instead of
# failing the whole build (a slow link otherwise times out mid-package). Pins are unchanged.
ENV npm_config_fetch_timeout=300000 npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=300000
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.63.0-noble
ARG SCHEMATHESIS_VERSION=4.32.7 NEWMAN_VERSION=6.2.3 APPIUM_VERSION=3.9.1 UIAUTOMATOR2_VERSION=8.7.3
# Survive a slow or flaky connection (a ~13 kB/s link blew pip's 15s read timeout mid-wheel). pip and
# npm now wait far longer and retry a stalled download instead of aborting the build. These are read
# by every pip/npm step below, so the heavy, optional tools retry rather than fail. Pins are unchanged.
ENV PIP_DEFAULT_TIMEOUT=300 PIP_RETRIES=10 \
    npm_config_fetch_timeout=300000 npm_config_fetch_retries=5 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=300000
# git clones repositories for the source code engine. Java runs the W3C HTML checker, and
# testssl.sh (from Ubuntu's own packages) checks HTTPS setups. Lighthouse comes with npm.
# adb, aapt, apksigner and zipalign (Ubuntu's own packages) let Appium install and drive apps on
# the Android emulator (docker compose --profile android).
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates default-jre-headless testssl.sh python3-venv \
      adb aapt apksigner zipalign \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/android-sdk/platform-tools /opt/android-sdk/build-tools/34.0.0 \
 && ln -s /usr/bin/adb /opt/android-sdk/platform-tools/adb \
 && for b in aapt apksigner zipalign; do ln -s "/usr/bin/$b" "/opt/android-sdk/build-tools/34.0.0/$b"; done
COPY --from=gotools /tools/ /usr/local/bin/
COPY --from=jmeter /opt/jmeter /opt/jmeter
RUN ln -s /opt/jmeter/bin/jmeter /usr/local/bin/jmeter
# Hacked-site checks: YARA (GLV's own rules in rules/yara) and ClamAV, from Ubuntu's own packages.
# ClamAV's signatures are downloaded when the image is built (rebuild to refresh them, or run
# freshclam in the container); without them ClamAV is skipped and YARA still runs.
RUN apt-get update && apt-get install -y --no-install-recommends yara clamav clamav-freshclam \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/lib/clamav && chown -R pwuser /var/lib/clamav \
 && (freshclam --quiet --stdout || echo "ClamAV signatures were not downloaded: ClamAV is skipped until they are")
# veraPDF (PDF/UA checks for the PDF accessibility tool), installed with its own unattended installer.
# Optional: if the download fails it is left out and the tab says so.
RUN mkdir -p /tmp/vera && cd /tmp/vera \
 && if curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 -o vera.zip https://software.verapdf.org/releases/verapdf-installer.zip \
      && python3 -c "import zipfile;zipfile.ZipFile('vera.zip').extractall('.')" \
      && printf '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<AutomatedInstallation langpack="eng">\n<com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>\n<com.izforge.izpack.panels.target.TargetPanel id="install_dir"><installpath>/opt/verapdf</installpath></com.izforge.izpack.panels.target.TargetPanel>\n<com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select"><pack index="0" name="veraPDF GUI" selected="true"/><pack index="1" name="veraPDF Batch files" selected="true"/><pack index="2" name="veraPDF Validation model" selected="false"/><pack index="3" name="veraPDF Documentation" selected="false"/><pack index="4" name="veraPDF Sample Plugins" selected="false"/></com.izforge.izpack.panels.packs.PacksPanel>\n<com.izforge.izpack.panels.install.InstallPanel id="install"/>\n<com.izforge.izpack.panels.finish.FinishPanel id="finish"/>\n</AutomatedInstallation>\n' > auto.xml \
      && java -jar verapdf-*/verapdf-izpack-installer-*.jar auto.xml >/dev/null; then \
      ln -sf /opt/verapdf/verapdf /usr/local/bin/verapdf; \
    else echo "veraPDF was not installed: the PDF/UA tab shows not installed"; fi \
 && rm -rf /tmp/vera
# Schemathesis (Python) and Newman (Node) each live in their own folder, away from the app's own
# packages: Newman brings old dependencies of its own, which never load into the app.
# Best-effort like every other optional tool: a failed/slow download leaves the tool out and its tab
# shows "not installed" (ready() reports it) rather than aborting the whole image build.
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    (python3 -m venv /opt/schemathesis \
      && retry /opt/schemathesis/bin/pip install --no-cache-dir "schemathesis==${SCHEMATHESIS_VERSION}" \
      && ln -s /opt/schemathesis/bin/st /usr/local/bin/st \
      || echo "Schemathesis not installed: the API property/fuzz tab shows not installed") \
 && (retry npm install -g --prefix /opt/newman --ignore-scripts --no-audit --no-fund "newman@${NEWMAN_VERSION}" \
      && ln -s /opt/newman/bin/newman /usr/local/bin/newman \
      || echo "Newman not installed: the Postman-collection tab shows not installed") \
 && npm cache clean --force || true
# Frida (mobile runtime security on a test phone) in its own folder. garak (NVIDIA's open-source LLM
# scanner, for the chatbot red-team tab) is large (it brings PyTorch), so it is added only when the
# image is built with --build-arg WITH_GARAK=1; GLV's own probes run either way.
ARG FRIDA_TOOLS_VERSION=14.4.5 WITH_GARAK=0 GARAK_VERSION=0.13.1
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    python3 -m venv /opt/frida \
 && (retry /opt/frida/bin/pip install --no-cache-dir "frida-tools==${FRIDA_TOOLS_VERSION}" && ln -s /opt/frida/bin/frida /usr/local/bin/frida || echo "Frida was not installed") \
 && if [ "$WITH_GARAK" = "1" ]; then python3 -m venv /opt/garak \
      && (retry /opt/garak/bin/pip install --no-cache-dir "garak==${GARAK_VERSION}" && ln -s /opt/garak/bin/garak /usr/local/bin/garak || echo "garak was not installed"); fi
# Wave 2 (2026 gap report), all optional and best-effort — each tool works from its tab only when it
# installed. Syft: fuller SBOMs. Prowler: cloud account posture (read-only). Prism: richer API mocks.
# GLV's own lockfile reader, CycloneDX output and Node mock server work without any of them.
ARG SYFT_VERSION=1.18.1 PROWLER_VERSION=5.14.0 PRISM_VERSION=5.14.2
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    (curl -sSfL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 30 https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin "v${SYFT_VERSION}" || echo "Syft was not installed: the SBOM tool uses GLV's own reader") \
 && (python3 -m venv /opt/prowler && retry /opt/prowler/bin/pip install --no-cache-dir "prowler==${PROWLER_VERSION}" && ln -s /opt/prowler/bin/prowler /usr/local/bin/prowler || echo "Prowler was not installed: the cloud posture tab shows not installed") \
 && (retry npm install -g --prefix /opt/prism --no-audit --no-fund "@stoplight/prism-cli@${PRISM_VERSION}" && ln -s /opt/prism/bin/prism /usr/local/bin/prism || echo "Prism was not installed: API mocks use GLV's own mock server") \
 && npm cache clean --force || true
# Wave 3 (2026 gap report, P3), all optional and best-effort. ModelScan: deeper model-file scan.
# Checkov: deeper IaC scan. GLV's own model/pickle and IaC rules work without either. kube-bench,
# Kubescape, Dockle and GoAccess run on the CLIENT'S server over SSH when installed there, not here.
ARG MODELSCAN_VERSION=0.8.5 CHECKOV_VERSION=3.2.344 WITH_WAVE3_PY=1
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    if [ "${WITH_WAVE3_PY}" = "1" ]; then \
      (python3 -m venv /opt/modelscan && retry /opt/modelscan/bin/pip install --no-cache-dir "modelscan==${MODELSCAN_VERSION}" && ln -s /opt/modelscan/bin/modelscan /usr/local/bin/modelscan || echo "ModelScan not installed: the model-security tool uses GLV's own pickle-format check"); \
      (python3 -m venv /opt/checkov && retry /opt/checkov/bin/pip install --no-cache-dir "checkov==${CHECKOV_VERSION}" && ln -s /opt/checkov/bin/checkov /usr/local/bin/checkov || echo "Checkov not installed: the IaC tool uses GLV's own rules"); \
    else echo "Wave-3 Python tools skipped (WITH_WAVE3_PY=0)"; fi || true
# Wave 4 (previously-deferred tail). The only in-image dependency is open-source speech for the
# voice-bot tool (Whisper STT + Piper TTS). It is OPT-IN and off by default because Whisper pulls
# PyTorch (large); turn it on with --build-arg WITH_WAVE4_SPEECH=1. The voice-bot tool reports that
# it needs Whisper/Piper until they are present (or WHISPER_PATH/PIPER_PATH are set). Everything else
# in wave 4 is external and free: SearXNG/Ollama, a Windows eval VM + msedgedriver, and the client's
# own FCM/APNs, Google, tracker and LLM keys — nothing to install here.
ARG WHISPER_VERSION=20240930 WITH_WAVE4_SPEECH=0
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    if [ "${WITH_WAVE4_SPEECH}" = "1" ]; then \
      (python3 -m venv /opt/whisper && retry /opt/whisper/bin/pip install --no-cache-dir "openai-whisper==${WHISPER_VERSION}" && ln -s /opt/whisper/bin/whisper /usr/local/bin/whisper || echo "Whisper not installed: the voice-bot tool reports it needs speech-to-text"); \
      (apt-get update && apt-get install -y --no-install-recommends piper || echo "Piper not installed via apt: install a Piper release binary and set PIPER_PATH for the voice-bot tool"); \
      rm -rf /var/lib/apt/lists/*; \
    else echo "Wave-4 speech skipped (WITH_WAVE4_SPEECH=0): the voice-bot tool reports it needs Whisper/Piper until installed"; fi || true
# Appium and its Android driver (UiAutomator2), at fixed versions, in their own folder. They run only
# when the Android emulator profile is used (see docker/start.sh and "Test phones" in the README).
ENV ANDROID_HOME=/opt/android-sdk APPIUM_HOME=/opt/appium-home
RUN retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 4 ] && return 1; echo "retry $n: $*"; sleep 10; done; }; \
    (retry npm install -g --prefix /opt/appium --no-audit --no-fund "appium@${APPIUM_VERSION}" \
      && ln -s /opt/appium/bin/appium /usr/local/bin/appium \
      && retry appium driver install --source=npm "appium-uiautomator2-driver@${UIAUTOMATOR2_VERSION}" \
      || echo "Appium not installed: the Android-emulator profile reports it needs Appium") \
 && npm cache clean --force || true
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
# GLV's own Opengrep rules.
COPY --from=build /app/rules ./rules
# The Mac helper, which the owner downloads from Owner panel > Mac helpers (it runs on a Mac, not here).
COPY --from=build /app/helper ./helper
COPY --from=build /app/docker/start.sh ./start.sh
RUN mkdir -p /data && chown pwuser /data && chown -R pwuser /opt/appium-home
USER pwuser
# Nuclei's community checks, downloaded once when the image is built (signed by ProjectDiscovery).
# Rebuild the image to update them. If the download fails, Nuclei shows as "not tested" in reports.
RUN nuclei -update-templates -duc -silent || echo "Nuclei checks were not downloaded"
VOLUME ["/data"]
EXPOSE 4000
CMD ["./start.sh"]
