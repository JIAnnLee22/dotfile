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
    local imp = l:match("^%s*import%s+([%w%.%_%$]+)")
    if imp then
      -- skip alias: import foo as bar
      local simple = imp:match("%.([%w%_]+)$")
      if simple then
        -- handle kotlin extension property imports like androidx.core.view.isVisible -> ignore? still map
        map[simple] = imp
        -- also map without last component if it's function? keep anyway
      end
    end
    -- package line not needed
  end
  return map
end

function M.word_under_cursor()
  -- use expand <cword> and <cWORD> for FQN detection
  local cword = vim.fn.expand("<cword>")
  local cWORD = vim.fn.expand("<cWORD>")
  -- cWORD may contain FQN like android.view.View
  -- prefer cWORD if it contains dots and matches class pattern
  if cWORD:match("^[%w_]+%.[%w%.%_]+$") and #cWORD < 120 then
    -- clean trailing punctuation like , ; ) ( < >
    cWORD = cWORD:gsub("[,;%)%(<>%[%]\"']+$", ""):gsub("^[\"'<%(%)%[]+", "")
    if cWORD:match("%.") then return cWORD end
  end
  return cword
end

function M.line_under_cursor()
  return vim.api.nvim_get_current_line()
end

--- try to resolve simple name to FQN via imports + heuristics
function M.resolve_fqn(word, import_map)
  if not word or word == "" then return nil end
  if word:match("%.") then
    -- already FQN (contains dot), assume it's it
    return word
  end
  if word:match("^[A-Z]") then
    -- Class name: look up imports
    if import_map[word] then
      -- handle case where import is extension property like pkg.isVisible -> not a class
      -- check if last component equals word, if import ends with .word then it's class
      local fqn = import_map[word]
      if fqn:match("%." .. word .. "$") then return fqn end
      -- if it's like android.view.ViewCompat, simple is ViewCompat not View -> not match, try elsewhere
    end
    -- heuristic: try common prefixes by probing filesystem later
    return word -- will probe with prefixes
  else
    -- lowercase word like method/variable -> not a class, return nil
    return nil
  end
end

--- Convert FQN to possible source file paths under sources root
--- e.g. android.view.View -> android/view/View.java
--- also handle inner classes: android.view.View$OnClickListener -> android/view/View.java
function M.fqn_to_rel_paths(fqn)
  local paths = {}
  -- strip inner class suffix
  local base = fqn:gsub("%$.*$", "")
  local rel = base:gsub("%.", "/")
  -- java sources are typically .java, some kotlin files are .kt but framework is java
  table.insert(paths, rel .. ".java")
  table.insert(paths, rel .. ".kt")
  -- handle case where word is simple name without package: View -> we will generate many
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
  if not sdk_sources or not simple_name or simple_name == "" then return nil end
  -- use ripgrep if available
  local cmd = string.format("rg --files-with-matches --glob '*.java' --glob '*.kt' '\\bclass\\s+%s\\b|\\binterface\\s+%s\\b|\\bobject\\s+%s\\b' %s 2>/dev/null | head -n 20",
    vim.fn.shellescape(simple_name), vim.fn.shellescape(simple_name), vim.fn.shellescape(simple_name), vim.fn.shellescape(sdk_sources))
  -- shellescape adds quotes, but we need to handle; simpler build without extra escaping inside pattern
  -- fallback: use vim.fn.system with list
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
  local root = util.find_project_root(opts.startpath)
  local sdk_dir = util.get_sdk_dir({ root = root, startpath = opts.startpath })
  if not sdk_dir then return nil, "SDK not found (set $ANDROID_HOME or sdk.dir in local.properties)" end
  local compile_sdk = util.get_compile_sdk(root)
  local sources = util.get_sources_root(sdk_dir, compile_sdk)
  if not sources then return nil, "SDK sources not found under " .. sdk_dir .. "/sources (install via SDK Manager)" end

  -- word resolution
  if not word or word == "" then word = M.word_under_cursor() end
  if not word or word == "" then return nil, "no word under cursor" end

  -- strip generics and punctuation
  word = word:gsub("<.*$", ""):gsub("%[.*$", ""):gsub("[,;%)%]]+$", "")

  local import_map = M.parse_imports(opts.bufnr or 0)
  local fqn = M.resolve_fqn(word, import_map)

  -- if word was FQN already, try direct path
  if word:match("%.") then
    local rels = M.fqn_to_rel_paths(word)
    for _, rel in ipairs(rels) do
      local f = M.find_file_in_sources(sources, rel)
      if f then return f end
    end
    -- try searching class part
    local simple = word:match("%.([%w_]+)$")
    if simple then
      local hit, cands = M.search_class_in_sources(sources, simple)
      if hit then return hit, nil, cands end
    end
    return nil, "SDK source not found for FQN " .. word .. " (sources=" .. sources .. ")"
  end

  -- word is simple class name
  if fqn and fqn:match("%.") then
    -- resolved via import
    local rels = M.fqn_to_rel_paths(fqn)
    for _, rel in ipairs(rels) do
      local f = M.find_file_in_sources(sources, rel)
      if f then return f end
    end
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

function M.goto_sdk(word)
  local file, err, cands = M.find_sdk_source(word)
  if file then
    if cands and #cands > 1 then
      -- multiple candidates: show selection
      vim.ui.select(cands, { prompt = "Multiple SDK matches, pick one:" }, function(choice)
        if choice then vim.cmd("edit " .. vim.fn.fnameescape(choice)) end
      end)
      -- also open best guess
      vim.notify("multiple matches, opening best guess: " .. file, vim.log.levels.INFO)
      vim.cmd("edit " .. vim.fn.fnameescape(file))
    else
      vim.cmd("edit " .. vim.fn.fnameescape(file))
    end
    return true
  else
    vim.notify(err or "SDK source not found", vim.log.levels.WARN)
    return false
  end
end

--- helper used by xml.lua for tag jumps
function M.get_xml_tag_map() return XML_TAG_MAP end

return M
