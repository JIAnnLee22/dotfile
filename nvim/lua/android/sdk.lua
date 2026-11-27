local util = require("android.util")

local M = {}

-- common android package prefixes for bare class name heuristic
local COMMON_PREFIXES = {
  "android.view",
  "android.widget",
  "android.content",
  "android.app",
  "android.os",
  "android.graphics",
  "android.util",
  "android.database",
  "android.net",
  "android.text",
  "android.provider",
  "android.media",
  "android.hardware",
  "android.webkit",
  "androidx.core",
  "androidx.appcompat",
  "androidx.lifecycle",
  "androidx.activity",
  "androidx.fragment.app",
  "androidx.recyclerview.widget",
  "androidx.compose.runtime",
  "androidx.compose.ui",
  "java.lang",
  "java.util",
  "java.io",
  "kotlin",
  "kotlin.collections",
}

-- xml tag -> FQN for SDK widget jumping
local XML_TAG_MAP = {
  TextView = "android.widget.TextView",
  Button = "android.widget.Button",
  ImageView = "android.widget.ImageView",
  ImageButton = "android.widget.ImageButton",
  EditText = "android.widget.EditText",
  LinearLayout = "android.widget.LinearLayout",
  RelativeLayout = "android.widget.RelativeLayout",
  FrameLayout = "android.widget.FrameLayout",
  ConstraintLayout = "androidx.constraintlayout.widget.ConstraintLayout",
  RecyclerView = "androidx.recyclerview.widget.RecyclerView",
  ScrollView = "android.widget.ScrollView",
  HorizontalScrollView = "android.widget.HorizontalScrollView",
  View = "android.view.View",
  ViewGroup = "android.view.ViewGroup",
  SurfaceView = "android.view.SurfaceView",
  TextureView = "android.view.TextureView",
  ProgressBar = "android.widget.ProgressBar",
  CheckBox = "android.widget.CheckBox",
  RadioButton = "android.widget.RadioButton",
  Switch = "android.widget.Switch",
  SeekBar = "android.widget.SeekBar",
  Spinner = "android.widget.Spinner",
  Toolbar = "androidx.appcompat.widget.Toolbar",
  CardView = "androidx.cardview.widget.CardView",
  FloatingActionButton = "com.google.android.material.floatingactionbutton.FloatingActionButton",
  MaterialButton = "com.google.android.material.button.MaterialButton",
}

-- parse imports in current buffer -> map simple name -> FQN
function M.parse_imports(bufnr)
  bufnr = bufnr or 0
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local map = {}
  for _, l in ipairs(lines) do
    -- Kotlin/Java: import android.view.View / import androidx.core.view.isVisible
    local imp, suffix = l:match('^%s*import%s+([%w_.$]+)(.*)$')
    if imp then
      local simple = suffix:match('^%s+as%s+([%w_]+)') or imp:match('%.([%w_$]+)$')
      if simple then map[simple] = imp end
    end
  end
  return map
end

function M.word_under_cursor()
  local col = vim.api.nvim_win_get_cursor(0)[2] + 1
  for first, word, last in vim.api.nvim_get_current_line():gmatch('()([%w_$][%w_.$]*)()') do
    if col >= first and col < last then
      -- Resolve the prefix through the symbol at the cursor, not its suffix.
      local offset = col - first + 1
      if word:sub(offset, offset) == '.' then return nil end
      local dot = word:find('.', offset, true)
      return dot and word:sub(1, dot - 1) or word
    end
  end
end

function M.line_under_cursor()
  return vim.api.nvim_get_current_line()
end

