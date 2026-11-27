local M = {}

local build_files = { 'build.gradle.kts', 'build.gradle' }

local function start_dir(path)
  path = path or vim.api.nvim_buf_get_name(0)
  if path == '' then return vim.uv.cwd() end
  path = vim.fs.normalize(vim.fn.fnamemodify(path, ':p'))
  return vim.fn.isdirectory(path) == 1 and path or vim.fs.dirname(path)
end

function M.find_project_root(startpath)
  local dir = start_dir(startpath)
  return vim.fs.root(dir, { 'settings.gradle.kts', 'settings.gradle', 'gradlew' })
    or vim.fs.root(dir, { 'build.gradle.kts', 'build.gradle', 'pom.xml', 'build.xml' })
    or vim.fs.root(dir, '.git')
    or vim.fn.getcwd()
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
        if not v:match("^/") then v = root .. "/" .. v end
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
  -- Per-project configuration is authoritative for Android builds. This avoids
  -- an unrelated ANDROID_HOME shadowing the SDK selected by Gradle.
  local root = opts.root or M.find_project_root(opts.startpath)
  local from_props = M.parse_local_properties(root)
  if from_props and vim.fn.isdirectory(from_props) == 1 then
    return normalize_sdk_dir(from_props)
  end

  for _, name in ipairs({ 'ANDROID_HOME', 'ANDROID_SDK_ROOT' }) do
    local env = vim.env[name]
    if env and vim.fn.isdirectory(env) == 1 then return normalize_sdk_dir(env) end
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
      return normalize_sdk_dir(c)
    end
  end
  return nil
end

local function read(path)
  local f = io.open(path, 'r')
  if not f then return nil end
  local content = f:read('*a')
  f:close()
  return content
end

function M.get_compile_sdk(root, startpath)
  root = root or M.find_project_root(startpath)
  if vim.g.android_compile_sdk then return tostring(vim.g.android_compile_sdk) end

  -- Prefer the current module over app/ and the top-level build script.
  local module = vim.fs.root(start_dir(startpath), build_files)
  if module and module ~= root and not vim.startswith(module, root .. '/') then module = nil end
  for _, dir in ipairs({ module or root .. '/app', root, root .. '/app' }) do
    for _, name in ipairs(build_files) do
      local content = read(dir .. '/' .. name) or ''
      local block = content:match('%f[%w]compileSdk%s*(%b{})') or ''
      local version = block:match('version%s*=%s*release%s*%(%s*(%d+)')
        or block:match('version%s*=%s*(%d+)')
      if version then
        local minor = block:match('minorApiLevel%s*=%s*(%d+)')
        return minor and version .. '.' .. minor or version
      end
      version = content:match('%f[%w]compileSdk%s*=%s*(%d+)')
        or content:match('%f[%w]compileSdk%s*%(%s*(%d+)')
        or content:match('%f[%w]compileSdk%s+(%d+)')
        or content:match('%f[%w]compileSdkVersion[%s(]+(%d+)')
      if version then return version end
    end
  end

  local catalog = read(root .. '/gradle/libs.versions.toml') or ''
  return catalog:match('compileSdk%s*=%s*"?(%d+)')
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
    local exact = base .. '/android-' .. compile_sdk
    if is_valid_sources(exact) then return exact end
    local major = compile_sdk:match('^(%d+)')
    if not major then return nil end
    for _, path in ipairs({ base .. '/android-' .. major, base .. '/android-' .. major .. '.0' }) do
      if is_valid_sources(path) then return path end
    end
    -- Some SDK installations only publish a minor variant for a major API.
    for _, path in ipairs(sort_desc(vim.fn.glob(base .. '/android-' .. major .. '.*', false, true))) do
      if is_valid_sources(path) then return path end
    end
    return nil
  end

  for _, path in ipairs(sort_desc(vim.fn.glob(base .. '/android-*', false, true))) do
    if is_valid_sources(path) then return path end
  end
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
  -- main application module
  add(root .. "/app/src/main/res")
  -- Any source set in the application module.
  local globs = vim.fn.glob(root .. "/app/src/*/res", false, true)
  for _, g in ipairs(globs) do add(g) end
  -- A project may use a non-app Android module or a root res directory.
  add(root .. "/res")
  local mod_globs = vim.fn.glob(root .. "/*/src/main/res", false, true)
  for _, g in ipairs(mod_globs) do add(g) end
  local source_globs = vim.fn.glob(root .. "/*/src/*/res", false, true)
  for _, g in ipairs(source_globs) do add(g) end
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
