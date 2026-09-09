local sdk = require("android.sdk")
local res = require("android.resources")
local dependency = require("android.dependency")
local util = require("android.util")

local M = {}

-- quick helper: get resource dirs for includes
local function is_xml_file()
  local ft = vim.bo.filetype
  local name = vim.fn.expand("%:p")
  return ft == "xml" or name:match("%.xml$")
end

local function is_kotlin_java()
  local ft = vim.bo.filetype
  return ft == "kotlin" or ft == "java" or ft == "kt"
end

--- handle xml buffer jumps:
--- - @string/@color/@drawable/@layout/@id -> resource file
--- - <Tag -> SDK class (widget) or custom view class
--- - custom view FQN like <com.example.MyView -> file search
--- - tools:context=".MainActivity" -> kotlin file
function M.try_xml_jump()
  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2] + 1
  local cWORD = vim.fn.expand("<cWORD>")
  local cword = vim.fn.expand("<cword>")

  -- 1) resource @ reference (highest priority)
  if res.try_jump_resource() then return true end

  -- 2) tools:context or app:layout etc. handling?
  -- detect FQN in attributes: e.g. ".MainActivity" or "com.foo.Bar"
  -- look for class-like string near cursor
  local fqn_seg = line:match('"%s*([%w%.%$_]+)"') or line:match("'([%w%.%$_]+)'")
  -- more precise: check if cursor inside a quoted string containing a dot or leading dot
  local quoted = nil
  for qs, qe, q in line:gmatch('()"([^"]-)"()') do
    if col >= qs and col <= qe then quoted = q; break end
  end
  if not quoted then
    for qs, qe, q in line:gmatch("()'([^']-)'()") do
      if col >= qs and col <= qe then quoted = q; break end
    end
  end
  if quoted then
    -- leading dot means app package + name
    if quoted:sub(1,1) == "." then
      local root = util.find_project_root()
      -- try to find package from AndroidManifest.xml or build.gradle namespace
      local pkg = nil
      local mf = root .. "/app/src/main/AndroidManifest.xml"
      if vim.fn.filereadable(mf) == 1 then
        local txt = table.concat(vim.fn.readfile(mf), "\n")
        pkg = txt:match('package%s*=%s*"([^"]+)"')
      end
      if not pkg then
        local bg = root .. "/app/build.gradle.kts"
        local f = io.open(bg, "r")
        if f then
          local c = f:read("*a"); f:close()
          pkg = c:match('namespace%s*=%s*"([^"]+)"')
               or c:match("namespace%s*=%s*'([^']+)'")
               or c:match('applicationId%s*=%s*"([^"]+)"')
        end
      end
      if pkg then
        local fqn = pkg .. quoted
        -- try to find file for this class in project
        local rel = fqn:gsub("%.", "/")
        local project_root = util.find_project_root()
        local globs = {
          project_root .. "/app/src/main/java/" .. rel .. ".*",
          project_root .. "/app/src/main/kotlin/" .. rel .. ".*",
          project_root .. "/*/src/main/java/" .. rel .. ".*",
          project_root .. "/*/src/main/kotlin/" .. rel .. ".*",
          project_root .. "/**/" .. rel:match("([^/]+)$") .. ".*",
        }
        for _, pat in ipairs(globs) do
          local hits = vim.fn.glob(pat, false, true)
          if #hits > 0 then
            vim.cmd("edit " .. vim.fn.fnameescape(hits[1]))
            return true
          end
        end
        -- fallback rg for class definition
        local simple = quoted:match("%.([%w_]+)$")
        if simple then
          local out = vim.fn.system({ "rg", "--files-with-matches", "class\\s+" .. simple, util.find_project_root() })
          if vim.v.shell_error == 0 and out ~= "" then
            local f = vim.split(vim.trim(out), "\n")[1]
            vim.cmd("edit " .. vim.fn.fnameescape(f))
            return true
          end
        end
      end
    elseif quoted:match("^[%w_]+%.[%w%.]+$") then
      -- FQN like com.example.Foo or android.view.View
      -- first try SDK, then project
      if sdk.goto_sdk(quoted, { quiet = true }) then return true end
      -- try project file
      local rel = quoted:gsub("%.", "/")
      local proj = util.find_project_root()
      local project_paths = {
        proj .. "/app/src/main/java/" .. rel .. ".kt",
        proj .. "/app/src/main/kotlin/" .. rel .. ".kt",
        proj .. "/*/src/main/java/" .. rel .. ".kt",
        proj .. "/*/src/main/kotlin/" .. rel .. ".kt",
      }
      local hits = {}
      for _, pattern in ipairs(project_paths) do
        hits = vim.fn.glob(pattern, false, true)
        if #hits > 0 then break end
      end
      if #hits == 0 then hits = vim.fn.glob(proj .. "/**/" .. quoted:match("[%w_]+$") .. ".kt", false, true) end
      if #hits > 0 then vim.cmd("edit " .. vim.fn.fnameescape(hits[1])); return true end
      local java_paths = {
        proj .. "/app/src/main/java/" .. rel .. ".java",
        proj .. "/app/src/main/kotlin/" .. rel .. ".java",
        proj .. "/*/src/main/java/" .. rel .. ".java",
        proj .. "/*/src/main/kotlin/" .. rel .. ".java",
      }
      for _, pattern in ipairs(java_paths) do
        hits = vim.fn.glob(pattern, false, true)
        if #hits > 0 then break end
      end
      if #hits > 0 then vim.cmd("edit " .. vim.fn.fnameescape(hits[1])); return true end
    end
  end

  -- 3) XML tag -> SDK or custom view
  -- detect tag at cursor: <Tag or </Tag or <com.foo.Bar
  local tag = line:match("<([%w%.%_%$]+)")
  if tag then
    -- check if cursor on tag (between < and >)
    local ts = line:find("<" .. tag, 1, true)
    local te = ts + #tag
    if col >= ts and col <= te + 2 then
      if tag:match("%.") then
        -- custom view FQN: com.example.MyView
        -- First try project; custom views are normally not in platform SDK sources.
        local proj = util.find_project_root()
        local rel = tag:gsub("%.", "/")
        local project_patterns = {
          proj .. "/app/src/main/java/" .. rel .. ".kt",
          proj .. "/app/src/main/kotlin/" .. rel .. ".kt",
          proj .. "/app/src/main/java/" .. rel .. ".java",
          proj .. "/app/src/main/kotlin/" .. rel .. ".java",
          proj .. "/**/" .. tag:match("[%w_]+$") .. ".kt",
        }
        local cand = {}
        for _, pattern in ipairs(project_patterns) do
          cand = vim.fn.glob(pattern, false, true)
          if #cand > 0 then break end
        end
        if #cand > 0 then vim.cmd("edit " .. vim.fn.fnameescape(cand[1])); return true end
        -- try sdk (might be androidx)
        local f = sdk.find_sdk_source(tag)
        if f then vim.cmd("edit " .. vim.fn.fnameescape(f)); return true end
        -- rg search anywhere in project
        local simple = tag:match("%.([%w_]+)$")
        local out = vim.fn.system({ "rg", "--files-with-matches", "class\\s+" .. (simple or tag), proj })
        if vim.v.shell_error == 0 and out ~= "" then
          local first = vim.split(vim.trim(out), "\n")[1]
          vim.cmd("edit " .. vim.fn.fnameescape(first))
          return true
        end
      else
        -- simple widget tag: TextView etc.
        local mapped = sdk.get_xml_tag_map()[tag]
        if mapped then
          -- AndroidX/material classes are not in platform SDK sources. Keep
          -- this quiet so an attached LSP can handle the definition instead.
          if sdk.goto_sdk(mapped, { quiet = true }) then return true end
          if sdk.goto_sdk(tag, { quiet = true }) then return true end
        else
          -- try heuristic: android.widget.Tag or android.view.Tag
          for _, prefix in ipairs({ "android.widget", "android.view", "android.webkit" }) do
            local fqn = prefix .. "." .. tag
            local f = sdk.find_sdk_source(fqn)
            if f then vim.cmd("edit " .. vim.fn.fnameescape(f)); return true end
          end
          if sdk.goto_sdk(tag, { quiet = true }) then return true end
        end
      end
    end
  end

  -- 4) include/layout handling: <include layout="@layout/foo"> already handled via @ jump
  return false
