local M = {}

local function decode_uri(uri)
  if not uri or uri == "" then return nil, nil end

  -- LSP clients use both jar:file:///...!/entry and jar:///...!/entry.
  -- The location-list conversion may also leave the !/ suffix on filename.
  uri = uri:gsub("^jar:", ""):gsub("^zipfile:", "")
  local bang = uri:find("!/")
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

  -- Maven/Gradle module cache layout:
  -- <module>/<version>/<hash>/<artifact>.jar
  -- Sources and binaries use different hash directories, so search one
  -- directory deeper than the version directory.
  local hash_dir = vim.fs.dirname(archive)
  local version_dir = vim.fs.dirname(hash_dir)
  if version_dir and version_dir ~= hash_dir then
    local source_name = vim.fs.basename(archive):gsub("%.jar$", "-sources.jar")
    for _, path in ipairs(vim.fn.glob(version_dir .. "/*/" .. source_name, false, true)) do
      add(path)
    end
    for _, path in ipairs(vim.fn.glob(version_dir .. "/*/*-sources.jar", false, true)) do
      add(path)
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

local function extract_source(source_jar, entry)
  if vim.fn.executable("unzip") ~= 1 then
    return nil, "unzip is not available"
  end

  local cache = vim.fn.stdpath("cache") .. "/android-lsp-sources"
  vim.fn.mkdir(cache, "p")
  for _, source_entry in ipairs(source_entry_candidates(entry)) do
    local key = vim.fn.sha256(source_jar .. "!/" .. source_entry)
    local ext = source_entry:match("(%.[%w]+)$") or ".txt"
    local target = cache .. "/" .. key .. ext
    if vim.fn.filereadable(target) == 1 then return target end

    local content = vim.fn.system({ "unzip", "-p", source_jar, source_entry })
    if vim.v.shell_error == 0 then
      vim.fn.writefile(vim.split(content, "\n", { plain = true }), target, "b")
      return target
    end
  end
  return nil, "source entry not found in " .. source_jar .. ": " .. entry
end

local function item_uri(item)
  if not item then return nil end
  if item.uri then return item.uri end
  if item.user_data then
    if item.user_data.uri then return item.user_data.uri end
    if item.user_data.targetUri then return item.user_data.targetUri end
  end
  return item.filename
end

local function set_cursor(item)
  if item and item.lnum and item.lnum > 0 then
    pcall(vim.api.nvim_win_set_cursor, 0, {
      item.lnum,
      math.max((item.col or 1) - 1, 0),
    })
  end
end

--- Open a location-list item, extracting a Gradle source JAR when needed.
--- @return boolean handled
function M.open_item(item)
  local uri = item_uri(item)
  local archive, entry = decode_uri(uri)
  if not archive then return false end

  local sources = source_candidates(archive)
  if #sources == 0 then
    vim.notify(
      "No Gradle source JAR for " .. vim.fs.basename(archive)
        .. "\nDownload the dependency's sources artifact to enable navigation.",
      vim.log.levels.WARN
    )
    return false
  end

  local target, err
  for _, source in ipairs(sources) do
    target, err = extract_source(source, entry)
    if target then break end
  end
  if not target then
    vim.notify("Cannot extract dependency source: " .. (err or entry), vim.log.levels.WARN)
    return false
  end

  vim.cmd("edit " .. vim.fn.fnameescape(target))
  set_cursor(item)
  return true
end

function M.on_list(options)
  local items = options.items or {}
  if #items == 0 then
    vim.notify("LSP returned no definition location", vim.log.levels.INFO)
    return
  end

  -- A definition request normally returns one location. Prefer opening a JAR
  -- source immediately; otherwise preserve Neovim's normal location-list UX.
  for _, item in ipairs(items) do
    local uri = item_uri(item)
    if uri and decode_uri(uri) and M.open_item(item) then
      return
    end
  end

  if #items == 1 and items[1].filename and items[1].filename ~= "" then
    local filename = items[1].filename
    if filename:match("^file:") then
      filename = vim.uri_to_fname(filename)
    elseif filename:match("^%a+://") or filename:find("!/", 1, true) then
      vim.notify("Unsupported LSP definition URI: " .. filename, vim.log.levels.WARN)
      vim.fn.setloclist(0, {}, " ", { items = items })
      vim.cmd("lopen")
      return
    end
    vim.cmd("edit " .. vim.fn.fnameescape(filename))
    set_cursor(items[1])
    return
  end

  vim.fn.setloclist(0, {}, " ", options)
  vim.cmd("lopen")
end

function M.definition(opts)
  opts = vim.tbl_extend("force", opts or {}, { on_list = M.on_list })
  vim.lsp.buf.definition(opts)
end

M._decode_uri = decode_uri
M._source_candidates = source_candidates
M._source_entry_candidates = source_entry_candidates
M._extract_source = extract_source

return M
