local function get_jdtls_cache_dir()
  return vim.fn.stdpath('cache') .. '/jdtls'
end

local function get_jdtls_workspace_dir()
  return get_jdtls_cache_dir() .. '/workspace'
end

local function get_jdtls_jvm_args()
  local env = os.getenv('JDTLS_JVM_ARGS')
  local args = {}
  for a in string.gmatch((env or ''), '%S+') do
    table.insert(args, string.format('--jvm-arg=%s', a))
  end
  return args
end

local function java_major(java_exec)
  if not java_exec or java_exec == '' or vim.fn.executable(java_exec) ~= 1 then
    return 0
  end
  local output = vim.fn.system({ java_exec, '-version' })
  local major = output:match('version [%\"](%d+)[%.\"]')
    or output:match('[\"](%d+)[%.\"]')
  return tonumber(major) or 0
end

local function find_java_executable()
  -- NixOS exposes the selected JDK through JAVA_HOME and PATH. Do not guess
  -- mutable /usr/lib JVM paths, which are not present on NixOS.
  local homes = { vim.g.java_home, os.getenv('JAVA_HOME') }
  for _, home in ipairs(homes) do
    if home and home ~= '' then
      local candidate = home:gsub('/+$', '') .. '/bin/java'
      if java_major(candidate) >= 21 then return candidate end
    end
  end

  local path_java = vim.fn.exepath('java')
  if java_major(path_java) >= 21 then return path_java end

  -- Let the Nix wrapper choose its own Java 21 runtime when no valid
  -- user-selected executable is available. Do not pass an older JVM.
  return nil
end

local root_markers1 = {
  'mvnw',
  'gradlew',
  'settings.gradle',
  'settings.gradle.kts',
}
local root_markers2 = {
  'build.xml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
}

---@type vim.lsp.Config
return {
  ---@param dispatchers? vim.lsp.rpc.Dispatchers
  ---@param config vim.lsp.ClientConfig
  cmd = function(dispatchers, config)
    local workspace_dir = get_jdtls_workspace_dir()
    local data_dir = workspace_dir
    if config.root_dir then
      -- The basename alone collides for projects with the same parent name;
      -- include a stable hash so each Gradle workspace gets its own metadata.
      local project_name = vim.fn.fnamemodify(config.root_dir, ':p:t')
      local project_id = vim.fn.sha256(config.root_dir):sub(1, 12)
      data_dir = data_dir .. '/' .. project_name .. '-' .. project_id
    end
    local java_exec = find_java_executable()
    local config_cmd = { 'jdtls' }
    if java_exec then
      table.insert(config_cmd, '--java-executable')
      table.insert(config_cmd, java_exec)
    end
    table.insert(config_cmd, '-data')
    table.insert(config_cmd, data_dir)
    vim.list_extend(config_cmd, get_jdtls_jvm_args())
    return vim.lsp.rpc.start(config_cmd, dispatchers, {
      cwd = config.cmd_cwd,
      env = config.cmd_env,
      detached = config.detached,
    })
  end,
  filetypes = { 'java' },
  workspace_required = true,
  root_markers = vim.fn.has('nvim-0.12') == 1 and { root_markers1, root_markers2 }
    or vim.list_extend(root_markers1, root_markers2),
  settings = {
    java = {
      eclipse = { downloadSources = true },
      maven = { downloadSources = true },
      references = { includeDecompiledSources = true },
      import = {
        gradle = { enabled = true },
        maven = { enabled = true },
      },
      configuration = { updateBuildConfiguration = 'automatic' },
    },
  },
  init_options = {
    extendedClientCapabilities = {
      classFileContentsSupport = true,
    },
  },
}
