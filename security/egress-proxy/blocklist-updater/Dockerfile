FROM alpine:3.21
RUN apk add --no-cache wget tzdata
COPY update-blocklist.sh /usr/local/bin/update-blocklist.sh
COPY entrypoint-updater.sh /entrypoint-updater.sh
RUN chmod +x /usr/local/bin/update-blocklist.sh /entrypoint-updater.sh
ENTRYPOINT ["/entrypoint-updater.sh"]
