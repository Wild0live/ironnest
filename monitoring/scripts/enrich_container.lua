local name_cache = {}
local last_refresh = 0
local REFRESH_INTERVAL = 60
local LOOKUP_FILE = "/lookups/container-names.json"

local function refresh_cache()
    local now = os.time()
    if now - last_refresh < REFRESH_INTERVAL then return end
    last_refresh = now
    local f = io.open(LOOKUP_FILE, "r")
    if not f then return end
    local content = f:read("*all")
    f:close()
    local new_cache = {}
    for id, name in string.gmatch(content, '"([a-f0-9]+)"%s*:%s*"([^"]*)"') do
        new_cache[id] = name
    end
    name_cache = new_cache
end

function enrich_container(tag, timestamp, record)
    refresh_cache()
    local full_id = string.match(tag, "containers%.([a-f0-9]+)%.")
    if full_id then
        local short_id = string.sub(full_id, 1, 12)
        record["container_id"] = short_id
        record["container_name"] = name_cache[short_id] or "unknown"
    end
    return 1, timestamp, record
end
