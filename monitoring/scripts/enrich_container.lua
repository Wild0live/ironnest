-- Fluent Bit enrichment filter.
-- Adds first-class container metadata fields to each log record by joining
-- the container's short-ID (extracted from the input tag) against the
-- /lookups/containers.tsv map maintained by monitoring-container-sync.
--
-- Fields added when a match is found:
--   container_id, container_name, container_image, compose_project, compose_service
-- Records whose tag has no extractable container ID pass through unchanged.

local cache = {}
local last_refresh = 0
local REFRESH_INTERVAL = 30
local LOOKUP_FILE = "/lookups/containers.tsv"

-- jq's @tsv emits "-" for missing fields (see container-sync.sh), so we
-- never see empty columns and a simple non-empty split is sufficient.
local function split_tabs(line)
    local fields, idx = {}, 1
    for field in string.gmatch(line, "[^\t]+") do
        fields[idx] = field
        idx = idx + 1
    end
    return fields
end

local function refresh_cache()
    local now = os.time()
    if now - last_refresh < REFRESH_INTERVAL then return end
    last_refresh = now
    local f = io.open(LOOKUP_FILE, "r")
    if not f then return end
    local new_cache = {}
    for line in f:lines() do
        local cols = split_tabs(line)
        local id = cols[1]
        if id and #id > 0 then
            new_cache[id] = {
                name            = cols[2],
                image           = cols[3],
                compose_project = cols[4],
                compose_service = cols[5],
            }
        end
    end
    f:close()
    cache = new_cache
end

local function deref(value)
    if value == nil or value == "" or value == "-" then return nil end
    return value
end

function enrich_container(tag, timestamp, record)
    refresh_cache()
    local full_id = string.match(tag, "containers[%./]([a-f0-9]+)[%./]")
    if not full_id then
        return 0, timestamp, record
    end
    local short_id = string.sub(full_id, 1, 12)
    record["container_id"] = short_id
    local meta = cache[short_id]
    if meta then
        record["container_name"]    = deref(meta.name) or "unknown"
        record["container_image"]   = deref(meta.image)
        record["compose_project"]   = deref(meta.compose_project)
        record["compose_service"]   = deref(meta.compose_service)
    else
        record["container_name"] = "unknown"
    end
    return 1, timestamp, record
end