--- Convert FQN to possible source file paths under sources root
--- e.g. android.view.View -> android/view/View.java
--- also handle inner classes: android.view.View$OnClickListener -> android/view/View.java
function M.fqn_to_rel_paths(fqn)
  local paths = {}
  local base = fqn:gsub('%$.*$', '')
  while base do
    local rel = base:gsub('%.', '/')
    paths[#paths + 1] = rel .. '.java'
    paths[#paths + 1] = rel .. '.kt'
    -- Java source for Outer.Inner is usually in Outer.java.
    base = base:match('^(.*%.[A-Z][%w_]*)%.[A-Z][%w_]*$')
  end
  return paths
end

function M.find_file_in_sources(sdk_sources, rel_path)
  if not sdk_sources then return nil end
  local full = sdk_sources .. "/" .. rel_path
  if vim.fn.filereadable(full) == 1 then return full end
  return nil
end

--- search sources for class definition if FQN probing fails: rg "class <Word>"
--- returns file path if unique, else nil + candidates
function M.search_class_in_sources(sdk_sources, simple_name)
  if not sdk_sources or not simple_name or not simple_name:match('^[A-Z][%w_]*$')
    or vim.fn.executable('rg') ~= 1 then return nil end
  local pattern = string.format("\\b(class|interface|object|enum)\\s+%s\\b", simple_name)
  local out = vim.fn.system({ "rg", "--files-with-matches", "--glob", "*.java", "--glob", "*.kt", pattern, sdk_sources })
  if vim.v.shell_error ~= 0 then return nil end
  local files = vim.split(vim.trim(out), "\n", { plain = true })
  files = vim.tbl_filter(function(s) return s ~= "" end, files)
  if #files == 0 then return nil end
  if #files == 1 then return files[1] end
  -- prefer android/ path shortest? pick the one with exact filename matching simple_name
  for _, f in ipairs(files) do
    if f:match("/" .. simple_name .. "%.java$") or f:match("/" .. simple_name .. "%.kt$") then
      return f
    end
  end
  return files[1], files
end

--- main: try to find SDK source for word under cursor
--- @return string|nil file, string|nil reason, table|nil candidates
function M.find_sdk_source(word, opts)
  opts = opts or {}
  local function resolve_in(sources, fqn)
    for _, rel in ipairs(M.fqn_to_rel_paths(fqn)) do
      local path = M.find_file_in_sources(sources, rel)
      if path then return path end
    end
  end

  word = word or M.word_under_cursor()
  if not word or not word:match('^[%a_][%w_.$]*$') then return nil, 'no SDK symbol at cursor' end

  local owner, tail = word:match('^([%w_$]+)(.*)$')
  local imported = M.parse_imports(opts.bufnr)[owner]
  local fqn = imported and imported .. tail or (tail ~= '' and word or nil)
  if opts.strict and not fqn then return nil, 'no explicit SDK class at cursor' end

  local root = util.find_project_root(opts.startpath)
  local sdk_dir = util.get_sdk_dir({ root = root, startpath = opts.startpath })
  if not sdk_dir then return nil, 'SDK not found (set $ANDROID_HOME or sdk.dir in local.properties)' end
  local compile_sdk = util.get_compile_sdk(root, opts.startpath)
  local sources = util.get_sources_root(sdk_dir, compile_sdk)
  if not sources then
    return nil, 'SDK sources not found for API ' .. (compile_sdk or 'unknown') .. ' under ' .. sdk_dir .. '/sources'
  end

  -- Never guess by simple name when an explicit package/import was supplied.
  if fqn then
    local file = resolve_in(sources, fqn)
    if file then return file end
    return nil, 'SDK source not found for ' .. fqn
  end

  -- try common prefixes heuristic
  for _, prefix in ipairs(COMMON_PREFIXES) do
    local cand = prefix .. "." .. word
    local rels = M.fqn_to_rel_paths(cand)
    for _, rel in ipairs(rels) do
      local f = M.find_file_in_sources(sources, rel)
      if f then return f end
    end
  end

  -- xml tag map
  if XML_TAG_MAP[word] then
    local rels = M.fqn_to_rel_paths(XML_TAG_MAP[word])
    for _, rel in ipairs(rels) do
      local f = M.find_file_in_sources(sources, rel)
      if f then return f end
    end
  end

  -- fallback rg search
  local hit, cands = M.search_class_in_sources(sources, word)
  if hit then return hit, nil, cands end

  return nil, "class " .. word .. " not found in SDK sources (" .. sources .. ")"
end

-- Resolve bytecode in android.jar to the downloaded platform sources. The
-- archive may be the real Nix store target while sources live in the SDK symlink tree.
function M.find_archive_source(archive, entry)
  local sdk_dir, api
  if archive then
    if vim.fs.basename(archive) ~= 'android.jar' then return nil end
    sdk_dir, api = archive:match('^(.*)/platforms/android%-([%d.]+)/android%.jar$')
  end
  local root = util.find_project_root()
  local project_sdk = util.get_sdk_dir({ root = root })
  api = api or util.get_compile_sdk(root)
  local sources = util.get_sources_root(sdk_dir, api) or util.get_sources_root(project_sdk, api)
  local fqn = entry:gsub('%.class$', ''):gsub('%.java$', ''):gsub('/', '.')
  for _, rel in ipairs(M.fqn_to_rel_paths(fqn)) do
    local file = M.find_file_in_sources(sources, rel)
    if file then return file end
  end
end

-- Bytecode positions are not source positions. Without a source range,
-- use the first matching declaration (overloads may share a source file).
function M.declaration_line(file_or_lines, symbol)
  if not symbol or not symbol:match('^[%w_]+$') then return nil end
  local lines = type(file_or_lines) == 'table' and file_or_lines or vim.fn.readfile(file_or_lines)
  local name = '%f[%w_]' .. symbol .. '%f[^%w_]'
  for lnum, line in ipairs(lines) do
    if not line:match('^%s*[/*]') then
      if line:match('%f[%w_]class%s+' .. name) or line:match('%f[%w_]interface%s+' .. name)
        or line:match('%f[%w_]enum%s+' .. name) or line:match('%f[%w_]object%s+' .. name)
        or line:match('%f[%w_]typealias%s+' .. name) then
        return lnum
      end
      if line:match('%f[%w_]fun%s+[^=]*' .. name .. '%s*%(')
        or line:match('%f[%w_]va[lr]%s+[^=]*' .. name .. '%s*[:=]') then
        return lnum
      end
      if line:match('^%s*public%s') or line:match('^%s*protected%s') or line:match('^%s*private%s') then
        local signature = line:match('^[^{=;]*')
        if signature:match(name .. '%s*%(') or line:match(name .. '%s*=') then return lnum end
      end
    end
  end
end

function M.goto_sdk(word, opts)
  opts = opts or {}
  local symbol = word and word:match('[%w_]+$') or vim.fn.expand('<cword>')
  local function open(path)
    vim.cmd("normal! m'")
    vim.cmd.edit(vim.fn.fnameescape(path))
    vim.api.nvim_win_set_cursor(0, { M.declaration_line(path, symbol) or 1, 0 })
  end
  local file, err, cands = M.find_sdk_source(word, opts)
  if file then
    if cands and #cands > 1 then
      -- Multiple candidates require one user choice; do not also open a
      -- speculative best guess before the picker callback runs.
      vim.ui.select(cands, { prompt = "Multiple SDK matches, pick one:" }, function(choice)
        if choice then open(choice) end
      end)
    else
      open(file)
    end
    return true
  end
  if not opts.quiet then
    vim.notify(err or "SDK source not found", vim.log.levels.WARN)
  end
  return false
end

--- helper used by xml.lua for tag jumps
function M.get_xml_tag_map() return XML_TAG_MAP end

return M
