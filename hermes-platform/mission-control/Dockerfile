# Hermes Mission Control — standalone ops dashboard.
# Decoupled from the memory-gateway policy kernel: no secrets, minimal network,
# read-only mounts of the registry + audit log only.
FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app/ /app/app/

# Non-root runtime user; owns only its state dir.
RUN groupadd --system --gid 11002 mc \
 && useradd  --system --uid 11002 --gid 11002 \
        --home-dir /var/lib/mission-control --create-home \
        --shell /usr/sbin/nologin mc \
 && mkdir -p /var/lib/mission-control \
 && chown -R mc:mc /var/lib/mission-control /app

USER mc

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
