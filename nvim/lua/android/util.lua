local M = {}

-- cache per cwd
local sdk_dir_cache = {}
local compile_sdk_cache = {}

--- @return string|nil
function M.find_project_root(startpath)
  startpath = startpath or vim.fn.expand("%:p:h")
  if startpath == "" then startpath = vim.fn.getcwd() end
  -- priority 1: multi-module / repo root markers
  local root_markers = { "settings.gradle.kts", "settings.gradle", "gradlew", ".git" }
  local found = vim.fs.find(root_markers, { upward = true, path = startpath })
  if #found > 0 then return vim.fs.dirname(found[1]) end
  -- fallback: single-module markers (app/build.gradle etc.)
  local fallback = { "build.gradle.kts", "build.gradle", "pom.xml", "build.xml" }
  found = vim.fs.find(fallback, { upward = true, path = startpath })
  if #found > 0 then
    -- for build.gradle.kts inside app/ we want its parent's parent (project root) if sibling settings exists
    local d = vim.fs.dirname(found[1])
    -- if d ends with /app, go one up if parent has settings.gradle
    local parent = vim.fs.dirname(d)
    if d:match("/app$") and (
      vim.fn.filereadable(parent .. "/settings.gradle.kts") == 1 or
      vim.fn.filereadable(parent .. "/settings.gradle") == 1 or
      vim.fn.filereadable(parent .. "/gradlew") == 1
    ) then
      return parent
    end
    return d
  end
  return vim.fn.getcwd()
end

function M.trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end

--- parse local.properties sdk.dir
function M.parse_local_properties(root)
  local fp = root .. "/local.properties"
  local f = io.open(fp, "r")
  if not f then return nil end
  for line in f:lines() do
    line = M.trim(line)
    if line:match("^sdk%.dir%s*=") then
      local v = line:match("^sdk%.dir%s*=%s*(.+)$")
      if v then
        v = M.trim(v):gsub("^\"(.*)\"$", "%1"):gsub("^'(.*)'$", "%1")
        -- expand leading ~ and handle \: escaping on windows->linux? keep simple
        v = v:gsub("\\:", ":"):gsub("\\\\", "\\")
        if v:sub(1,1) == "~" then v = vim.fn.expand(v) end
        f:close()
        return v
      end
    end
  end
  f:close()
  return nil
end

local function normalize_sdk_dir(p)
  if not p then return nil end
  return p:gsub("/+$", "") -- strip trailing slashes
end

--- @return string|nil sdk dir
function M.get_sdk_dir(opts)
  opts = opts or {}
  if vim.g.android_sdk_dir and vim.fn.isdirectory(vim.g.android_sdk_dir) == 1 then
    return normalize_sdk_dir(vim.g.android_sdk_dir)
  end
  -- env
  local env = os.getenv("ANDROID_HOME") or os.getenv("ANDROID_SDK_ROOT") or os.getenv("ANDROID_SDK_HOME")
  if env and vim.fn.isdirectory(env) == 1 then return normalize_sdk_dir(env) end

  -- per-project cache
  local root = opts.root or M.find_project_root(opts.startpath)
  if sdk_dir_cache[root] then return sdk_dir_cache[root] end

  local from_props = M.parse_local_properties(root)
  if from_props and vim.fn.isdirectory(from_props) == 1 then
    from_props = normalize_sdk_dir(from_props)
    sdk_dir_cache[root] = from_props
    return from_props
  end

  -- fallback candidates
  local candidates = {
    vim.fn.expand("~/Android/Sdk"),
    vim.fn.expand("~/Android/sdk"),
    vim.fn.expand("~/Library/Android/sdk"),
    "/opt/android-sdk",
    "/usr/local/android-sdk",
  }
  for _, c in ipairs(candidates) do
    if vim.fn.isdirectory(c) == 1 then
      c = normalize_sdk_dir(c)
      sdk_dir_cache[root] = c
      return c
    end
  end
  return nil
end

