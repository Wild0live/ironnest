FROM alpine:3.21
RUN apk add --no-cache wget dcron tzdata
COPY update-blocklist.sh /usr/local/bin/update-blocklist.sh
COPY entrypoint-updater.sh /entrypoint-updater.sh
RUN chmod +x /usr/local/bin/update-blocklist.sh /entrypoint-updater.sh
RUN printf '0 */6 * * * /usr/local/bin/update-blocklist.sh >> /var/log/blocklist-updater.log 2>&1\n' \
    > /etc/crontabs/root
ENTRYPOINT ["/entrypoint-updater.sh"]
