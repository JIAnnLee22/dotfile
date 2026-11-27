local util = require("android.util")

local M = {}

-- map R. type -> res folder prefix
local R_TYPE_TO_DIR = {
  layout = "layout",
  string = "values",
  color = "values",
  dimen = "values",
  style = "values",
  attr = "values",
  drawable = "drawable",
  mipmap = "mipmap",
  id = "values", -- ids.xml + layout files; special
  anim = "anim",
  animator = "animator",
  raw = "raw",
  menu = "menu",
  xml = "xml",
  font = "font",
  plurals = "values",
  array = "values",
  bool = "values",
  integer = "values",
}

local R_TYPE_TO_VALUES_FILE = {
  string = "strings.xml",
  color = "colors.xml",
  dimen = "dimens.xml",
  style = "styles.xml",
  attr = "attrs.xml",
  plurals = "strings.xml",
  array = "arrays.xml",
  bool = "bools.xml",
  integer = "integers.xml",
}

--- find resource via res dirs
--- @return string|nil file, string|nil err
function M.find_resource_file(rtype, rname, opts)
  opts = opts or {}
  local root = opts.root or util.find_project_root(opts.startpath)
  local res_dirs = util.get_res_dirs(root)

  if #res_dirs == 0 then return nil, "no res/ dirs found under " .. root end

  rtype = rtype:lower()
  local dir_prefix = R_TYPE_TO_DIR[rtype] or rtype

  -- layout/drawable etc: file is res/<dir>-*/<name>.xml (qualifiers)
  if dir_prefix == "layout" or dir_prefix == "drawable" or dir_prefix == "mipmap" or dir_prefix == "anim" or dir_prefix == "animator" or dir_prefix == "menu" or dir_prefix == "raw" or dir_prefix == "xml" or dir_prefix == "font" then
    for _, rd in ipairs(res_dirs) do
      -- direct: rd/layout/name.xml
      local candidates = vim.fn.glob(rd .. "/" .. dir_prefix .. "*/" .. rname .. ".*", false, true)
      if #candidates > 0 then
        -- prefer exact .xml
        for _, c in ipairs(candidates) do if c:match("%.xml$") then return c end end
        return candidates[1]
      end
      -- also try without qualifier: rd/layout/name.xml
      local exact = rd .. "/" .. dir_prefix .. "/" .. rname .. ".xml"
      if vim.fn.filereadable(exact) == 1 then return exact end
      -- drawable may be png/webp/xml
      local any = rd .. "/" .. dir_prefix .. "/" .. rname .. ".*"
      local any_cands = vim.fn.glob(any, false, true)
      if #any_cands > 0 then return any_cands[1] end
    end
    -- also try wildcard qualified: rd/layout-*/name.xml already handled via glob
    return nil, string.format("resource %s/%s not found in %s", rtype, rname, table.concat(res_dirs, ", "))
  end

  -- IDs may be declared in layout XML or values/ids.xml; handle them
  -- before the generic values branch because R_TYPE_TO_DIR.id is "values".
  if rtype == "id" then
    for _, rd in ipairs(res_dirs) do
      local lay = vim.fn.glob(rd .. "/layout*/*.xml", false, true)
      for _, f in ipairs(lay) do
        local lines = vim.fn.readfile(f)
        for _, line in ipairs(lines) do
          if line:find("@+id/" .. rname, 1, true)
            or line:find("@id/" .. rname, 1, true)
            or line:find('name="' .. rname .. '"', 1, true)
          then
            return f
          end
        end
      end
      local ids = vim.fn.glob(rd .. "/values*/ids.xml", false, true)
      for _, f in ipairs(ids) do
        local content = table.concat(vim.fn.readfile(f), "\n")
        if content:find('name="' .. rname .. '"', 1, true)
          or content:find("name='" .. rname .. "'", 1, true)
        then
          return f
        end
      end
    end
    return nil, "id " .. rname .. " not found"
  end

  -- values types: need to search inside values/*.xml for name entry
  if dir_prefix == "values" then
    local expected = R_TYPE_TO_VALUES_FILE[rtype]
    for _, rd in ipairs(res_dirs) do
      -- first try expected file
      if expected then
        local fp = rd .. "/" .. dir_prefix .. "/" .. expected
        if vim.fn.filereadable(fp) == 1 then
          -- check if contains name
          local content = table.concat(vim.fn.readfile(fp), "\n")
          if content:match('name%s*=%s*"' .. rname .. '"') or content:match("name%s*=%s*'" .. rname .. "'") then
            return fp
          end
        end
        -- also qualifiers: values-*
        local qual = vim.fn.glob(rd .. "/" .. dir_prefix .. "-*/" .. expected, false, true)
        for _, q in ipairs(qual) do
          local c = table.concat(vim.fn.readfile(q), "\n")
          if c:match('name%s*=%s*"' .. rname .. '"') then return q end
        end
      end
      -- fallback: search any values*.xml for name
      local all_values = vim.fn.glob(rd .. "/values*/*.xml", false, true)
      for _, f in ipairs(all_values) do
        -- avoid reading huge files? just grep quickly
        local ok = vim.fn.system({ "rg", "-q", 'name\\s*=\\s*[\"\\' .. rname .. '\"]', f })
        -- if rg not available, fall back to readfile
        if vim.v.shell_error == 0 then return f end
        -- fallback read
        local ok2, lines = pcall(vim.fn.readfile, f)
        if ok2 then
          local joined = table.concat(lines, "\n")
          if joined:find('name="' .. rname .. '"', 1, true) or joined:find("name='" .. rname .. "'", 1, true) then
            return f
          end
        end
      end
    end
    -- last resort: rg across res
    local pattern = 'name\\s*=\\s*[\"\\' .. rname .. '\"]'
    local hit = vim.fn.system({ "rg", "--files-with-matches", pattern, unpack(res_dirs) })
    if vim.v.shell_error == 0 and hit ~= "" then
      local first = vim.split(vim.trim(hit), "\n")[1]
      if first and first ~= "" then return first end
    end
    return nil, string.format("values resource %s/%s not found", rtype, rname)
  end

  return nil, "unsupported type " .. rtype
