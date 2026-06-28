# Creating the `broker_ro` read-only indexer user

The broker enforces read-only at the HTTP layer (it only ever issues `_search`),
but the credential it holds should *also* be read-only — defence in depth. Do not
ship the broker with the `admin` superuser password.

This creates an OpenSearch Security internal user `broker_ro` mapped to a
read-only role scoped to the Wazuh alert/monitoring indices.

## 1. Generate a bcrypt hash for the new password

```sh
# inside the indexer container
docker exec -it wazuh.indexer \
  bash -lc 'export OPENSEARCH_JAVA_HOME=/usr/share/wazuh-indexer/jdk; \
    /usr/share/wazuh-indexer/plugins/opensearch-security/tools/hash.sh -p "YOUR_STRONG_PASSWORD"'
# → copy the printed $2y$... hash
```

## 2. Add the user to internal_users.yml

Edit `platform/security/wazuh/config/wazuh_indexer/internal_users.yml` and append:

```yaml
broker_ro:
  hash: "$2y$...PASTE_HASH..."
  reserved: false
  description: "Read-only user for the wazuh-query-broker (agents)"
```

## 3. Define a read-only role + mapping

In `roles.yml` (same config dir; create if managed elsewhere):

```yaml
wazuh_alerts_readonly:
  reserved: false
  cluster_permissions:
    - "cluster_composite_ops_ro"
  index_permissions:
    - index_patterns:
        - "wazuh-alerts-*"
        - "wazuh-monitoring-*"
        - "wazuh-states-*"
      allowed_actions:
        - "read"
        - "indices:data/read/search"
        - "indices:data/read/scroll"
        - "indices:admin/mappings/get"
```

In `roles_mapping.yml`:

```yaml
wazuh_alerts_readonly:
  reserved: false
  users:
    - "broker_ro"
```

## 4. Apply the security config

```sh
docker exec -it wazuh.indexer bash -lc '
  export INSTALLDIR=/usr/share/wazuh-indexer
  export OPENSEARCH_JAVA_HOME=/usr/share/wazuh-indexer/jdk
  bash $INSTALLDIR/plugins/opensearch-security/tools/securityadmin.sh \
    -cd $INSTALLDIR/config/opensearch-security \
    -icl -nhnv \
    -cacert $INSTALLDIR/config/certs/root-ca.pem \
    -cert  $INSTALLDIR/config/certs/admin.pem \
    -key   $INSTALLDIR/config/certs/admin-key.pem'
```

(Adjust cert paths to your stack — the OIDC rollout doc lists where they live.)

## 5. Verify

```sh
# should succeed (read)
curl -sk -u 'broker_ro:YOUR_STRONG_PASSWORD' \
  'https://wazuh.indexer:9200/wazuh-alerts-*/_search?size=0' -o /dev/null -w '%{http_code}\n'
# should FAIL 403 (write attempt)
curl -sk -u 'broker_ro:YOUR_STRONG_PASSWORD' -XPOST \
  'https://wazuh.indexer:9200/wazuh-alerts-test/_doc' -H 'Content-Type: application/json' -d '{}' \
  -o /dev/null -w '%{http_code}\n'
```

Put `broker_ro` + the password into the broker's `.env`
(`WAZUH_BROKER_INDEXER_USER` / `WAZUH_BROKER_INDEXER_PASSWORD`).