--- try to parse compileSdk from app/build.gradle.kts or build.gradle.kts
function M.get_compile_sdk(root)
  root = root or M.find_project_root()
  if compile_sdk_cache[root] then return compile_sdk_cache[root] end

  local candidates = {
    root .. "/app/build.gradle.kts",
    root .. "/app/build.gradle",
    root .. "/build.gradle.kts",
    root .. "/build.gradle",
  }
  for _, fp in ipairs(candidates) do
    local f = io.open(fp, "r")
    if f then
      local content = f:read("*a")
      f:close()
      -- match patterns like:
      -- compileSdk = 36 / compileSdkVersion 36 / compileSdk { version = release(36) } / version = 36
      -- we look for compileSdk.*36 or targetSdk etc. Prefer compileSdk.
      local ver = content:match("compileSdk[^0-9]*release%((%d+)%)")
        or content:match("compileSdk[^0-9]*%{[^}]*version%s*=%s*release%((%d+)%)")
        or content:match("compileSdkVersion%s+([%d]+)")
        or content:match("compileSdk%s*=%s*([%d]+)")
        or content:match("compileSdk%s*%{[^}]*version%s*=%s*([%d]+)")
        or content:match("compileSdk%s*%(%s*(%d+)")
      if ver then
        local minor = content:match("minorApiLevel%s*=%s*([%d]+)")
        if minor then
          local combined = ver .. "." .. minor
          compile_sdk_cache[root] = combined
          return combined
        end
        compile_sdk_cache[root] = ver
        return ver
      end
    end
  end

  -- check gradle/libs.versions.toml for compileSdk?
  local toml = root .. "/gradle/libs.versions.toml"
  local f = io.open(toml, "r")
  if f then
    local c = f:read("*a"); f:close()
    local v = c:match("compileSdk%s*=%s*\"?(%d+)")
    if v then compile_sdk_cache[root] = v; return v end
  end

  return nil
end

--- @return string|nil sources root
function M.get_sources_root(sdk_dir, compile_sdk)
  if not sdk_dir then return nil end
  local base = sdk_dir .. "/sources"
  if vim.fn.isdirectory(base) ~= 1 then return nil end

  local function is_valid_sources(p)
    if vim.fn.isdirectory(p) ~= 1 then return false end
    -- must contain android/ subdir or have more than just .installer (size > 1)
    if vim.fn.isdirectory(p .. "/android") == 1 then return true end
    local entries = vim.fn.glob(p .. "/*", false, true)
    local real = 0
    for _, e in ipairs(entries) do
      if not e:match("%.installer$") and vim.fn.isdirectory(e) == 1 then real = real + 1 end
      if e:match("%.java$") or e:match("%.kt$") then real = real + 1 end
    end
    return real > 1
  end
  local function ver_num(s)
    local v = s:match("android%-(.+)$") or "0"
    local maj, min = v:match("^(%d+)%.?(%d*)$")
    maj = tonumber(maj) or 0
    min = tonumber(min) or 0
    return maj*1000 + min
  end
  local function sort_desc(list)
    table.sort(list, function(a,b) return ver_num(a) > ver_num(b) end)
    return list
  end

  if compile_sdk then
    local exact = base .. "/android-" .. compile_sdk
    if is_valid_sources(exact) then return exact end
    -- try major only and variants: find all with that major prefix, pick highest valid
    local major = compile_sdk:match("^(%d+)")
    if major then
      local candidates = vim.fn.glob(base .. "/android-" .. major .. "*", false, true)
      if #candidates > 0 then
        sort_desc(candidates)
        for _, c in ipairs(candidates) do
          if is_valid_sources(c) then return c end
        end
      end
      local major_path = base .. "/android-" .. major
      if is_valid_sources(major_path) then return major_path end
    end
  end

  -- fallback: pick highest installed version that is valid
  local all = vim.fn.glob(base .. "/android-*", false, true)
  if #all == 0 then return nil end
  sort_desc(all)
  for _, p in ipairs(all) do
    if is_valid_sources(p) then return p end
  end
  -- last resort: return highest even if empty
  return all[1]
end

--- helper: list all res directories for the project (handles flavors)
function M.get_res_dirs(root)
  root = root or M.find_project_root()
  local dirs = {}
  local seen = {}
  local function add(p)
    if not seen[p] and vim.fn.isdirectory(p) == 1 then
      seen[p] = true
      table.insert(dirs, p)
    end
  end
  -- main
  add(root .. "/app/src/main/res")
  -- any src/*/res
  local globs = vim.fn.glob(root .. "/app/src/*/res", false, true)
  for _, g in ipairs(globs) do add(g) end
  -- root res ?
  add(root .. "/res")
  -- library modules
  local mod_globs = vim.fn.glob(root .. "/*/src/main/res", false, true)
  for _, g in ipairs(mod_globs) do add(g) end
  return dirs
end

--- find file by glob patterns, returns first match or list
function M.glob_first(patterns)
  for _, pat in ipairs(patterns) do
    local res = vim.fn.glob(pat, false, true)
    if #res > 0 then return res[1] end
  end
  return nil
end

return M
