FROM kalilinux/kali-rolling

ARG KALI_MCP_REF=d46b46bd23f9801b63fc3d16253b5af07b653ec9
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/app/venv/bin:${PATH}"
ENV PYTHONPATH="/app"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    python3-pip \
    python3-venv \
    nmap \
    masscan \
    metasploit-framework \
    netcat-openbsd \
    curl \
    wget \
    dnsutils \
    whois \
    hydra \
    john \
    gobuster \
    dirb \
    nikto \
    sqlmap \
    zaproxy \
    xsstrike \
    testssl.sh \
    amass \
    theharvester \
    ffuf \
    httpx-toolkit \
    subfinder \
    gospider \
    nuclei \
    gvm \
    openvas-scanner \
    lynis \
    yara \
    autopsy \
    golang \
    smbclient \
    enum4linux \
    nfs-common \
    hashid \
    jq \
    file \
    binutils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/volatility3 \
    && /opt/volatility3/bin/pip install --no-cache-dir --upgrade pip volatility3 \
    && ln -sf /opt/volatility3/bin/vol /usr/local/bin/vol \
    && ln -sf /opt/volatility3/bin/vol /usr/local/bin/volatility3

RUN git clone https://github.com/k3nn3dy-ai/kali-mcp.git /app \
    && cd /app \
    && git checkout "${KALI_MCP_REF}" \
    && go install github.com/tomnomnom/waybackurls@latest \
    && cp /root/go/bin/waybackurls /usr/local/bin/ \
    && python3 -m venv /app/venv \
    && /app/venv/bin/pip install --no-cache-dir -r /app/requirements.txt

WORKDIR /work
EXPOSE 8000

CMD ["sh", "-lc", "mkdir -p /work/sessions /reports && ln -sfn /reports /work/reports && exec /app/venv/bin/python -m kali_mcp_server.server --transport sse --port 8000"]
