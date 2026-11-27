local sdk = require('android.sdk')
local M = {}

local function decode_uri(uri)
  if not uri or uri == "" then return nil, nil end

  -- LSP clients use both jar:file:///...!/entry and jar:///...!/entry.
  -- The location-list conversion may also leave the !/ suffix on filename.
  local zip = vim.startswith(uri, 'zipfile:')
  uri = uri:gsub('^jar:', ''):gsub('^zipfile:', '')
  local bang = uri:find('!/', 1, true) or (zip and uri:find('::', 1, true))
  if not bang then return nil, nil end

  local archive_uri = uri:sub(1, bang - 1)
  local entry = uri:sub(bang + 2)
  local archive
  local file_uri = archive_uri:match("^file:") ~= nil
  if file_uri then
    local ok, value = pcall(vim.uri_to_fname, archive_uri)
    archive = ok and value or nil
  else
    archive = archive_uri:gsub("^//", "")
    archive = archive and vim.uri_decode(archive) or nil
  end
  if not archive or archive == "" or entry == "" then return nil, nil end
  -- vim.uri_to_fname already decoded file URIs; only decode the entry here.
  return archive, vim.uri_decode(entry)
end

local aar_coordinates = {}

-- Compose/KMP often publishes a versionless AAR filename such as
-- material3-release.aar. Match the original classes.jar byte-for-byte before
-- using its Maven coordinates; the cache may contain several versions.
local function release_aar_coordinates(archive, modules, artifact)
  if aar_coordinates[archive] then return aar_coordinates[archive] end
  local module = artifact:match('^([%w_.+-]+)%-release$')
  if not module or vim.fn.executable('unzip') ~= 1 then return nil end
  local jar = io.open(archive, 'rb')
  if not jar then return nil end
  local bytes = jar:read('*a')
  jar:close()
  local match
  for _, name in ipairs({ module .. '-android', module }) do
    for _, aar in ipairs(vim.fn.glob(modules .. '/*/' .. name .. '/*/*/' .. artifact .. '.aar', false, true)) do
      local result = vim.system({ 'unzip', '-p', aar, 'classes.jar' }):wait()
      if result.code == 0 and result.stdout == bytes then
        local version_dir = vim.fs.dirname(vim.fs.dirname(aar))
        if match and match ~= version_dir then return nil end
        match = version_dir
      end
    end
  end
  aar_coordinates[archive] = match
  return match
end

local function source_candidates(archive)
  local candidates = {}
  local function add(path)
    if path and path ~= "" and vim.fn.filereadable(path) == 1 then
      for _, existing in ipairs(candidates) do
        if existing == path then return end
      end
      table.insert(candidates, path)
    end
  end

  if archive:match("%-sources%.jar$") then add(archive) end
  if archive:match("%.jar$") then
    add(archive:gsub("%.jar$", "-sources.jar"))
  end

  -- Gradle puts Android AAR bytecode in a transformed classes.jar, away
  -- from the corresponding sources artifact in modules-2. Use the artifact
  -- and version in the transform output, not the Gradle version or hash.
  local gradle_home, artifact = archive:match('^(.*)/caches/.-/transformed/([^/]+)/jars/classes%.jar$')
  if artifact then
    artifact = artifact:gsub('^jetified%-', '')
    local module, version = artifact:match('^(.-)%-(%d.*)$')
    local modules = gradle_home .. '/caches/modules-2/files-2.1'
    if module and artifact:match('^[%w_.+-]+$') then
      local base = modules .. '/*/' .. module .. '/' .. version .. '/*/'
      for _, path in ipairs(vim.fn.glob(base .. artifact .. '-sources.jar', false, true)) do add(path) end
    else
      local version_dir = release_aar_coordinates(archive, modules, artifact)
      if version_dir then
        local name = vim.fs.basename(vim.fs.dirname(version_dir)) .. '-' .. vim.fs.basename(version_dir)
        for _, path in ipairs(vim.fn.glob(version_dir .. '/*/' .. name .. '-sources.jar', false, true)) do add(path) end
      end
    end
  end

  -- Gradle module binaries and sources usually have different hash dirs.
  local module_version = archive:match('^(.*/modules%-2/files%-2%.1/[^/]+/[^/]+/[^/]+)/[^/]+/[^/]+%.jar$')
  if module_version then
    local source_name = vim.fs.basename(archive):gsub('%.jar$', '-sources.jar')
    for _, path in ipairs(vim.fn.glob(module_version .. '/*/' .. source_name, false, true)) do add(path) end
    for _, path in ipairs(vim.fn.glob(module_version .. '/*/*-sources.jar', false, true)) do
      if not path:match('%-samples%-sources%.jar$') then add(path) end
    end
  end
  return candidates
