FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY app/ /app/app/

# This process must be able to open the Docker Unix socket.  It intentionally
# runs as root, but has no shell endpoint, package manager, or arbitrary-command
# API.  Its HTTP surface is restricted to the three lifecycle operations below.
EXPOSE 8091
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8091"]
