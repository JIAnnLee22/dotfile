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
    local arg = string.format('--jvm-arg=%s', a)
    table.insert(args, arg)
  end
  return unpack(args)
end

local function find_java_executable()
  -- 1) vim.g.java_home / JAVA_HOME
  local g_home = vim.g.java_home or os.getenv('JAVA_HOME')
  if g_home and g_home ~= '' then
    local cand = g_home:gsub('/+$', '') .. '/bin/java'
    if vim.fn.executable(cand) == 1 then return cand end
  end
  -- 2) 常见 jvm 安装位按版本降序探测 (需要 >=21)
  local candidates = {
    '/usr/lib/jvm/java-21-openjdk/bin/java',
    '/usr/lib/jvm/java-26-openjdk/bin/java',
    '/usr/lib/jvm/default-runtime/bin/java',
    '/usr/lib/jvm/java-17-openjdk/bin/java',
    '/usr/lib/jvm/java-11-openjdk/bin/java',
  }
  for _, p in ipairs(candidates) do
    if vim.fn.executable(p) == 1 then
      local ver_out = vim.fn.system({ p, '-version' })
      -- java -version 输出到 stderr，system 会合并；检查 >=21
      local major = ver_out:match('\"(%d+)%.') or ver_out:match('\"(%d+)\"') or ver_out:match('version \"(%d+)')
      major = tonumber(major) or 0
      -- Java 9+ 版本号为 9,11,17,21...；8 以前为 1.8
      if major >= 21 then return p end
    end
  end
  -- 3) 回落到 PATH 中的 java，若版本足够则用，否则仍返回它让 jdtls 报错提示
  local path_java = vim.fn.exepath('java')
  if path_java ~= '' then return path_java end
  return 'java'
end

local root_markers1 = {
  'mvnw',
  'gradlew',
  'settings.gradle',
  'settings.gradle.kts',
  '.git',
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
      data_dir = data_dir .. '/' .. vim.fn.fnamemodify(config.root_dir, ':p:h:t')
    end
    local java_exec = find_java_executable()
    local config_cmd = {
      'jdtls',
      '--java-executable', java_exec,
      '-data', data_dir,
      get_jdtls_jvm_args(),
    }
    return vim.lsp.rpc.start(config_cmd, dispatchers, {
      cwd = config.cmd_cwd,
      env = config.cmd_env,
      detached = config.detached,
    })
  end,
  filetypes = { 'java' },
  root_markers = vim.fn.has('nvim-0.11.3') == 1 and { root_markers1, root_markers2 }
    or vim.list_extend(root_markers1, root_markers2),
  init_options = {},
}
