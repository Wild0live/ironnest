FROM python:3.12-slim

# Non-root: the broker holds Wazuh creds; keep its blast radius minimal.
RUN useradd --create-home --uid 10001 broker

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

USER broker
EXPOSE 8000

# Read-only root filesystem friendly; no writable paths needed at runtime.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4).status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