end

local function source_entry_candidates(entry)
  local candidates = { entry }
  if entry:match("%.class$") then
    local stem = entry:gsub("%.class$", "")
    local outer = stem:gsub("%$.*$", "")
    local function add(path)
      for _, existing in ipairs(candidates) do
        if existing == path then return end
      end
      table.insert(candidates, path)
    end
    -- Java/Kotlin source JARs contain source files, while the LSP location
    -- often points at the corresponding bytecode entry in a binary JAR.
    add(outer .. ".kt")
    add(outer .. ".java")
    add(stem .. ".kt")
    add(stem .. ".java")
    if stem:match("Kt$") then
      add(stem:gsub("Kt$", "") .. ".kt")
    end
  end
  return candidates
end

local function read_entry(jar, entry)
  -- unzip interprets archive-entry arguments as patterns even when shell-free.
  local pattern = entry:gsub('[%[%]*?]', { ['['] = '[[]', [']'] = '[]]', ['*'] = '[*]', ['?'] = '[?]' })
  local output = vim.fn.system({ 'unzip', '-p', jar, pattern })
  if vim.v.shell_error == 0 then return vim.split(output, '\n', { plain = true }) end
end

local function extract_source(source_jar, entry, symbol)
  if vim.fn.executable('unzip') ~= 1 then return nil end
  local cache = vim.fn.stdpath('cache') .. '/android-lsp-sources'

  local function save(path, lines)
    local directory = cache .. '/' .. vim.fn.sha256(source_jar .. '!/' .. path)
    local target = directory .. '/' .. vim.fs.basename(path)
    if vim.fn.filereadable(target) == 1 then return target end
    lines = lines or read_entry(source_jar, path)
    if not lines then return nil end
    vim.fn.mkdir(directory, 'p')
    vim.fn.writefile(lines, target, 'b')
    return target
  end

  local exact = source_entry_candidates(entry)
  local direct_fallback
  for _, path in ipairs(exact) do
    if path:match('%.java$') or path:match('%.kt$') then
      local source = save(path)
      if source then
        if not symbol or not entry:match('%.class$') or not path:match('%.kt$')
          or sdk.declaration_line(source, symbol) then return source end
        direct_fallback = direct_fallback or source
      end
    end
  end

  -- Kotlin JVM class entries do not reflect the layout of source JARs.
  -- Match the same relative path under commonMain/, jvmMain/, etc. For
  -- a multifile facade (e.g. StringsKt) the declaration may even live in
  -- a differently named file, so look for the symbol in that package.
  local package = entry:match('^(.*)/[^/]+$')
  if not package or not entry:match('%.class$') then return nil end
  local output = vim.fn.system({ 'unzip', '-Z1', source_jar })
  if vim.v.shell_error ~= 0 then return nil end

  local kotlin_files, named_source = {}, nil
  local package_name = package:gsub('/', '.')
  for path in output:gmatch('[^\r\n]+') do
    if path:match('%.kt$') or path:match('%.java$') then
      for _, match in ipairs(exact) do
        if vim.endswith(path, '/' .. match) then
          named_source = named_source or path
          kotlin_files[#kotlin_files + 1] = path
          break
        end
      end
      if path:match('%.kt$') and path ~= kotlin_files[#kotlin_files]
        and (path:find(package .. '/', 1, true) or path:find('/generated/', 1, true)) then
        kotlin_files[#kotlin_files + 1] = path
      end
    end
  end

  if symbol then
    -- Prefer the class's corresponding file before searching other files.
    local ordered = named_source and { named_source } or {}
    for _, path in ipairs(kotlin_files) do
      if path ~= named_source then ordered[#ordered + 1] = path end
    end
    for _, path in ipairs(ordered) do
      local lines = read_entry(source_jar, path)
      if lines and sdk.declaration_line(lines, symbol) then
        for _, line in ipairs(lines) do
          local declared_package = line:match('^%s*package%s+([%w_.]+)')
          if declared_package then
            if declared_package == package_name then return save(path, lines) end
            break
          end
        end
      end
    end
  end
  return direct_fallback or (named_source and save(named_source))
end

local function file_location(path, range, symbol)
  if not range then
    local pos = { line = (sdk.declaration_line(path, symbol) or 1) - 1, character = 0 }
    range = { start = pos, ['end'] = pos }
  end
  return { uri = vim.uri_from_fname(path), range = range }
end

local function resolve(location, symbol)
  local uri = location.uri or location.targetUri
  local range = location.range or location.targetSelectionRange
  local archive, entry = decode_uri(uri)
  if archive then
    local platform_file = sdk.find_archive_source(archive, entry)
    if platform_file then return file_location(platform_file, nil, symbol) end
    for _, jar in ipairs(source_candidates(archive)) do
      local file = extract_source(jar, entry, symbol)
      if file then
        return file_location(file, jar == archive and not entry:match('%.class$') and range or nil, symbol)
      end
    end
    -- Some servers point to a .java/.kt entry in a JAR not named *-sources.jar.
    if entry:match('%.java$') or entry:match('%.kt$') then
      local file = extract_source(archive, entry)
      if file then return file_location(file, range, symbol) end
    end
    local library = archive:match('/transformed/([^/]+)/jars/classes%.jar$') or vim.fs.basename(archive)
    return nil, '找不到 ' .. library .. ' 的对应版本源码：' .. entry .. '（请确认已下载 sources JAR）'
  end

  local jdt_entry = uri:match('^jdt://contents/android%.jar/([^?]+)')
  if jdt_entry then
    local file = sdk.find_archive_source(nil, vim.uri_decode(jdt_entry))
    if file then return file_location(file, nil, symbol) end
  end
  if vim.startswith(uri, 'file:') then return location end
  return nil, 'Unsupported definition URI: ' .. uri
end

-- Eclipse exposes attached source (or a decompiled view) through this request.
local function show_jdt(client, location, bufnr, active)
  local uri = location.uri or location.targetUri
  local buf = vim.uri_to_bufnr(uri)
  if vim.api.nvim_buf_is_loaded(buf) then
    vim.lsp.util.show_document(location, client.offset_encoding)
    return
  end
  client:request('java/classFileContents', { uri = uri }, function(err, text)
    if not active() then return end
    if err or type(text) ~= 'string' or text == '' then
      vim.notify('jdtls did not return class contents', vim.log.levels.WARN)
      return
    end
    vim.bo[buf].buftype = 'nofile'
    vim.bo[buf].swapfile = false
    vim.fn.bufload(buf)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, '\n', { plain = true }))
    vim.bo[buf].modified = false
    vim.bo[buf].modifiable = false
    vim.bo[buf].filetype = 'java'
    vim.lsp.util.show_document(location, client.offset_encoding)
  end, bufnr)
end

-- Resolve virtual locations before Neovim attempts to read them for its list.
-- Smart gd can fall back to explicit SDK imports when LSP has no usable result.
function M.definition(fallback)
  local method = 'textDocument/definition'
  local bufnr = vim.api.nvim_get_current_buf()
  local win = vim.api.nvim_get_current_win()
  local cursor = vim.api.nvim_win_get_cursor(win)
  local symbol = vim.fn.expand('<cword>')
  local function active()
    return vim.api.nvim_get_current_win() == win and vim.api.nvim_get_current_buf() == bufnr
      and vim.deep_equal(vim.api.nvim_win_get_cursor(win), cursor)
  end
  if #vim.lsp.get_clients({ bufnr = bufnr, method = method }) == 0 then
    if not (fallback and fallback()) then vim.notify('No definition server attached', vim.log.levels.INFO) end
    return
  end
  vim.lsp.buf_request_all(bufnr, method, function(client)
    return vim.lsp.util.make_position_params(win, client.offset_encoding)
  end, function(results)
    if not active() then return end
    local paths, jdt, reason = {}, nil, nil
    for id, response in pairs(results) do
      local client = vim.lsp.get_client_by_id(id)
      if client and response.result and response.result ~= vim.NIL then
        local locations = vim.islist(response.result) and response.result or { response.result }
        for _, location in ipairs(locations) do
          local target, err = resolve(location, symbol)
          local uri = location.uri or location.targetUri
          if target then
            paths[#paths + 1] = { target, client.offset_encoding }
          elseif client.name == 'jdtls' and vim.startswith(uri, 'jdt://') then
            jdt = jdt or { client, location }
          else
            reason = reason or err
          end
        end
      elseif response.err then
        reason = reason or response.err.message
      end
    end
    if #paths == 1 then
      vim.lsp.util.show_document(unpack(paths[1]))
    elseif #paths > 1 then
      local items = {}
      for _, path in ipairs(paths) do
        vim.list_extend(items, vim.lsp.util.locations_to_items({ path[1] }, path[2]))
      end
      vim.fn.setloclist(0, {}, ' ', { title = 'LSP definitions', items = items })
      vim.cmd.lopen()
    elseif fallback and fallback() then
      return
    elseif jdt then
      show_jdt(jdt[1], jdt[2], bufnr, active)
    else
      vim.notify(reason or 'No definition found', vim.log.levels.INFO)
    end
  end)
end

M._decode_uri = decode_uri
M._source_candidates = source_candidates
M._source_entry_candidates = source_entry_candidates
M._extract_source = extract_source

return M