end

--- Kotlin/Java buffer handling
function M.try_code_jump()
  -- first try R. / @ resources
  if res.try_jump_resource() then return true end

  local line = vim.api.nvim_get_current_line()
  local col = vim.api.nvim_win_get_cursor(0)[2] + 1
  local cword = vim.fn.expand("<cword>")
  local cWORD = vim.fn.expand("<cWORD>")

  -- handle viewBinding: binding.fooBar -> find view id fooBar in layouts?
  -- pattern: binding.<id>
  local bind_id = line:match("binding%.([%w_]+)")
  if bind_id and cword == bind_id then
    -- convert camelCase to snake_case for id
    local snake = bind_id:gsub("([A-Z])", "_%1"):lower():gsub("^_", "")
    -- try as id
    if res.open_resource("id", snake) then return true end
    -- also try original camel
    if res.open_resource("id", bind_id) then return true end
    -- search layout for id
    local root = util.find_project_root()
    local hits = vim.fn.system({ "rg", "--files-with-matches", bind_id, root .. "/app/src/main/res" })
    if vim.v.shell_error == 0 and hits ~= "" then
      local f = vim.split(vim.trim(hits), "\n")[1]
      vim.cmd("edit " .. vim.fn.fnameescape(f))
      return true
    end
  end

  -- handle findViewById(R.id.xxx) already via R, but also handle string literal referencing layout?
  -- handle Intent / navigation: e.g. R.layout.xxx already covered

  -- handle SDK class jump if nothing else_matched
  -- only attempt if cword looks like a class (Uppercase first)
  if cword:match("^[A-Z][%w_]*$") then
    -- peek import line? try sdk jump but don't fallback to notify loudly; soft attempt
    local file, err = sdk.find_sdk_source(cword)
    if file then
      vim.cmd("edit " .. vim.fn.fnameescape(file))
      return true
    end
  elseif cword:match("^[%w_]+$") and #cword > 2 then
    -- if line contains import and cursor on class, try fqn detection via <cWORD>
    local fqn = cWORD:gsub("[^%w%.%_]+", "")
    if fqn:match("%.") and fqn:match("^[%w%.]+$") then
      if sdk.goto_sdk(fqn, { quiet = true }) then return true end
    end
  end

  return false