end

--- open resource file and jump to definition line of name if possible
function M.open_resource(rtype, rname, opts)
  opts = opts or {}
  local file, err = M.find_resource_file(rtype, rname, opts)
  if not file then
    vim.notify(err or ("resource not found: " .. rtype .. "/" .. rname), vim.log.levels.WARN)
    return false
  end
  vim.cmd("edit " .. vim.fn.fnameescape(file))
  -- try to jump to line containing name="rname"
  if rtype ~= "layout" and rtype ~= "drawable" and rtype ~= "mipmap" then
    local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
    for i, l in ipairs(lines) do
      if l:find('name="' .. rname .. '"', 1, true) or l:find("name='" .. rname .. "'", 1, true) then
        vim.api.nvim_win_set_cursor(0, { i, 0 })
        vim.cmd("normal! zz")
        break
      end
    end
  end
  return true
end

--- parse R. references like R.layout.foo or R.string.foo from a line or word
function M.parse_r_reference(text)
  if not text then return nil end
  -- full R. pattern
  local rtype, rname = text:match("R%.([%w_]+)%.([%w_]+)")
  if rtype and rname then return rtype, rname end
  return nil
end

--- parse @resource patterns like @layout/foo, @string/foo, @+id/foo
function M.parse_at_reference(text)
  if not text then return nil end
  -- clean surrounding quotes/brackets
  text = text:gsub("^[\"'<%(%)%[]+", ""):gsub("[\"'>%)%]]+$", "")
  local rtype, rname = text:match("@%+?([%w_]+)/([%w_%.%-]+)")
  if rtype and rname then
    -- strip file extension if present for drawable?
    rname = rname:gsub("%.%w+$", "")
    return rtype, rname
  end
  return nil
end

--- attempt to jump from current cursor position handling both R. and @ forms
--- @return boolean handled
function M.try_jump_resource(opts)
  opts = opts or {}
  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2] + 1
  -- Restrict jumps to the token at the cursor: expressions like
  -- findViewById<View>(R.id.title) share one whitespace-delimited word.
  for first, ref, last in line:gmatch('()(@%+?[%w_]+/[%w_.%-]+)()') do
    if col >= first and col < last then
      local rtype, rname = M.parse_at_reference(ref)
      if rtype and rname then return M.open_resource(rtype, rname, opts) end
    end
  end
  for first, rtype, rname, last in line:gmatch('()%f[%w_]R%.([%w_]+)%.([%w_]+)()') do
    if col >= first and col < last then return M.open_resource(rtype, rname, opts) end
  end
  return false
end

return M