end

--- Unified entry: tries xml then code then sdk
function M.jump()
  local ft = vim.bo.filetype
  local name = vim.fn.expand("%:p")

  -- priority 1: resource jump (works in any ft)
  if res.try_jump_resource() then return end

  -- xml-specific
  if ft == "xml" or name:match("%.xml$") then
    if M.try_xml_jump() then return end
    -- still try SDK fallback for a platform tag under the cursor, but keep
    -- misses quiet so AndroidX/custom tags can fall through to LSP.
    local w = sdk.word_under_cursor()
    if w and w:match("^[A-Z]") then
      if sdk.goto_sdk(w, { quiet = true }) then return end
    end
    if #vim.lsp.get_clients({ bufnr = 0 }) > 0 then
      dependency.definition()
    else
      vim.notify("no XML target found at cursor", vim.log.levels.INFO)
    end
    return
  end

  -- kotlin/java
  if ft == "kotlin" or ft == "java" or ft == "kt" then
    if M.try_code_jump() then return end
    -- final fallback: try SDK source under cursor
    local w = sdk.word_under_cursor()
    if w and w ~= "" then
      if sdk.goto_sdk(w, { quiet = true }) then return end
    end
    -- fallback to LSP definition without an extra warning on every ordinary
    -- project symbol or method.
    if #vim.lsp.get_clients({ bufnr = 0 }) > 0 then
      dependency.definition()
    else
      vim.notify("no Android target and no LSP client attached", vim.log.levels.INFO)
    end
    return
  end

  -- other filetypes: try resource then sdk then lsp
  if M.try_code_jump() then return end
  local w = sdk.word_under_cursor()
  if w and sdk.goto_sdk(w, { quiet = true }) then return end
  if vim.lsp.buf then pcall(dependency.definition) end
end

return M
